import type { StreamLimits } from '@lsv/protocol';

/** The rate bounds of a deployment, from `hello.limits`. */
export type RateBounds = Pick<StreamLimits, 'minRate' | 'maxRate'>;

/**
 * Positions of the rate slider: `0` is `minRate`, `RATE_SLIDER_STEPS` is `maxRate`. One arrow key
 * moves the rate by a constant factor — about 6% for production's 10…5,000 events/s, 8% for the
 * local server's 10…20,000 — so a keyboard user crosses the range in 100 presses (Home and End
 * jump to the bounds); the number input next to the slider takes exact values.
 */
export const RATE_SLIDER_STEPS = 100;

/** `rate` as a whole number of events per second inside the bounds. */
export function clampRate(rate: number, { minRate, maxRate }: RateBounds): number {
  return Math.min(maxRate, Math.max(minRate, Math.round(rate)));
}

/**
 * The rate at a slider position, on a logarithmic scale: equal slider distances are equal ratios,
 * so 10…100 gets as much travel as 1,000…10,000 instead of a few pixels at the left end of a
 * linear 10…20,000 track. Rounded to two significant digits (1,200, not 1,237) except at the
 * bounds, which are exact.
 */
export function sliderPositionToRate(position: number, bounds: RateBounds): number {
  const { minRate, maxRate } = bounds;
  const low = logFloor(bounds);
  if (position <= 0 || maxRate <= low) return minRate;
  if (position >= RATE_SLIDER_STEPS) return maxRate;
  const rate = low * (maxRate / low) ** (position / RATE_SLIDER_STEPS);
  return clampRate(roundToSignificantDigits(rate, 2), bounds);
}

/**
 * The slider position closest to `rate` (the inverse of {@link sliderPositionToRate}). Several
 * positions can round to the same rate near the low end, so the slider keeps the position the
 * user chose while it still maps to the shown rate, instead of snapping back to this one.
 */
export function rateToSliderPosition(rate: number, bounds: RateBounds): number {
  const low = logFloor(bounds);
  if (bounds.maxRate <= low || rate <= low) return 0;
  const position = Math.round(
    (RATE_SLIDER_STEPS * Math.log(rate / low)) / Math.log(bounds.maxRate / low),
  );
  return Math.min(RATE_SLIDER_STEPS, Math.max(0, position));
}

/** The bottom of the logarithmic scale: `minRate`, but at least 1 (a log scale cannot reach 0). */
function logFloor({ minRate }: RateBounds): number {
  return Math.max(minRate, 1);
}

function roundToSignificantDigits(value: number, digits: number): number {
  const magnitude = 10 ** Math.max(0, Math.floor(Math.log10(value)) - digits + 1);
  return Math.round(value / magnitude) * magnitude;
}
