import { BATCH_INTERVAL_MS } from '@lsv/protocol';

/**
 * After the event loop stalls, a tick generates at most this many ticks' worth of events; the
 * rest of the backlog is never generated (no `seq` gap — the stream simply had a slower moment).
 */
export const CATCH_UP_TICKS = 2;

/** Rate accounting of one stream (or of the global budget). Immutable. */
export interface SchedulerState {
  /** Target events per second. */
  readonly rate: number;
  /** Clock reading of the previous step, epoch ms. */
  readonly lastAt: number;
  /**
   * Thousandths of an event carried over to the next step, in `[0, 1000)`. Counting in
   * events × 1000 (`rate × elapsed ms`) keeps the arithmetic in integers, so rates are met exactly.
   */
  readonly carry: number;
}

/** Outcome of one scheduler step. */
export interface DueEvents {
  /** Whole events to generate now. */
  readonly count: number;
  readonly state: SchedulerState;
}

/** A scheduler that starts counting at `now`. */
export function createScheduler(rate: number, now: number): SchedulerState {
  return { rate, lastAt: now, carry: 0 };
}

/** The same scheduler with another target rate; the carry is kept. */
export function withRate(state: SchedulerState, rate: number): SchedulerState {
  return rate === state.rate ? state : { ...state, rate };
}

/**
 * How many events are due at `now`: `rate × elapsed` plus the fraction carried from the previous
 * step, so that a rate such as 333/s is met exactly over time. A step never yields more than
 * {@link CATCH_UP_TICKS} ticks' worth (at least one event), and a clock that goes backwards
 * yields nothing. Pure.
 */
export function eventsDue(state: SchedulerState, now: number): DueEvents {
  const elapsed = Math.max(0, now - state.lastAt);
  const milli = state.rate * elapsed + state.carry;
  const capMilli = Math.max(1000, state.rate * BATCH_INTERVAL_MS * CATCH_UP_TICKS);
  const lastAt = Math.max(state.lastAt, now);
  if (milli > capMilli) {
    return { count: Math.floor(capMilli / 1000), state: { rate: state.rate, lastAt, carry: 0 } };
  }
  const count = Math.floor(milli / 1000);
  return { count, state: { rate: state.rate, lastAt, carry: milli - count * 1000 } };
}
