import type { LogStreamSnapshot } from './log-stream-store';

/** The part of a snapshot the pause arithmetic reads. */
export type PauseRange = Pick<LogStreamSnapshot, 'start' | 'end' | 'paused'>;

/**
 * The position after the last row the table shows: `end` while following the stream; while paused,
 * the pause point, so no new row appears. `start` stays live — eviction still removes the oldest
 * rows — and the result never falls below it: once eviction passes the pause point the paused
 * view is empty.
 */
export function shownEnd({ start, end, paused }: PauseRange): number {
  if (paused === undefined) return end;
  return Math.max(start, Math.min(end, paused.end));
}

/** Events received since the view was paused (0 unless paused), evicted ones included. */
export function eventsSincePause({ end, paused }: PauseRange): number {
  return paused === undefined ? 0 : end - paused.end;
}

/**
 * Events the buffer evicted since the view was paused (0 unless paused): rows the user could have
 * scrolled to when pausing, then — if eviction passed the pause point — events received during
 * the pause. More than 0 means resuming no longer shows every event of the pause.
 */
export function evictedSincePause({ start, paused }: PauseRange): number {
  return paused === undefined ? 0 : Math.max(0, start - paused.start);
}
