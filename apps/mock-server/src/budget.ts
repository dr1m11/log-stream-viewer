import { createScheduler, eventsDue, type SchedulerState } from './scheduler.ts';

/**
 * Max–min fair split of `available` events among sessions that want `demands` events: nobody gets
 * more than asked, small demands are met in full, and the rest is shared equally by the larger
 * ones. Pure.
 */
export function shareFairly(demands: readonly number[], available: number): number[] {
  let total = 0;
  for (const demand of demands) total += demand;
  if (total <= available) return demands.slice();

  // Water filling from the smallest demand up. Each session takes at most an equal share of what
  // is left; what it leaves (including the rounding of the share) passes to the larger demands,
  // and the largest one absorbs the rest, so the whole budget is used.
  const grants = demands.map(() => 0);
  const demandAt = (index: number): number => demands[index] ?? 0;
  const order = demands.map((_, index) => index).sort((a, b) => demandAt(a) - demandAt(b));
  let remaining = Math.max(0, Math.floor(available));
  order.forEach((index, position) => {
    const share = Math.floor(remaining / (order.length - position));
    const grant = Math.min(demandAt(index), share);
    grants[index] = grant;
    remaining -= grant;
  });
  return grants;
}

/**
 * Server-wide ceiling on generated events per second (`GLOBAL_MAX_EVENTS_PER_SEC`), shared by all
 * sessions. It refills with the clock like a stream scheduler; budget a tick does not use is not
 * saved for later, so the server never bursts above the ceiling.
 */
export class EventBudget {
  #state: SchedulerState;

  constructor(eventsPerSec: number, now: number) {
    this.#state = createScheduler(eventsPerSec, now);
  }

  get eventsPerSec(): number {
    return this.#state.rate;
  }

  /** Splits the budget of the tick ending at `now` among the sessions' `demands`. */
  allocate(demands: readonly number[], now: number): number[] {
    const due = eventsDue(this.#state, now);
    this.#state = due.state;
    return shareFairly(demands, due.count);
  }
}
