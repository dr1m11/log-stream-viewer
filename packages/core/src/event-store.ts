import { type JsonValue, LOG_LEVELS, type LogEvent, type LogLevel } from '@lsv/protocol';

import type { ColumnBatch } from './column-batch.ts';
import { createStringDictionary, DEFAULT_DICTIONARY_CAPACITY } from './string-dictionary.ts';

type Payload = Readonly<Record<string, JsonValue>>;

/** Read once: a module runner may turn every read of an imported binding into a getter call. */
const LEVELS: readonly LogLevel[] = LOG_LEVELS;

export interface EventStoreOptions {
  /** Hard limit of retained events; appending past it evicts the oldest ones. A positive integer. */
  readonly capacity: number;
  /**
   * Whether to keep `payload` objects. The worker's store keeps them (the details view fetches
   * them on demand); the main thread's store only keeps the `hasPayload` flag.
   */
  readonly keepPayload: boolean;
  /**
   * Distinct services and hosts each dictionary holds before mapping new names to
   * `DICTIONARY_OVERFLOW_ID`. Two stores that exchange column batches must use the same value.
   * Default {@link DEFAULT_DICTIONARY_CAPACITY}.
   */
  readonly dictionaryCapacity?: number;
}

/**
 * A bounded columnar ring buffer of log events (docs/adr/0006).
 *
 * **Positions.** Every appended event gets the next position, starting at 0; positions only grow
 * (until {@link EventStore.clear}). The store retains `[start, end)`: `end` is the position the
 * next event gets, and `size = end - start` never exceeds `capacity`. A position addresses the same
 * event for as long as it is retained, and two stores fed through column batches agree on it.
 *
 * **Eviction.** Appending past `capacity` overwrites the oldest events during the append itself;
 * no reader has to drain the buffer (a background tab pauses `requestAnimationFrame`, and memory
 * must stay bounded anyway).
 *
 * **Row accessors** (`seqAt`, `messageAt`, …) do not check their position, so that rendering
 * visible rows costs a modulo and an array read: call them only for retained positions
 * (`has(position)`, or a `start`/`end` range read in the same task as the rows). For any other
 * position they return whatever the slot holds. {@link EventStore.eventAt} does check.
 */
export interface EventStore {
  readonly capacity: number;
  readonly keepPayload: boolean;
  /** Position of the oldest retained event (inclusive). */
  readonly start: number;
  /** Position the next appended event gets (exclusive end of the retained range). */
  readonly end: number;
  /** Retained events: `end - start`. */
  readonly size: number;
  /** Whether `position` is retained. */
  readonly has: (position: number) => boolean;
  readonly seqAt: (position: number) => number;
  readonly tsAt: (position: number) => number;
  readonly levelAt: (position: number) => LogLevel;
  readonly serviceAt: (position: number) => string;
  readonly hostAt: (position: number) => string;
  readonly messageAt: (position: number) => string;
  readonly traceIdAt: (position: number) => string | undefined;
  /** Whether the event has a payload, also in a store that does not keep payloads. */
  readonly hasPayloadAt: (position: number) => boolean;
  /**
   * The event at `position` as a `LogEvent` (a new object), or `undefined` when the position is
   * not retained. `payload` is present only in a store with `keepPayload` that received the event
   * through {@link EventStore.appendEvents}.
   */
  readonly eventAt: (position: number) => LogEvent | undefined;
  /**
   * Appends parsed events (the worker side). Evicts the oldest events beyond `capacity`. An array
   * with holes (`parseServerMessage` never returns one) throws a `TypeError` after the events
   * before the hole were appended.
   */
  readonly appendEvents: (events: readonly LogEvent[]) => void;
  /**
   * Appends a batch encoded by another store's {@link EventStore.takeColumnBatch} (the main-thread
   * side), so this store retains the same rows at the same positions. Batches must arrive in the
   * order they were taken: a batch that starts before `end` throws a `RangeError`. A batch that
   * starts after `end` means the source evicted the rows in between before they were taken; this
   * store drops everything before the batch as well.
   */
  readonly appendColumns: (batch: ColumnBatch) => void;
  /**
   * Encodes the rows appended since the previous call — only those still retained — together with
   * the dictionary entries added since then, or returns `undefined` when there are no new rows.
   * The batch owns fresh buffers, ready to be transferred (`columnBatchTransferables`).
   */
  readonly takeColumnBatch: () => ColumnBatch | undefined;
  /**
   * Drops every event and dictionary entry and restarts positions at 0 (a new session). A store
   * that receives this store's batches must be cleared at the same time.
   */
  readonly clear: () => void;
}

/** The part of the typed-array API the column copies use; every column type has it. */
interface TypedColumn {
  set(array: ArrayLike<number>, offset?: number): void;
  subarray(begin?: number, end?: number): ArrayLike<number>;
}

// Column reads go through these helpers: slots are always in range, and the fallbacks exist only
// to satisfy `noUncheckedIndexedAccess`.
function numberAt(column: ArrayLike<number>, slot: number): number {
  return column[slot] ?? 0;
}

function stringAt(column: readonly string[], slot: number): string {
  return column[slot] ?? '';
}

function levelName(code: number): LogLevel {
  return LEVELS[code] ?? 'info';
}

export function createEventStore(options: EventStoreOptions): EventStore {
  const { capacity, keepPayload, dictionaryCapacity = DEFAULT_DICTIONARY_CAPACITY } = options;
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError('Event store capacity must be a positive integer');
  }

  // One slot per retained event; position p lives in slot p % capacity. All columns are allocated
  // up front, so appending never allocates (apart from dictionary entries for new names).
  const seq = new Float64Array(capacity);
  const ts = new Float64Array(capacity);
  const level = new Uint8Array(capacity);
  const service = new Uint16Array(capacity);
  const host = new Uint16Array(capacity);
  const hasPayload = new Uint8Array(capacity);
  // Filled, so V8 keeps them as packed arrays rather than holey ones.
  const message = new Array<string>(capacity).fill('');
  const traceId = new Array<string | undefined>(capacity).fill(undefined);
  const payload = new Array<Payload | undefined>(keepPayload ? capacity : 0).fill(undefined);
  const services = createStringDictionary(dictionaryCapacity);
  const hosts = createStringDictionary(dictionaryCapacity);

  let start = 0;
  let end = 0;
  // What takeColumnBatch has already encoded: rows before `taken`, dictionary ids up to these sizes.
  let taken = 0;
  let takenServices = 0;
  let takenHosts = 0;

  const has = (position: number): boolean => position >= start && position < end;

  /** Moves `end` forward by `count` positions and evicts what no longer fits. */
  function advance(count: number): void {
    end += count;
    if (end - start > capacity) start = end - capacity;
  }

  /** Copies `rows` values from `source[from…]` into the ring column starting at `slot`, wrapping. */
  function copyIn(
    target: TypedColumn,
    source: TypedColumn,
    from: number,
    slot: number,
    rows: number,
  ): void {
    const head = Math.min(rows, capacity - slot);
    target.set(source.subarray(from, from + head), slot);
    if (head < rows) target.set(source.subarray(from + head, from + rows), 0);
  }

  /** Copies `rows` values of the ring column starting at `slot`, wrapping, into `target[0…]`. */
  function copyOut(source: TypedColumn, target: TypedColumn, slot: number, rows: number): void {
    const head = Math.min(rows, capacity - slot);
    target.set(source.subarray(slot, slot + head), 0);
    if (head < rows) target.set(source.subarray(0, rows - head), head);
  }

  function appendEvents(events: readonly LogEvent[]): void {
    const total = events.length;
    if (total === 0) return;
    // Of an oversized batch only the newest `capacity` events would survive; skip the others.
    const skip = total > capacity ? total - capacity : 0;
    let slot = (end + skip) % capacity;
    for (let index = skip; index < total; index++) {
      const event = events[index];
      if (event === undefined) {
        // Keep the events before the hole, so positions and slots stay consistent.
        advance(index);
        throw new TypeError('Event arrays must not have holes');
      }
      seq[slot] = event.seq;
      ts[slot] = event.ts;
      level[slot] = LEVELS.indexOf(event.level);
      service[slot] = services.intern(event.service);
      host[slot] = hosts.intern(event.host);
      message[slot] = event.message;
      traceId[slot] = event.traceId;
      hasPayload[slot] = event.payload === undefined ? 0 : 1;
      if (keepPayload) payload[slot] = event.payload;
      slot++;
      if (slot === capacity) slot = 0;
    }
    advance(total);
  }

  function appendColumns(batch: ColumnBatch): void {
    const { firstPosition, count } = batch;
    if (!Number.isInteger(firstPosition) || firstPosition < end) {
      throw new RangeError(
        `Column batch starts at ${String(firstPosition)}, before the store's end ${String(end)}`,
      );
    }
    if (
      batch.seq.length !== count ||
      batch.ts.length !== count ||
      batch.level.length !== count ||
      batch.service.length !== count ||
      batch.host.length !== count ||
      batch.hasPayload.length !== count ||
      batch.message.length !== count ||
      batch.traceId.length !== count
    ) {
      throw new RangeError('Every column of a batch must hold `count` rows');
    }
    for (const name of batch.newServices) services.intern(name);
    for (const name of batch.newHosts) hosts.intern(name);
    if (firstPosition > end) {
      // The source evicted the rows in between before encoding them, and with them all older rows.
      start = firstPosition;
      end = firstPosition;
    }
    const skip = count > capacity ? count - capacity : 0;
    const rows = count - skip;
    const firstSlot = (firstPosition + skip) % capacity;
    copyIn(seq, batch.seq, skip, firstSlot, rows);
    copyIn(ts, batch.ts, skip, firstSlot, rows);
    copyIn(level, batch.level, skip, firstSlot, rows);
    copyIn(service, batch.service, skip, firstSlot, rows);
    copyIn(host, batch.host, skip, firstSlot, rows);
    copyIn(hasPayload, batch.hasPayload, skip, firstSlot, rows);
    let slot = firstSlot;
    for (let index = skip; index < count; index++) {
      message[slot] = stringAt(batch.message, index);
      traceId[slot] = batch.traceId[index];
      // Payloads stay with the source; a store that keeps them must not show a stale one here.
      if (keepPayload) payload[slot] = undefined;
      slot++;
      if (slot === capacity) slot = 0;
    }
    advance(count);
  }

  function takeColumnBatch(): ColumnBatch | undefined {
    const firstPosition = Math.max(taken, start);
    const count = end - firstPosition;
    if (count <= 0) return undefined;
    const firstSlot = firstPosition % capacity;

    const batch = {
      firstPosition,
      count,
      seq: new Float64Array(count),
      ts: new Float64Array(count),
      level: new Uint8Array(count),
      service: new Uint16Array(count),
      host: new Uint16Array(count),
      message: new Array<string>(count),
      traceId: new Array<string | undefined>(count),
      hasPayload: new Uint8Array(count),
      newServices: new Array<string>(services.size - takenServices),
      newHosts: new Array<string>(hosts.size - takenHosts),
    };
    copyOut(seq, batch.seq, firstSlot, count);
    copyOut(ts, batch.ts, firstSlot, count);
    copyOut(level, batch.level, firstSlot, count);
    copyOut(service, batch.service, firstSlot, count);
    copyOut(host, batch.host, firstSlot, count);
    copyOut(hasPayload, batch.hasPayload, firstSlot, count);
    let slot = firstSlot;
    for (let index = 0; index < count; index++) {
      batch.message[index] = stringAt(message, slot);
      batch.traceId[index] = traceId[slot];
      slot++;
      if (slot === capacity) slot = 0;
    }
    // Dictionary ids start at 1 (0 is the overflow id), so entry n has id n.
    for (let index = 0; index < batch.newServices.length; index++) {
      batch.newServices[index] = services.stringOf(takenServices + index + 1);
    }
    for (let index = 0; index < batch.newHosts.length; index++) {
      batch.newHosts[index] = hosts.stringOf(takenHosts + index + 1);
    }

    taken = end;
    takenServices = services.size;
    takenHosts = hosts.size;
    return batch;
  }

  const seqAt = (position: number): number => numberAt(seq, position % capacity);
  const tsAt = (position: number): number => numberAt(ts, position % capacity);
  const levelAt = (position: number): LogLevel => levelName(numberAt(level, position % capacity));
  const serviceAt = (position: number): string =>
    services.stringOf(numberAt(service, position % capacity));
  const hostAt = (position: number): string => hosts.stringOf(numberAt(host, position % capacity));
  const messageAt = (position: number): string => stringAt(message, position % capacity);
  const traceIdAt = (position: number): string | undefined => traceId[position % capacity];
  const hasPayloadAt = (position: number): boolean => hasPayload[position % capacity] === 1;

  function eventAt(position: number): LogEvent | undefined {
    if (!has(position)) return undefined;
    const trace = traceIdAt(position);
    const details = keepPayload ? payload[position % capacity] : undefined;
    return {
      seq: seqAt(position),
      ts: tsAt(position),
      level: levelAt(position),
      service: serviceAt(position),
      host: hostAt(position),
      message: messageAt(position),
      ...(trace !== undefined && { traceId: trace }),
      ...(details !== undefined && { payload: details }),
    };
  }

  function clear(): void {
    start = 0;
    end = 0;
    taken = 0;
    takenServices = 0;
    takenHosts = 0;
    services.clear();
    hosts.clear();
    // Release the strings and payloads; the typed columns are overwritten before they are read.
    message.fill('');
    traceId.fill(undefined);
    payload.fill(undefined);
  }

  return {
    capacity,
    keepPayload,
    get start() {
      return start;
    },
    get end() {
      return end;
    },
    get size() {
      return end - start;
    },
    has,
    seqAt,
    tsAt,
    levelAt,
    serviceAt,
    hostAt,
    messageAt,
    traceIdAt,
    hasPayloadAt,
    eventAt,
    appendEvents,
    appendColumns,
    takeColumnBatch,
    clear,
  };
}
