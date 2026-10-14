import { EventBudget } from './budget.ts';

/** What the hub needs from a stream; `Session` implements it. */
export interface Stream {
  /** Events the stream wants at `now`. */
  due(now: number): number;
  /** Sends up to `granted` events; returns how many were sent. */
  flush(now: number, granted: number): number;
}

/** Window over which `/healthz` measures the event rate. */
const RATE_WINDOW_MS = 1000;

/**
 * Drives all open streams from one clock tick: asks each for its due events, splits the global
 * budget fairly among them and lets each flush its share. Pure: the server owns the timer.
 */
export class StreamHub<S extends Stream = Stream> {
  readonly #streams = new Set<S>();
  readonly #budget: EventBudget;
  #windowStart: number;
  #windowEvents = 0;
  #eventsPerSec = 0;

  constructor(globalMaxEventsPerSec: number, now: number) {
    this.#budget = new EventBudget(globalMaxEventsPerSec, now);
    this.#windowStart = now;
  }

  get size(): number {
    return this.#streams.size;
  }

  add(stream: S): void {
    this.#streams.add(stream);
  }

  remove(stream: S): void {
    this.#streams.delete(stream);
  }

  /** The open streams (a snapshot, safe to modify the hub while iterating). */
  streams(): S[] {
    return [...this.#streams];
  }

  /** One tick: every stream gets its fair share of the budget. Returns the events sent. */
  tick(now: number): number {
    const streams = this.streams();
    const demands = streams.map((stream) => stream.due(now));
    const grants = this.#budget.allocate(demands, now);
    let sent = 0;
    streams.forEach((stream, index) => {
      sent += stream.flush(now, grants[index] ?? 0);
    });
    this.#measure(now, sent);
    return sent;
  }

  /** Events sent per second over the last complete window; 0 when no tick ran lately. */
  eventsPerSec(now: number): number {
    return now - this.#windowStart > 2 * RATE_WINDOW_MS ? 0 : this.#eventsPerSec;
  }

  #measure(now: number, sent: number): void {
    this.#windowEvents += sent;
    const elapsed = now - this.#windowStart;
    if (elapsed < RATE_WINDOW_MS) return;
    this.#eventsPerSec = Math.round((this.#windowEvents * 1000) / elapsed);
    this.#windowStart = now;
    this.#windowEvents = 0;
  }
}
