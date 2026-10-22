import type { LogEvent } from '@lsv/protocol';

/** Counters of one connection, as the UI shows them. */
export interface StreamCounters {
  /** Events received since the last reset. */
  readonly received: number;
  /**
   * Events received during the last second. It decays to 0 within a second once batches stop, so
   * a caller that shows it only while connected may also show 0 whenever it is not.
   */
  readonly eventsPerSecond: number;
  /** Events the server numbered but this client never received: gaps in `seq`, the authoritative loss. */
  readonly missed: number;
  /**
   * Events the server says it skipped under backpressure (`batch.dropped`). Informational: they
   * are part of `missed` too, so the difference is loss the server did not report.
   */
  readonly dropped: number;
  /** Frames dropped because they were not valid protocol messages. */
  readonly invalidFrames: number;
}

/**
 * Statistics of a stream: received events, events per second, `seq` gaps, reported drops and
 * invalid frames. Pure bookkeeping on numbers — no per-event work, no growing arrays — with the
 * clock passed in as `now` (milliseconds on a monotonic clock, e.g. `performance.now()`), so tests
 * drive it with plain numbers and the same code runs in a worker or on the main thread.
 */
export interface StreamStats {
  /** Starts over with zero counters, e.g. when a new connection opens. */
  readonly reset: (now: number) => void;
  /**
   * A stream started (`hello`): `seq` restarts at 1, and the rate window restarts at `now` (events
   * per second count only this stream's events). The other counters keep their values.
   */
  readonly onHello: (now: number) => void;
  /** A `batch` arrived with `events` and the server's `dropped` count (0 when absent). */
  readonly onBatch: (events: readonly LogEvent[], dropped: number, now: number) => void;
  /** A frame that was not a valid protocol message was dropped. */
  readonly onInvalidFrame: () => void;
  /** The counters at `now` (a new object). */
  readonly counters: (now: number) => StreamCounters;
}

/** Events per second are counted in ten buckets of 100 ms: a window of one second. */
const RATE_BUCKET_MS = 100;
const RATE_BUCKETS = 10;

export function createStreamStats(): StreamStats {
  // Ring of per-bucket event counts, indexed by bucket number modulo RATE_BUCKETS.
  const bucketIds = new Float64Array(RATE_BUCKETS);
  const bucketCounts = new Float64Array(RATE_BUCKETS);

  let received = 0;
  let missed = 0;
  let dropped = 0;
  let invalidFrames = 0;
  let lastSeq = 0;
  let startedAt = 0;

  /**
   * Restarts `seq` tracking and the rate window at `now`. Buckets of a previous connection must
   * go: divided by a young stream's short window they would inflate the rate several times.
   */
  function startStream(now: number): void {
    lastSeq = 0;
    startedAt = now;
    bucketIds.fill(Number.NEGATIVE_INFINITY);
    bucketCounts.fill(0);
  }

  function reset(now: number): void {
    received = 0;
    missed = 0;
    dropped = 0;
    invalidFrames = 0;
    startStream(now);
  }

  /** Events counted in `slot` if it holds `bucket`, else 0. */
  function countIn(slot: number, bucket: number): number {
    return bucketIds[slot] === bucket ? (bucketCounts[slot] ?? 0) : 0;
  }

  function countForRate(now: number, count: number): void {
    const bucket = Math.floor(now / RATE_BUCKET_MS);
    const slot = bucket % RATE_BUCKETS;
    bucketCounts[slot] = countIn(slot, bucket) + count;
    bucketIds[slot] = bucket;
  }

  function eventsPerSecond(now: number): number {
    const current = Math.floor(now / RATE_BUCKET_MS);
    let sum = 0;
    // The last RATE_BUCKETS buckets, the current one included, each in its own slot.
    for (let bucket = current - RATE_BUCKETS + 1; bucket <= current; bucket++) {
      sum += countIn(bucket % RATE_BUCKETS, bucket);
    }
    // The window is nine full buckets plus the elapsed part of the current one, but no longer than
    // the stream has run (or the first second would read low), and at least one bucket.
    const window = (RATE_BUCKETS - 1) * RATE_BUCKET_MS + (now % RATE_BUCKET_MS);
    const windowMs = Math.max(RATE_BUCKET_MS, Math.min(window, now - startedAt));
    return Math.round((sum * 1000) / windowMs);
  }

  reset(0);

  return {
    reset,
    onHello: startStream,
    onBatch(events, droppedNow, now) {
      dropped += droppedNow;
      const count = events.length;
      const last = events[count - 1];
      if (last === undefined) return;
      received += count;
      // `seq` grows by one per generated event and strictly increases within a batch, so every
      // number after the previous batch's last `seq` up to this one's that did not arrive is lost.
      missed += Math.max(0, last.seq - lastSeq - count);
      lastSeq = last.seq;
      countForRate(now, count);
    },
    onInvalidFrame() {
      invalidFrames++;
    },
    counters: (now) => ({
      received,
      eventsPerSecond: eventsPerSecond(now),
      missed,
      dropped,
      invalidFrames,
    }),
  };
}
