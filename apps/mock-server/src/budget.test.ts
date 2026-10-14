import { BATCH_INTERVAL_MS } from '@lsv/protocol';
import { describe, expect, it } from 'vitest';

import { EventBudget, shareFairly } from './budget.ts';

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

describe('shareFairly', () => {
  it('grants every demand when the budget suffices', () => {
    const demands = [10, 0, 25];
    const grants = shareFairly(demands, 100);
    expect(grants).toEqual([10, 0, 25]);
    expect(grants).not.toBe(demands);
  });

  it('meets small demands in full and splits the rest equally', () => {
    expect(shareFairly([5, 100, 100], 105)).toEqual([5, 50, 50]);
    expect(shareFairly([100, 5, 100, 30], 120)).toEqual([42, 5, 43, 30]);
  });

  it('passes the rounding of equal shares on, so no budget is wasted', () => {
    const grants = shareFairly([50, 50, 50], 100);
    expect(sum(grants)).toBe(100);
    expect(Math.max(...grants) - Math.min(...grants)).toBeLessThanOrEqual(1);
  });

  it('grants nothing without a budget', () => {
    expect(shareFairly([10, 20], 0)).toEqual([0, 0]);
    expect(shareFairly([], 50)).toEqual([]);
  });

  it('never grants more than asked or more than available', () => {
    const demands = [3, 70, 12, 0, 45, 45, 1];
    for (const available of [0, 1, 7, 50, 100, 175, 1000]) {
      const grants = shareFairly(demands, available);
      expect(sum(grants)).toBeLessThanOrEqual(available);
      grants.forEach((grant, index) => {
        expect(grant).toBeLessThanOrEqual(demands[index] ?? 0);
      });
      expect(sum(grants)).toBe(Math.min(available, sum(demands)));
    }
  });
});

describe('EventBudget', () => {
  it('limits all sessions together to the global rate', () => {
    const t0 = 5_000;
    const budget = new EventBudget(1000, t0);
    expect(budget.eventsPerSec).toBe(1000);
    let granted = 0;
    for (let tick = 1; tick <= 20; tick++) {
      granted += sum(budget.allocate([400, 400, 400], t0 + tick * BATCH_INTERVAL_MS));
    }
    expect(granted).toBe(1000);
  });

  it('does not save unused budget for a later burst', () => {
    const budget = new EventBudget(1000, 0);
    for (let tick = 1; tick <= 20; tick++) budget.allocate([0], tick * BATCH_INTERVAL_MS);
    expect(budget.allocate([10_000], 21 * BATCH_INTERVAL_MS)).toEqual([50]);
  });
});
