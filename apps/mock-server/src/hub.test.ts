import { BATCH_INTERVAL_MS } from '@lsv/protocol';
import { describe, expect, it } from 'vitest';

import { type Stream, StreamHub } from './hub.ts';

/** A stream that always wants `demand` events per tick and records what it was granted. */
class FakeStream implements Stream {
  readonly grants: number[] = [];
  readonly calls: string[] = [];
  readonly demand: number;

  constructor(demand: number) {
    this.demand = demand;
  }

  due(now: number): number {
    this.calls.push(`due@${String(now)}`);
    return this.demand;
  }

  flush(now: number, granted: number): number {
    this.calls.push(`flush@${String(now)}`);
    this.grants.push(granted);
    return granted;
  }
}

/** A stream that throws in the given phase of every tick. */
class BrokenStream extends FakeStream {
  readonly phase: 'due' | 'flush';

  constructor(phase: 'due' | 'flush') {
    super(5);
    this.phase = phase;
  }

  override due(now: number): number {
    if (this.phase === 'due') throw new Error('due failed');
    return super.due(now);
  }

  override flush(now: number, granted: number): number {
    if (this.phase === 'flush') throw new Error('flush failed');
    return super.flush(now, granted);
  }
}

const failOnError = (_stream: unknown, error: unknown): never => {
  throw error;
};

describe('StreamHub', () => {
  it.each(['due', 'flush'] as const)(
    'drops a stream that throws in %s, reports it once and keeps ticking the others',
    (phase) => {
      const errors: unknown[] = [];
      const hub = new StreamHub<FakeStream>(10_000, 0, (_stream, error) => errors.push(error));
      const broken = new BrokenStream(phase);
      const healthy = new FakeStream(3);
      hub.add(broken);
      hub.add(healthy);
      for (let tick = 1; tick <= 20; tick++) hub.tick(tick * BATCH_INTERVAL_MS);
      expect(errors).toEqual([new Error(`${phase} failed`)]);
      expect(hub.streams()).toEqual([healthy]);
      expect(healthy.grants).toEqual(Array.from({ length: 20 }, () => 3));
    },
  );

  it('asks every stream for its demand before any of them flushes', () => {
    const hub = new StreamHub<FakeStream>(10_000, 0, failOnError);
    const a = new FakeStream(5);
    const b = new FakeStream(7);
    hub.add(a);
    hub.add(b);
    expect(hub.size).toBe(2);
    expect(hub.tick(BATCH_INTERVAL_MS)).toBe(12);
    expect(a.calls).toEqual(['due@50', 'flush@50']);
    expect(b.grants).toEqual([7]);
  });

  it('shares the global budget fairly between streams', () => {
    const hub = new StreamHub<FakeStream>(1000, 0, failOnError);
    const greedy = new FakeStream(500);
    const modest = new FakeStream(10);
    hub.add(greedy);
    hub.add(modest);
    hub.tick(BATCH_INTERVAL_MS);
    expect(modest.grants).toEqual([10]);
    expect(greedy.grants).toEqual([40]);
  });

  it('stops ticking a removed stream', () => {
    const hub = new StreamHub<FakeStream>(1000, 0, failOnError);
    const stream = new FakeStream(1);
    hub.add(stream);
    hub.remove(stream);
    expect(hub.tick(BATCH_INTERVAL_MS)).toBe(0);
    expect(stream.calls).toEqual([]);
    expect(hub.streams()).toEqual([]);
  });

  it('measures the events sent per second and forgets the rate when ticks stop', () => {
    const hub = new StreamHub<FakeStream>(100_000, 0, failOnError);
    hub.add(new FakeStream(25));
    expect(hub.eventsPerSec(0)).toBe(0);
    for (let tick = 1; tick <= 20; tick++) hub.tick(tick * BATCH_INTERVAL_MS);
    expect(hub.eventsPerSec(1000)).toBe(500);
    expect(hub.eventsPerSec(1500)).toBe(500);
    expect(hub.eventsPerSec(3500)).toBe(0);
  });
});
