import { describe, expect, it } from 'vitest';

import { hash32, Prng } from './prng.ts';

/** The reference mulberry32 by Tommy Ettinger, as usually quoted in JavaScript. */
function referenceMulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('Prng', () => {
  it('produces the reference mulberry32 sequence', () => {
    for (const seed of [0, 1, 42, 0xffff_ffff]) {
      const reference = referenceMulberry32(seed);
      const rng = new Prng(seed);
      for (let index = 0; index < 1000; index++) expect(rng.next()).toBe(reference());
    }
  });

  it('repeats the sequence for the same seed and diverges for another one', () => {
    const draw = (seed: number) => {
      const rng = new Prng(seed);
      return Array.from({ length: 8 }, () => rng.uint32());
    };
    expect(draw(7)).toEqual(draw(7));
    expect(draw(7)).not.toEqual(draw(8));
  });

  it('keeps numbers in their ranges', () => {
    const rng = new Prng(3);
    for (let index = 0; index < 10_000; index++) {
      const unit = rng.next();
      expect(unit).toBeGreaterThanOrEqual(0);
      expect(unit).toBeLessThan(1);
      const int = rng.int(5, 9);
      expect(int).toBeGreaterThanOrEqual(5);
      expect(int).toBeLessThan(9);
      expect(Number.isInteger(int)).toBe(true);
    }
  });

  it('draws normal deviates with mean 0 and standard deviation 1', () => {
    const rng = new Prng(11);
    const samples = Array.from({ length: 20_000 }, () => rng.normal());
    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length;
    expect(mean).toBeCloseTo(0, 1);
    expect(Math.sqrt(variance)).toBeCloseTo(1, 1);
    expect(samples.every(Number.isFinite)).toBe(true);
  });

  it('honours the probability of chance()', () => {
    const rng = new Prng(5);
    expect(rng.chance(0)).toBe(false);
    expect(rng.chance(1)).toBe(true);
    const hits = Array.from({ length: 10_000 }, () => rng.chance(0.3)).filter(Boolean).length;
    expect(hits / 10_000).toBeCloseTo(0.3, 1);
  });

  it('picks every item of a list and refuses an empty one', () => {
    const rng = new Prng(9);
    const seen = new Set(Array.from({ length: 200 }, () => rng.pick(['a', 'b', 'c'])));
    expect([...seen].sort()).toEqual(['a', 'b', 'c']);
    expect(() => rng.pick([])).toThrow(RangeError);
  });

  it('builds lowercase hex strings of the requested length', () => {
    const rng = new Prng(13);
    expect(rng.hex(32)).toMatch(/^[0-9a-f]{32}$/);
    expect(rng.hex(4)).toMatch(/^[0-9a-f]{4}$/);
  });
});

describe('hash32', () => {
  it('is a deterministic unsigned 32-bit hash of both arguments', () => {
    expect(hash32(42, 3)).toBe(hash32(42, 3));
    expect(hash32(42, 3)).not.toBe(hash32(42, 4));
    expect(hash32(42, 3)).not.toBe(hash32(43, 3));
    expect(hash32(1, 2)).toBeGreaterThanOrEqual(0);
    expect(hash32(1, 2)).toBeLessThanOrEqual(0xffff_ffff);
  });
});
