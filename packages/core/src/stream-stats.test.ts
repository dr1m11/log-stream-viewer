import type { LogEvent } from '@lsv/protocol';
import { describe, expect, it } from 'vitest';

import { createStreamStats } from './stream-stats.ts';

/** Events with the given `seq` numbers; the other fields do not matter to the statistics. */
function events(seqs: readonly number[]): LogEvent[] {
  return seqs.map((seq) => ({
    seq,
    ts: 1_791_979_204_000 + seq,
    level: 'info',
    service: 'orders',
    host: 'orders-7f9c-1',
    message: `Event ${String(seq)}`,
  }));
}

/** `count` consecutive `seq` numbers starting at `first`. */
function seqs(first: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => first + index);
}

// The fake clock starts on a whole second so the 100 ms rate buckets line up with the steps.
const T0 = 10_000;

function setup() {
  const stats = createStreamStats();
  stats.reset(T0);
  stats.onHello(T0);
  return stats;
}

describe('createStreamStats', () => {
  it('starts with zero counters', () => {
    expect(createStreamStats().counters(T0)).toEqual({
      received: 0,
      eventsPerSecond: 0,
      missed: 0,
      dropped: 0,
      invalidFrames: 0,
    });
  });

  it('counts the events lost in gaps of seq', () => {
    const stats = setup();

    stats.onBatch(events([1, 2, 3]), 0, T0);
    stats.onBatch(events([6, 7]), 0, T0);
    stats.onBatch(events([8]), 0, T0);
    stats.onBatch(events([10, 12]), 0, T0);

    expect(stats.counters(T0)).toMatchObject({ received: 8, missed: 4 });
  });

  it('keeps the drops the server reports apart from the gaps in seq', () => {
    const stats = setup();

    stats.onBatch(events([1, 2]), 0, T0);
    // Backpressure: the server skipped 3..10 and says so; 11 is lost without a report.
    stats.onBatch(events([12]), 8, T0);
    stats.onBatch(events([]), 2, T0);

    expect(stats.counters(T0)).toMatchObject({ received: 3, missed: 9, dropped: 10 });
  });

  it('counts the events missing before the first batch of a stream', () => {
    const stats = setup();

    stats.onBatch(events([5, 6]), 0, T0);

    expect(stats.counters(T0)).toMatchObject({ received: 2, missed: 4 });
  });

  it('restarts seq tracking on a new stream but keeps the counters', () => {
    const stats = setup();
    stats.onBatch(events([1, 2, 3, 4, 6]), 0, T0);

    // A reconnect: the new stream numbers its events from 1 again.
    stats.onHello(T0 + 500);
    stats.onBatch(events([1, 2]), 0, T0 + 550);

    expect(stats.counters(T0 + 550)).toMatchObject({ received: 7, missed: 1 });
  });

  it('measures events per second of the new stream only after a reconnect', () => {
    const stats = setup();
    let now = T0;
    // 10,000 events per second for a second: 500 events every 50 ms.
    for (let tick = 0; tick < 20; tick++) {
      stats.onBatch(events(seqs(tick * 500 + 1, 500)), 0, now);
      now += 50;
    }

    // The connection drops for 200 ms; the new stream runs at the same rate for 100 ms.
    now += 200;
    stats.onHello(now);
    stats.onBatch(events(seqs(1, 500)), 0, now);
    stats.onBatch(events(seqs(501, 500)), 0, now + 50);

    // The old stream's buckets over the new stream's 100 ms window would read 70,000.
    const { eventsPerSecond } = stats.counters(now + 100);
    expect(eventsPerSecond).toBeGreaterThanOrEqual(9000);
    expect(eventsPerSecond).toBeLessThanOrEqual(11_000);
  });

  it('counts invalid frames', () => {
    const stats = setup();

    stats.onInvalidFrame();
    stats.onInvalidFrame();

    expect(stats.counters(T0).invalidFrames).toBe(2);
  });

  it('reports the events received during the last second', () => {
    const stats = setup();
    let now = T0;

    // 200 events per second: a batch of 10 every 50 ms for two seconds.
    for (let tick = 0; tick < 40; tick++) {
      stats.onBatch(events(seqs(tick * 10 + 1, 10)), 0, now);
      now += 50;
    }
    const { eventsPerSecond } = stats.counters(now);
    expect(eventsPerSecond).toBeGreaterThanOrEqual(180);
    expect(eventsPerSecond).toBeLessThanOrEqual(220);

    // No batches for over a second: the rate comes down to zero.
    expect(stats.counters(now + 1100).eventsPerSecond).toBe(0);
  });

  it('measures events per second over the time since hello while the stream is young', () => {
    const stats = setup();
    let now = T0;

    // 200 events per second for 300 ms: over a full one-second window this would read ~66.
    for (let tick = 0; tick < 6; tick++) {
      stats.onBatch(events(seqs(tick * 10 + 1, 10)), 0, now);
      now += 50;
    }

    const { eventsPerSecond } = stats.counters(now);
    expect(eventsPerSecond).toBeGreaterThanOrEqual(180);
    expect(eventsPerSecond).toBeLessThanOrEqual(220);
  });

  it('measures at least one bucket right after hello', () => {
    const stats = setup();

    stats.onBatch(events(seqs(1, 10)), 0, T0 + 1);

    // 10 events over the 100 ms minimum window, not over 1 ms.
    expect(stats.counters(T0 + 1).eventsPerSecond).toBe(100);
  });

  it('starts over with zero counters and a fresh rate window on reset', () => {
    const stats = setup();
    stats.onBatch(events([1, 2, 5]), 3, T0);
    stats.onInvalidFrame();

    stats.reset(T0 + 200);
    stats.onBatch(events([1]), 0, T0 + 250);

    expect(stats.counters(T0 + 250)).toEqual({
      received: 1,
      eventsPerSecond: 10,
      missed: 0,
      dropped: 0,
      invalidFrames: 0,
    });
  });
});
