import { createEventStore, type EventStore, type StreamCounters } from '@lsv/core';
import type { LogEvent, StreamLimits, StreamSettings } from '@lsv/protocol';

import { SOCKET_FAILURE_CODES, type StreamRequest } from '@/shared/api';

import { spawnStreamWorker, type StreamWorker } from '../api/spawn-stream-worker';
import type { FromWorkerMessage } from '../api/worker-protocol';

/** Where the connection is. `connected` starts with the server's `hello`, not with the socket opening. */
export type ConnectionStatus =
  | { readonly phase: 'connecting' }
  | {
      readonly phase: 'connected';
      /** Effective stream settings, after the server's defaults and clamping. */
      readonly stream: StreamSettings;
      /** Bounds of this deployment; a rate control must clamp to them (`docs/protocol.md`). */
      readonly limits: StreamLimits;
      /** When the server will end the session with 4000, epoch ms (server clock). */
      readonly expiresAt: number;
    }
  | {
      readonly phase: 'closed';
      readonly code: number;
      readonly reason: string;
      /** Whether the stream had started (`hello`) before the connection closed. */
      readonly wasConnected: boolean;
    };

/**
 * Read access to the main thread's replica of the event buffer (docs/adr/0006): rows by position,
 * for the table. The row accessors do not check their position; read only positions inside
 * `[start, end)` read in the same task, or check `has(position)`. Batches are appended as they
 * arrive, between snapshots, so the replica may already be ahead of the snapshot that rendered:
 * a row the snapshot still lists may have been evicted since.
 */
export type LogBufferView = Pick<
  EventStore,
  | 'capacity'
  | 'start'
  | 'end'
  | 'size'
  | 'has'
  | 'seqAt'
  | 'tsAt'
  | 'levelAt'
  | 'serviceAt'
  | 'hostAt'
  | 'messageAt'
  | 'traceIdAt'
  | 'hasPayloadAt'
  | 'eventAt'
>;

/** What the UI shows. A new object only when a value changed, at most once per animation frame. */
export interface LogStreamSnapshot {
  readonly status: ConnectionStatus;
  /** The worker's counters for this session; `eventsPerSecond` is 0 unless connected. */
  readonly counters: StreamCounters;
  /** This session's buffer replica: a new view for every session, whose positions restart at 0. */
  readonly buffer: LogBufferView;
  /** `buffer.start` when the snapshot was taken: the oldest retained position. */
  readonly start: number;
  /** `buffer.end` when the snapshot was taken: the position after the newest row. */
  readonly end: number;
  /** The newest event, refreshed at most every {@link PREVIEW_INTERVAL_MS}. */
  readonly latest: LogEvent | undefined;
  /**
   * The last failure the store recovered from on its own by restarting the stream (the replica
   * fell out of step with the worker's buffer), for the UI to mention; cleared by `start()`.
   */
  readonly error: string | undefined;
}

export interface LogStreamOptions {
  /** WebSocket endpoint of the mock server, e.g. `ws://localhost:8787/ws`. */
  readonly endpoint: string;
  readonly request: StreamRequest;
  /** Buffer capacity in events, already clamped (`clampBufferCapacity`); used by both threads. */
  readonly capacity: number;
  /** Starts the worker; {@link spawnStreamWorker} unless a test passes a fake. */
  readonly spawnWorker?: () => StreamWorker;
}

export interface LogStreamStore {
  /** Subscribes to snapshot changes (`useSyncExternalStore`). Returns the unsubscribe function. */
  readonly subscribe: (listener: () => void) => () => void;
  /** The current snapshot: the same object until a value changes. */
  readonly getSnapshot: () => LogStreamSnapshot;
  /** Starts a new session (new buffers on both threads), spawning the worker if needed. */
  readonly start: () => void;
  /** Closes the connection, terminates the worker and cancels pending publications. */
  readonly stop: () => void;
}

/** The latest-event preview changes at most four times per second, so it stays readable. */
export const PREVIEW_INTERVAL_MS = 250;

const CONNECTING: ConnectionStatus = { phase: 'connecting' };
const NO_COUNTERS: StreamCounters = {
  received: 0,
  eventsPerSecond: 0,
  missed: 0,
  dropped: 0,
  invalidFrames: 0,
};

/** A view of `store` that exposes no mutating method. The accessors use no `this`. */
function readOnlyView(store: EventStore): LogBufferView {
  return {
    capacity: store.capacity,
    get start() {
      return store.start;
    },
    get end() {
      return store.end;
    },
    get size() {
      return store.size;
    },
    has: store.has,
    seqAt: store.seqAt,
    tsAt: store.tsAt,
    levelAt: store.levelAt,
    serviceAt: store.serviceAt,
    hostAt: store.hostAt,
    messageAt: store.messageAt,
    traceIdAt: store.traceIdAt,
    hasPayloadAt: store.hasPayloadAt,
    eventAt: store.eventAt,
  };
}

function sameCounters(a: StreamCounters, b: StreamCounters): boolean {
  return (
    a.received === b.received &&
    a.eventsPerSecond === b.eventsPerSecond &&
    a.missed === b.missed &&
    a.dropped === b.dropped &&
    a.invalidFrames === b.invalidFrames
  );
}

/**
 * The main thread's side of the stream pipeline (docs/adr/0006). The worker owns the socket and
 * the authoritative buffer; this store keeps a replica without payloads, fed by the worker's
 * column batches as they arrive, and publishes a snapshot for React at most once per animation
 * frame, whatever the batch rate. A hidden tab pauses the frames but not the batches: the replica
 * evicts on append, so it stays at its capacity.
 *
 * Every `start` opens a new session; messages of an older one are dropped. If a batch does not
 * continue the replica (`appendColumns` throws a `RangeError`), the rows can no longer be trusted
 * to match the worker's, so the store records the error and restarts with a new session.
 */
export function createLogStreamStore(options: LogStreamOptions): LogStreamStore {
  const { endpoint, request, capacity, spawnWorker = spawnStreamWorker } = options;
  const listeners = new Set<() => void>();

  let worker: StreamWorker | undefined;
  let session = 0;
  let frame: number | undefined;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;

  let buffer = createEventStore({ capacity, keepPayload: false });
  let view = readOnlyView(buffer);
  let status: ConnectionStatus = CONNECTING;
  let counters = NO_COUNTERS;
  let error: string | undefined;
  /** The event the preview shows, and the buffer end it was read at. */
  let preview: LogEvent | undefined;
  let previewEnd = 0;
  let previewShownAt = Number.NEGATIVE_INFINITY;

  let snapshot: LogStreamSnapshot = {
    status,
    counters,
    buffer: view,
    start: 0,
    end: 0,
    latest: undefined,
    error: undefined,
  };

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function schedulePublish(): void {
    frame ??= requestAnimationFrame(publish);
  }

  function publish(): void {
    frame = undefined;
    const now = performance.now();
    const { start, end } = buffer;
    if (end !== previewEnd) {
      const wait = previewShownAt + PREVIEW_INTERVAL_MS - now;
      if (wait <= 0) {
        preview = buffer.eventAt(end - 1);
        previewEnd = end;
        previewShownAt = now;
      } else {
        // Show the newest event once the interval has passed, even if no other update comes.
        previewTimer ??= setTimeout(() => {
          previewTimer = undefined;
          schedulePublish();
        }, wait);
      }
    }
    const previous = snapshot;
    const shown =
      status.phase === 'connected' || counters.eventsPerSecond === 0
        ? counters
        : { ...counters, eventsPerSecond: 0 };
    const nextCounters = sameCounters(previous.counters, shown) ? previous.counters : shown;
    if (
      previous.status === status &&
      previous.counters === nextCounters &&
      previous.buffer === view &&
      previous.start === start &&
      previous.end === end &&
      previous.latest === preview &&
      previous.error === error
    ) {
      return;
    }
    snapshot = {
      status,
      counters: nextCounters,
      buffer: view,
      start,
      end,
      latest: preview,
      error,
    };
    notify();
  }

  function cancelPending(): void {
    if (frame !== undefined) {
      cancelAnimationFrame(frame);
      frame = undefined;
    }
    if (previewTimer !== undefined) {
      clearTimeout(previewTimer);
      previewTimer = undefined;
    }
  }

  function receive({ data }: MessageEvent<FromWorkerMessage>): void {
    if (data.session !== session) return;
    switch (data.type) {
      case 'hello': {
        const { stream, limits, expiresAt } = data;
        status = { phase: 'connected', stream, limits, expiresAt };
        break;
      }
      case 'batch':
        try {
          buffer.appendColumns(data.columns);
        } catch (failure) {
          if (!(failure instanceof RangeError)) throw failure;
          error = `The table fell out of step with the stream and restarted it (${failure.message}).`;
          openSession();
          schedulePublish();
          return;
        }
        counters = data.counters;
        break;
      case 'counters':
        counters = data.counters;
        break;
      case 'closed':
        status = {
          phase: 'closed',
          code: data.code,
          reason: data.reason,
          wasConnected: status.phase === 'connected',
        };
        counters = data.counters;
        break;
    }
    schedulePublish();
  }

  /** The worker could not load (e.g. blocked by CSP) or crashed: nothing more will arrive. */
  function fail(event: ErrorEvent): void {
    const detail = event instanceof ErrorEvent && event.message !== '' ? `: ${event.message}` : '';
    status = {
      phase: 'closed',
      code: SOCKET_FAILURE_CODES.abnormalClosure,
      reason: `The stream worker failed${detail}`,
      wasConnected: status.phase === 'connected',
    };
    terminateWorker();
    schedulePublish();
  }

  function terminateWorker(): void {
    if (worker === undefined) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
    worker = undefined;
  }

  /** Starts a new session: fresh buffers on both threads, counters and status from scratch. */
  function openSession(): void {
    session++;
    // A replica that never received a row equals a new one; skip reallocating its columns.
    if (buffer.end !== 0) {
      buffer = createEventStore({ capacity, keepPayload: false });
      view = readOnlyView(buffer);
    }
    status = CONNECTING;
    counters = NO_COUNTERS;
    preview = undefined;
    previewEnd = 0;
    previewShownAt = Number.NEGATIVE_INFINITY;
    if (worker === undefined) {
      worker = spawnWorker();
      worker.onmessage = receive;
      worker.onerror = fail;
    }
    worker.postMessage({ type: 'start', session, endpoint, request, capacity });
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    start() {
      cancelPending();
      error = undefined;
      openSession();
      publish();
    },
    stop() {
      // Lets the worker close the socket cleanly if it gets to it before the termination; a
      // terminated worker's socket is closed by the browser either way.
      worker?.postMessage({ type: 'stop', session });
      terminateWorker();
      // Anything still queued from the worker belongs to a session that is over.
      session++;
      cancelPending();
    },
  };
}
