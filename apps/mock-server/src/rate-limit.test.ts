import { describe, expect, it } from 'vitest';

import { TokenBucket } from './rate-limit.ts';

describe('TokenBucket', () => {
  it('allows a burst, then refuses until tokens refill', () => {
    const bucket = new TokenBucket(20, 40, 0);
    const burst = Array.from({ length: 41 }, () => bucket.take(0));
    expect(burst.filter(Boolean)).toHaveLength(40);
    expect(burst.at(-1)).toBe(false);
    expect(bucket.take(49)).toBe(false);
    expect(bucket.take(50)).toBe(true);
  });

  it('sustains its rate indefinitely', () => {
    const bucket = new TokenBucket(20, 40, 0);
    let refused = 0;
    for (let now = 0; now < 10_000; now += 50) if (!bucket.take(now)) refused++;
    expect(refused).toBe(0);
  });

  it('refills no further than the burst and ignores a clock going backwards', () => {
    const bucket = new TokenBucket(20, 2, 0);
    expect([bucket.take(60_000), bucket.take(60_000), bucket.take(60_000)]).toEqual([
      true,
      true,
      false,
    ]);
    expect(bucket.take(1000)).toBe(false);
  });
});
