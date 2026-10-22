import { describe, expect, it } from 'vitest';

import {
  clampBufferCapacity,
  DEFAULT_BUFFER_CAPACITY,
  MAX_BUFFER_CAPACITY,
  MIN_BUFFER_CAPACITY,
} from './buffer-capacity.ts';

describe('clampBufferCapacity', () => {
  it('keeps a capacity within the bounds', () => {
    expect(clampBufferCapacity(250_000)).toBe(250_000);
    expect(clampBufferCapacity(MIN_BUFFER_CAPACITY)).toBe(MIN_BUFFER_CAPACITY);
    expect(clampBufferCapacity(MAX_BUFFER_CAPACITY)).toBe(MAX_BUFFER_CAPACITY);
  });

  it('clamps to the bounds', () => {
    expect(clampBufferCapacity(10)).toBe(MIN_BUFFER_CAPACITY);
    expect(clampBufferCapacity(-5)).toBe(MIN_BUFFER_CAPACITY);
    expect(clampBufferCapacity(5_000_000)).toBe(MAX_BUFFER_CAPACITY);
    expect(clampBufferCapacity(Number.POSITIVE_INFINITY)).toBe(MAX_BUFFER_CAPACITY);
  });

  it('rounds a fractional capacity down to whole events', () => {
    expect(clampBufferCapacity(12_345.9)).toBe(12_345);
  });

  it('falls back to the default for a value that is not a number', () => {
    expect(clampBufferCapacity(Number.NaN)).toBe(DEFAULT_BUFFER_CAPACITY);
  });

  it('has a default within the bounds', () => {
    expect(clampBufferCapacity(DEFAULT_BUFFER_CAPACITY)).toBe(DEFAULT_BUFFER_CAPACITY);
  });
});
