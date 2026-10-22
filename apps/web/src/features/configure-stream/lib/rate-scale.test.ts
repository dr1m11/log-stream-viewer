import { describe, expect, it } from 'vitest';

import {
  clampRate,
  RATE_SLIDER_STEPS,
  rateToSliderPosition,
  sliderPositionToRate,
} from './rate-scale';

const PRODUCTION = { minRate: 10, maxRate: 5000 };
const LOCAL = { minRate: 10, maxRate: 20_000 };

describe('clampRate', () => {
  it('rounds to whole events per second and keeps the rate inside the bounds', () => {
    expect(clampRate(1234.6, LOCAL)).toBe(1235);
    expect(clampRate(999_999, LOCAL)).toBe(20_000);
    expect(clampRate(0, PRODUCTION)).toBe(10);
  });
});

describe('sliderPositionToRate', () => {
  it('maps the ends of the track to the exact bounds', () => {
    expect(sliderPositionToRate(0, PRODUCTION)).toBe(10);
    expect(sliderPositionToRate(RATE_SLIDER_STEPS, PRODUCTION)).toBe(5000);
    expect(sliderPositionToRate(RATE_SLIDER_STEPS, { minRate: 10, maxRate: 12_345 })).toBe(12_345);
    expect(sliderPositionToRate(-5, LOCAL)).toBe(10);
    expect(sliderPositionToRate(RATE_SLIDER_STEPS + 5, LOCAL)).toBe(20_000);
  });

  it('spreads the range logarithmically: the middle of 10…1,000 is 100', () => {
    expect(sliderPositionToRate(RATE_SLIDER_STEPS / 2, { minRate: 10, maxRate: 1000 })).toBe(100);
    expect(sliderPositionToRate(RATE_SLIDER_STEPS / 4, { minRate: 10, maxRate: 10_000 })).toBe(56);
  });

  it('rounds to two significant digits and never decreases along the track', () => {
    const rates = Array.from({ length: RATE_SLIDER_STEPS + 1 }, (_, position) =>
      sliderPositionToRate(position, LOCAL),
    );

    expect(rates).toEqual(rates.toSorted((a, b) => a - b));
    const inside = rates.slice(1, -1);
    expect(inside.map((rate) => Number(rate.toPrecision(2)))).toEqual(inside);
  });

  it('copes with a minimum of 0 and with equal bounds', () => {
    expect(sliderPositionToRate(0, { minRate: 0, maxRate: 100 })).toBe(0);
    expect(sliderPositionToRate(RATE_SLIDER_STEPS / 2, { minRate: 0, maxRate: 100 })).toBe(10);
    expect(sliderPositionToRate(RATE_SLIDER_STEPS / 2, { minRate: 50, maxRate: 50 })).toBe(50);
  });
});

describe('rateToSliderPosition', () => {
  it('inverts the scale and clamps rates outside the bounds', () => {
    for (const position of [0, 13, 50, 87, RATE_SLIDER_STEPS]) {
      const rate = sliderPositionToRate(position, PRODUCTION);
      expect(Math.abs(rateToSliderPosition(rate, PRODUCTION) - position)).toBeLessThanOrEqual(1);
    }
    expect(rateToSliderPosition(1, PRODUCTION)).toBe(0);
    expect(rateToSliderPosition(1_000_000, PRODUCTION)).toBe(RATE_SLIDER_STEPS);
    expect(rateToSliderPosition(50, { minRate: 50, maxRate: 50 })).toBe(0);
  });
});
