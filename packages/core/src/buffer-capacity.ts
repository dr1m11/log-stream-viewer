/**
 * Bounds of the event buffer, in events (docs/adr/0006). The worker and the main thread size their
 * stores from the same clamped value, so both keep identical positions.
 */

/** Events kept when the user does not ask for another capacity (`?buffer=`). */
export const DEFAULT_BUFFER_CAPACITY = 100_000;
/** Smallest capacity: below it a burst of a few batches would evict rows while they are on screen. */
export const MIN_BUFFER_CAPACITY = 1_000;
/** Largest capacity: about 150 MB of columns and strings on the main thread (docs/adr/0006). */
export const MAX_BUFFER_CAPACITY = 1_000_000;

/**
 * A requested capacity as a whole number of events within
 * [{@link MIN_BUFFER_CAPACITY}, {@link MAX_BUFFER_CAPACITY}]. Values that are not numbers at all
 * (`NaN`, e.g. an unparsable `?buffer=`) fall back to {@link DEFAULT_BUFFER_CAPACITY}.
 */
export function clampBufferCapacity(requested: number): number {
  if (Number.isNaN(requested)) return DEFAULT_BUFFER_CAPACITY;
  return Math.min(MAX_BUFFER_CAPACITY, Math.max(MIN_BUFFER_CAPACITY, Math.floor(requested)));
}
