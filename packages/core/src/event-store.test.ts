import { LOG_LEVELS, type LogEvent } from '@lsv/protocol';
import { describe, expect, it } from 'vitest';

import { type ColumnBatch, columnBatchTransferables } from './column-batch.ts';
import { createEventStore, type EventStore, MAX_COLUMN_BATCH_ROWS } from './event-store.ts';
import { DICTIONARY_OVERFLOW_LABEL } from './string-dictionary.ts';

const SERVICES = ['api-gateway', 'orders', 'payments'] as const;

/** A deterministic event for `seq`: every field varies with it, some events lack optional fields. */
function makeEvent(seq: number): LogEvent {
  const service = SERVICES[seq % SERVICES.length] ?? 'orders';
  return {
    seq,
    ts: 1_791_979_204_000 + seq * 7,
    level: LOG_LEVELS[seq % LOG_LEVELS.length] ?? 'info',
    service,
    host: `${service}-7f9c-${String(seq % 2)}`,
    message: `Request ${String(seq)} completed in ${String(seq % 97)} ms`,
    ...(seq % 3 !== 0 && { traceId: `trace-${String(seq)}` }),
    ...(seq % 2 === 0 && { payload: { latencyMs: seq % 97, http: { status: 200 } } }),
  };
}

/** Events with consecutive `seq` numbers from `first`. */
function makeEvents(first: number, count: number): LogEvent[] {
  return Array.from({ length: count }, (_, index) => makeEvent(first + index));
}

/** The event without its payload: what a store that does not keep payloads returns. */
function withoutPayload(event: LogEvent): LogEvent {
  const { seq, ts, level, service, host, message, traceId } = event;
  return { seq, ts, level, service, host, message, ...(traceId !== undefined && { traceId }) };
}

/** Every retained row read through the column accessors, with its position. */
function rows(store: EventStore) {
  const result = [];
  for (let position = store.start; position < store.end; position++) {
    result.push({
      position,
      seq: store.seqAt(position),
      ts: store.tsAt(position),
      level: store.levelAt(position),
      service: store.serviceAt(position),
      host: store.hostAt(position),
      message: store.messageAt(position),
      traceId: store.traceIdAt(position),
      hasPayload: store.hasPayloadAt(position),
    });
  }
  return result;
}

/** Takes the source's new rows and appends them to the replica, as the worker and the UI do. */
function sync(source: EventStore, replica: EventStore): ColumnBatch | undefined {
  const batch = source.takeColumnBatch();
  if (batch !== undefined) replica.appendColumns(batch);
  return batch;
}

describe('createEventStore', () => {
  it('starts empty', () => {
    const store = createEventStore({ capacity: 4, keepPayload: true });

    expect(store).toMatchObject({ capacity: 4, keepPayload: true, start: 0, end: 0, size: 0 });
    expect(store.has(0)).toBe(false);
    expect(store.eventAt(0)).toBeUndefined();
    expect(store.takeColumnBatch()).toBeUndefined();
  });

  it('appends events at consecutive positions and returns them whole', () => {
    const store = createEventStore({ capacity: 8, keepPayload: true });
    const events = makeEvents(1, 5);

    store.appendEvents(events);
    store.appendEvents([]);

    expect(store).toMatchObject({ start: 0, end: 5, size: 5 });
    expect([0, 1, 2, 3, 4].map((position) => store.eventAt(position))).toEqual(events);
    expect(store.eventAt(5)).toBeUndefined();
    expect(store.eventAt(-1)).toBeUndefined();
  });

  it('reads every column of a row by position', () => {
    const store = createEventStore({ capacity: 8, keepPayload: false });
    store.appendEvents(makeEvents(2, 2));

    expect(rows(store)).toEqual([
      {
        position: 0,
        seq: 2,
        ts: 1_791_979_204_014,
        level: 'info',
        service: 'payments',
        host: 'payments-7f9c-0',
        message: 'Request 2 completed in 2 ms',
        traceId: 'trace-2',
        hasPayload: true,
      },
      {
        position: 1,
        seq: 3,
        ts: 1_791_979_204_021,
        level: 'warn',
        service: 'api-gateway',
        host: 'api-gateway-7f9c-1',
        message: 'Request 3 completed in 3 ms',
        traceId: undefined,
        hasPayload: false,
      },
    ]);
  });

  it('evicts the oldest events when appending past capacity, without any reader', () => {
    const store = createEventStore({ capacity: 4, keepPayload: true });

    store.appendEvents(makeEvents(1, 3));
    store.appendEvents(makeEvents(4, 3));
    store.appendEvents(makeEvents(7, 3));

    expect(store).toMatchObject({ start: 5, end: 9, size: 4 });
    expect(store.has(4)).toBe(false);
    expect(store.eventAt(4)).toBeUndefined();
    // Positions 5..8 wrap around the end of the ring and still read back in order.
    expect([5, 6, 7, 8].map((position) => store.eventAt(position))).toEqual(makeEvents(6, 4));
  });

  it('keeps only the newest events of a batch larger than the capacity', () => {
    const store = createEventStore({ capacity: 4, keepPayload: true });
    store.appendEvents(makeEvents(1, 1));

    store.appendEvents(makeEvents(2, 10));

    expect(store).toMatchObject({ start: 7, end: 11, size: 4 });
    expect([7, 8, 9, 10].map((position) => store.eventAt(position))).toEqual(makeEvents(8, 4));
  });

  it('flags payloads but does not keep them without keepPayload', () => {
    const store = createEventStore({ capacity: 4, keepPayload: false });
    const event = makeEvent(2);

    store.appendEvents([event]);

    expect(store.hasPayloadAt(0)).toBe(true);
    expect(store.eventAt(0)).toEqual(withoutPayload(event));
  });

  it('maps services and hosts beyond the dictionary capacity to the overflow label', () => {
    const store = createEventStore({ capacity: 8, keepPayload: false, dictionaryCapacity: 2 });

    store.appendEvents(makeEvents(1, 3));

    expect([0, 1, 2].map((position) => store.serviceAt(position))).toEqual([
      'orders',
      'payments',
      DICTIONARY_OVERFLOW_LABEL,
    ]);
    // Hosts alternate between two instances, but each service has its own: the third is new.
    expect(store.hostAt(2)).toBe(DICTIONARY_OVERFLOW_LABEL);
    expect(store.eventAt(2)?.service).toBe(DICTIONARY_OVERFLOW_LABEL);
  });

  it('drops everything and restarts positions at 0 on clear', () => {
    const store = createEventStore({ capacity: 4, keepPayload: true });
    store.appendEvents(makeEvents(1, 6));

    store.clear();

    expect(store).toMatchObject({ start: 0, end: 0, size: 0 });
    expect(store.eventAt(0)).toBeUndefined();
    expect(store.takeColumnBatch()).toBeUndefined();

    store.appendEvents(makeEvents(50, 1));
    expect(store.eventAt(0)).toEqual(makeEvent(50));
    expect(store.takeColumnBatch()).toMatchObject({ firstPosition: 0, newServices: ['payments'] });
  });

  it('rejects a capacity that is not a positive integer', () => {
    expect(() => createEventStore({ capacity: 0, keepPayload: false })).toThrow(RangeError);
    expect(() => createEventStore({ capacity: 2.5, keepPayload: false })).toThrow(RangeError);
  });

  it('rejects an event array with holes and keeps the events before the hole', () => {
    const store = createEventStore({ capacity: 4, keepPayload: true });
    const sparse = new Array<LogEvent>(3);
    sparse[0] = makeEvent(1);
    sparse[2] = makeEvent(3);

    expect(() => {
      store.appendEvents(sparse);
    }).toThrow(TypeError);
    expect(store).toMatchObject({ start: 0, end: 1 });
    expect(store.eventAt(0)).toEqual(makeEvent(1));
  });

  it('retains no unwritten slot when a batch larger than the capacity has a hole', () => {
    const store = createEventStore({ capacity: 4, keepPayload: true });
    store.appendEvents(makeEvents(100, 2));
    // Events 1..6 are skipped (only the newest four would fit); event 7 is written, 8 is a hole.
    const sparse = new Array<LogEvent>(10);
    for (let index = 0; index < 10; index++) {
      if (index !== 7) sparse[index] = makeEvent(index + 1);
    }

    expect(() => {
      store.appendEvents(sparse);
    }).toThrow(TypeError);
    expect(store).toMatchObject({ start: 8, end: 9, size: 1 });
    expect(store.eventAt(8)).toEqual(makeEvent(7));
  });

  it('rejects a level outside LOG_LEVELS and keeps the events before it', () => {
    const store = createEventStore({ capacity: 4, keepPayload: false });
    const invalid = { ...makeEvent(2) };
    Reflect.set(invalid, 'level', 'verbose');

    expect(() => {
      store.appendEvents([makeEvent(1), invalid]);
    }).toThrow(/verbose/);
    expect(store).toMatchObject({ start: 0, end: 1 });
  });
});

describe('column batches', () => {
  it('give a second store the same rows at the same positions', () => {
    const source = createEventStore({ capacity: 5, keepPayload: true });
    const replica = createEventStore({ capacity: 5, keepPayload: false });

    // Batches of three into a ring of five: both stores wrap around in the middle of a batch.
    for (let batch = 0; batch < 6; batch++) {
      source.appendEvents(makeEvents(batch * 3 + 1, 3));
      sync(source, replica);
      expect(rows(replica)).toEqual(rows(source));
    }

    expect(replica).toMatchObject({ start: 13, end: 18, size: 5 });
    expect(replica.eventAt(15)).toEqual(withoutPayload(makeEvent(16)));
  });

  it('carry only the rows appended since the previous batch', () => {
    const source = createEventStore({ capacity: 10, keepPayload: true });
    source.appendEvents(makeEvents(1, 3));
    source.takeColumnBatch();

    source.appendEvents(makeEvents(4, 2));
    source.appendEvents(makeEvents(6, 1));
    const batch = source.takeColumnBatch();

    expect(batch).toMatchObject({ firstPosition: 3, count: 3 });
    expect(Array.from(batch?.seq ?? [])).toEqual([4, 5, 6]);
    expect(Array.from(batch?.level ?? [])).toEqual([4, 5, 0]);
    expect(Array.from(batch?.hasPayload ?? [])).toEqual([1, 0, 1]);
    expect(batch?.message).toEqual([4, 5, 6].map((seq) => makeEvent(seq).message));
    expect(batch?.traceId).toEqual(['trace-4', 'trace-5', undefined]);
    expect(source.takeColumnBatch()).toBeUndefined();
  });

  it('split a backlog into batches of at most maxRows that rebuild the same rows', () => {
    const source = createEventStore({ capacity: 20, keepPayload: true });
    const replica = createEventStore({ capacity: 20, keepPayload: false });
    source.appendEvents(makeEvents(1, 13));

    const counts = [];
    for (let batch = source.takeColumnBatch(5); batch; batch = source.takeColumnBatch(5)) {
      counts.push(batch.count);
      replica.appendColumns(batch);
    }

    expect(counts).toEqual([5, 5, 3]);
    expect(rows(replica)).toEqual(rows(source));
  });

  it('split a backlog that outgrew the capacity, starting at the oldest retained row', () => {
    const source = createEventStore({ capacity: 8, keepPayload: true });
    const replica = createEventStore({ capacity: 8, keepPayload: false });
    source.appendEvents(makeEvents(1, 2));
    sync(source, replica);
    source.appendEvents(makeEvents(3, 20));

    const batches = [];
    for (let batch = source.takeColumnBatch(3); batch; batch = source.takeColumnBatch(3)) {
      batches.push({ firstPosition: batch.firstPosition, count: batch.count });
      replica.appendColumns(batch);
    }

    expect(batches).toEqual([
      { firstPosition: 14, count: 3 },
      { firstPosition: 17, count: 3 },
      { firstPosition: 20, count: 2 },
    ]);
    expect(rows(replica)).toEqual(rows(source));
  });

  it(`carry at most ${String(MAX_COLUMN_BATCH_ROWS)} rows by default`, () => {
    const source = createEventStore({ capacity: MAX_COLUMN_BATCH_ROWS + 10, keepPayload: false });
    source.appendEvents(makeEvents(1, MAX_COLUMN_BATCH_ROWS + 5));

    expect(source.takeColumnBatch()?.count).toBe(MAX_COLUMN_BATCH_ROWS);
    expect(source.takeColumnBatch()?.count).toBe(5);
  });

  it('reject a maxRows that is not a positive integer', () => {
    const source = createEventStore({ capacity: 4, keepPayload: false });

    expect(() => source.takeColumnBatch(0)).toThrow(RangeError);
    expect(() => source.takeColumnBatch(1.5)).toThrow(RangeError);
  });

  it('carry each service and host name once, in id order', () => {
    const source = createEventStore({ capacity: 10, keepPayload: false });

    source.appendEvents(makeEvents(1, 2));
    const first = source.takeColumnBatch();
    source.appendEvents(makeEvents(3, 3));
    const second = source.takeColumnBatch();

    expect(first).toMatchObject({
      newServices: ['orders', 'payments'],
      newHosts: ['orders-7f9c-1', 'payments-7f9c-0'],
    });
    expect(second).toMatchObject({
      newServices: ['api-gateway'],
      newHosts: ['api-gateway-7f9c-1', 'orders-7f9c-0', 'payments-7f9c-1'],
    });
  });

  it('skip rows evicted before they were taken, and the replica drops its older rows too', () => {
    const source = createEventStore({ capacity: 4, keepPayload: true });
    const replica = createEventStore({ capacity: 4, keepPayload: false });
    source.appendEvents(makeEvents(1, 2));
    sync(source, replica);

    // A hidden tab: the source keeps appending while nothing is taken.
    source.appendEvents(makeEvents(3, 9));
    const batch = sync(source, replica);

    expect(batch).toMatchObject({ firstPosition: 7, count: 4 });
    expect(replica).toMatchObject({ start: 7, end: 11 });
    expect(rows(replica)).toEqual(rows(source));
  });

  it('keep the newest rows when the replica is smaller than the batch', () => {
    const source = createEventStore({ capacity: 8, keepPayload: true });
    const replica = createEventStore({ capacity: 3, keepPayload: false });

    source.appendEvents(makeEvents(1, 7));
    sync(source, replica);

    expect(replica).toMatchObject({ start: 4, end: 7 });
    expect(rows(replica)).toEqual(rows(source).slice(4));
  });

  it('never show a stale payload in a replica that keeps payloads', () => {
    const source = createEventStore({ capacity: 2, keepPayload: true });
    const replica = createEventStore({ capacity: 2, keepPayload: true });
    // Slot 0 of the replica holds a payload; the same names keep both dictionaries in step.
    replica.appendEvents([makeEvent(2)]);

    source.appendEvents([makeEvent(2)]);
    source.appendEvents(makeEvents(3, 2));
    sync(source, replica);

    expect(replica).toMatchObject({ start: 1, end: 3 });
    expect(replica.hasPayloadAt(2)).toBe(true);
    expect(replica.eventAt(2)).toEqual(withoutPayload(makeEvent(4)));
  });

  it('must be appended in order', () => {
    const source = createEventStore({ capacity: 10, keepPayload: false });
    const replica = createEventStore({ capacity: 10, keepPayload: false });
    source.appendEvents(makeEvents(1, 3));
    const batch = source.takeColumnBatch();
    if (batch === undefined) throw new Error('Expected a batch');
    replica.appendColumns(batch);

    expect(() => {
      replica.appendColumns(batch);
    }).toThrow(RangeError);
    expect(replica).toMatchObject({ start: 0, end: 3 });
  });

  it('must hold count rows in every column', () => {
    const source = createEventStore({ capacity: 10, keepPayload: false });
    const replica = createEventStore({ capacity: 10, keepPayload: false });
    source.appendEvents(makeEvents(1, 3));
    const batch = source.takeColumnBatch();
    if (batch === undefined) throw new Error('Expected a batch');

    expect(() => {
      replica.appendColumns({ ...batch, message: batch.message.slice(1) });
    }).toThrow(RangeError);
    expect(replica.size).toBe(0);
  });

  it('list their six typed-array buffers as transferables', () => {
    const source = createEventStore({ capacity: 10, keepPayload: true });
    const replica = createEventStore({ capacity: 10, keepPayload: false });
    source.appendEvents(makeEvents(1, 4));
    const batch = source.takeColumnBatch();
    if (batch === undefined) throw new Error('Expected a batch');

    const transfer = columnBatchTransferables(batch);
    expect(new Set(transfer).size).toBe(6);
    // What postMessage does: the clone owns the buffers, the original's columns are detached.
    const received = structuredClone(batch, { transfer });
    expect(batch.seq.length).toBe(0);

    replica.appendColumns(received);
    expect(rows(replica)).toEqual(rows(source));
  });
});
