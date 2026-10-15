import type { LogEvent, StreamSettings } from '@lsv/protocol';

import type { StreamSocket, StreamSocketHandlers } from '@/shared/api';

/** Where the connection is. `connected` starts with the server's `hello`, not with the socket opening. */
export type ConnectionStatus =
  | { readonly phase: 'connecting' }
  | { readonly phase: 'connected'; readonly stream: StreamSettings }
  | {
      readonly phase: 'closed';
      readonly code: number;
      readonly reason: string;
      /** Whether the stream had started (`hello`) before the connection closed. */
      readonly wasConnected: boolean;
    };

/** What the page shows; a new object at most once per animation frame. */
export interface StreamSnapshot {
  readonly status: ConnectionStatus;
  /** Events received since the connection opened. */
  readonly received: number;
  /** Events received during the last second (0 unless connected). */
  readonly eventsPerSecond: number;
  /** Events the server numbered but this client never received: gaps in `seq`. */
  readonly missed: number;
  /** Frames dropped because they were not valid protocol messages. */
  readonly invalidFrames: number;
  /** The newest event, refreshed at most every {@link PREVIEW_INTERVAL_MS}. */
  readonly latest: LogEvent | undefined;
}

export interface StreamStore {
  /** Subscribes to snapshot changes (`useSyncExternalStore`). Returns the unsubscribe function. */
  readonly subscribe: (listener: () => void) => () => void;
  /** The current snapshot: the same object until the next publication. */
  readonly getSnapshot: () => StreamSnapshot;
  /** Opens a connection with fresh counters, closing the current one first. */
  readonly start: () => void;
  /** Closes the connection and cancels pending publications. */
  readonly stop: () => void;
}

/** The latest-event preview changes at most four times per second, so it stays readable. */
export const PREVIEW_INTERVAL_MS = 250;
/** Events per second are counted in ten buckets of 100 ms: a window of one second. */
const RATE_BUCKET_MS = 100;
const RATE_BUCKETS = 10;

const CONNECTING: ConnectionStatus = { phase: 'connecting' };
const INITIAL_SNAPSHOT: StreamSnapshot = {
  status: CONNECTING,
  received: 0,
  eventsPerSecond: 0,
  missed: 0,
  invalidFrames: 0,
  latest: undefined,
};

/**
 * Accumulates the stream outside React (`.claude/rules/performance.md`). A batch only updates a
 * few numbers and a reference to its newest event — no per-event work, no growing arrays. The UI
 * reads a snapshot that is published at most once per animation frame, whatever the batch rate.
 *
 * `connect` opens the socket with the store's handlers, e.g. with `openStreamSocket`.
 */
export function createStreamStore(
  connect: (handlers: StreamSocketHandlers) => StreamSocket,
): StreamStore {
  const listeners = new Set<() => void>();
  // Ring of per-bucket event counts, indexed by bucket number modulo RATE_BUCKETS.
  const bucketIds = new Array<number>(RATE_BUCKETS);
  const bucketCounts = new Array<number>(RATE_BUCKETS);

  let socket: StreamSocket | undefined;
  let frame: number | undefined;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;

  let status: ConnectionStatus = CONNECTING;
  let received = 0;
  let missed = 0;
  let invalidFrames = 0;
  let lastSeq = 0;
  let latest: LogEvent | undefined;
  let previewShownAt = Number.NEGATIVE_INFINITY;
  let snapshot = INITIAL_SNAPSHOT;

  function reset(): void {
    status = CONNECTING;
    received = 0;
    missed = 0;
    invalidFrames = 0;
    lastSeq = 0;
    latest = undefined;
    previewShownAt = Number.NEGATIVE_INFINITY;
    bucketIds.fill(Number.NEGATIVE_INFINITY);
    bucketCounts.fill(0);
  }

  function countForRate(now: number, count: number): void {
    const bucket = Math.floor(now / RATE_BUCKET_MS);
    const slot = bucket % RATE_BUCKETS;
    const previous = bucketIds[slot] === bucket ? (bucketCounts[slot] ?? 0) : 0;
    bucketIds[slot] = bucket;
    bucketCounts[slot] = previous + count;
  }

  function eventsPerSecond(now: number): number {
    const current = Math.floor(now / RATE_BUCKET_MS);
    let sum = 0;
    for (let slot = 0; slot < RATE_BUCKETS; slot++) {
      const age = current - (bucketIds[slot] ?? Number.NEGATIVE_INFINITY);
      if (age < RATE_BUCKETS) sum += bucketCounts[slot] ?? 0;
    }
    // The window is nine full buckets plus the elapsed part of the current one.
    const windowMs = (RATE_BUCKETS - 1) * RATE_BUCKET_MS + (now % RATE_BUCKET_MS);
    return Math.round((sum * 1000) / windowMs);
  }

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function schedulePublish(): void {
    frame ??= requestAnimationFrame(publish);
  }

  function publish(): void {
    frame = undefined;
    const now = performance.now();
    let preview = snapshot.latest;
    if (latest !== preview) {
      const wait = previewShownAt + PREVIEW_INTERVAL_MS - now;
      if (wait <= 0) {
        preview = latest;
        previewShownAt = now;
      } else {
        // Show the newest event once the interval has passed, even if no other update comes.
        previewTimer ??= setTimeout(() => {
          previewTimer = undefined;
          schedulePublish();
        }, wait);
      }
    }
    snapshot = {
      status,
      received,
      eventsPerSecond: status.phase === 'connected' ? eventsPerSecond(now) : 0,
      missed,
      invalidFrames,
      latest: preview,
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

  const handlers: StreamSocketHandlers = {
    onHello(message) {
      status = { phase: 'connected', stream: message.stream };
      lastSeq = 0;
      schedulePublish();
    },
    onBatch({ events }) {
      const count = events.length;
      const last = events[count - 1];
      if (last === undefined) return;
      received += count;
      // `seq` grows by one per generated event and strictly increases within a batch, so every
      // number after the previous batch's last `seq` up to this one's that did not arrive is lost.
      missed += Math.max(0, last.seq - lastSeq - count);
      lastSeq = last.seq;
      latest = last;
      countForRate(performance.now(), count);
      schedulePublish();
    },
    // Keeps events per second current while no batches arrive.
    onHeartbeat() {
      schedulePublish();
    },
    onInvalidFrame() {
      invalidFrames++;
      schedulePublish();
    },
    onClose(code, reason) {
      status = { phase: 'closed', code, reason, wasConnected: status.phase === 'connected' };
      socket = undefined;
      schedulePublish();
    },
  };

  reset();

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    start() {
      socket?.close();
      cancelPending();
      reset();
      if (snapshot !== INITIAL_SNAPSHOT) {
        snapshot = INITIAL_SNAPSHOT;
        notify();
      }
      socket = connect(handlers);
    },
    stop() {
      socket?.close();
      socket = undefined;
      cancelPending();
    },
  };
}
