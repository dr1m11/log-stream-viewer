import { BATCH_INTERVAL_MS } from '@lsv/protocol';
import { describe, expect, it } from 'vitest';

import {
  CATCH_UP_TICKS,
  createScheduler,
  eventsDue,
  type SchedulerState,
  withRate,
} from './scheduler.ts';

const T0 = 1_000_000;

/** Runs the scheduler on a fake clock, one step per entry of `times`; returns the counts. */
function run(state: SchedulerState, times: readonly number[]): number[] {
  let current = state;
  return times.map((now) => {
    const due = eventsDue(current, now);
    current = due.state;
    return due.count;
  });
}

const ticks = (count: number, interval = BATCH_INTERVAL_MS) =>
  Array.from({ length: count }, (_, index) => T0 + (index + 1) * interval);

describe('eventsDue', () => {
  it('yields rate × tick events per tick', () => {
    expect(run(createScheduler(200, T0), ticks(20))).toEqual(Array.from({ length: 20 }, () => 10));
  });

  it('carries fractions so that odd rates are met exactly over time', () => {
    const counts = run(createScheduler(333, T0), ticks(20));
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(333);
    expect(new Set(counts)).toEqual(new Set([16, 17]));
  });

  it('emits a low rate on every other tick', () => {
    expect(run(createScheduler(10, T0), ticks(6))).toEqual([0, 1, 0, 1, 0, 1]);
  });

  it('caps the catch-up after the event loop stalled and drops the backlog', () => {
    const state = createScheduler(1000, T0);
    const stalled = eventsDue(state, T0 + 1000);
    expect(stalled.count).toBe((1000 * BATCH_INTERVAL_MS * CATCH_UP_TICKS) / 1000);
    expect(stalled.state.carry).toBe(0);
    expect(eventsDue(stalled.state, T0 + 1000 + BATCH_INTERVAL_MS).count).toBe(50);
  });

  it('lets even the lowest rate catch up by at least one event', () => {
    expect(eventsDue(createScheduler(10, T0), T0 + 10_000).count).toBe(1);
  });

  it('yields nothing and keeps its clock when time goes backwards', () => {
    const state = createScheduler(1000, T0);
    const due = eventsDue(state, T0 - 500);
    expect(due.count).toBe(0);
    expect(due.state.lastAt).toBe(T0);
  });

  it('applies a new rate from the next step and keeps the carry', () => {
    const half = eventsDue(createScheduler(10, T0), T0 + 50);
    expect(half.count).toBe(0);
    expect(half.state.carry).toBe(500);
    const faster = withRate(half.state, 1000);
    expect(faster).toMatchObject({ rate: 1000, carry: half.state.carry });
    expect(eventsDue(faster, T0 + 100).count).toBe(50);
    expect(withRate(faster, 1000)).toBe(faster);
  });
});
