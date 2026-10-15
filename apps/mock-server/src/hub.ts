import { EventBudget } from './budget.ts';

/** What the hub needs from a stream; `Session` implements it. */
export interface Stream {
  /** Events the stream wants at `now`. */
  due(now: number): number;
  /** Sends up to `granted` events; returns how many were sent. */
  flush(now: number, granted: number): number;
}

/** Called once for a stream that threw during a tick; the hub has already dropped it. */
export type StreamErrorHandler<S> = (stream: S, error: unknown) => void;

/** Window over which `/healthz` measures the event rate. */
const RATE_WINDOW_MS = 1000;

/**
 * Drives all open streams from one clock tick: asks each for its due events, splits the global
 * budget fairly among them and lets each flush its share. A stream that throws is removed and
 * reported once, so one broken session cannot stop the others. Pure: the server owns the timer.
 */
export class StreamHub<S extends Stream = Stream> {
  readonly #streams = new Set<S>();
  readonly #budget: EventBudget;
  readonly #onError: StreamErrorHandler<S>;
  #windowStart: number;
  #windowEvents = 0;
  #eventsPerSec = 0;

  constructor(globalMaxEventsPerSec: number, now: number, onError: StreamErrorHandler<S>) {
    this.#budget = new EventBudget(globalMaxEventsPerSec, now);
    this.#windowStart = now;
    this.#onError = onError;
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
    const demands = streams.map((stream) => this.#guard(stream, 0, () => stream.due(now)));
    const grants = this.#budget.allocate(demands, now);
    let sent = 0;
    streams.forEach((stream, index) => {
      if (!this.#streams.has(stream)) return;
      const granted = grants[index] ?? 0;
      sent += this.#guard(stream, 0, () => stream.flush(now, granted));
    });
    this.#measure(now, sent);
    return sent;
  }

  /** Events sent per second over the last complete window; 0 when no tick ran lately. */
  eventsPerSec(now: number): number {
    return now - this.#windowStart > 2 * RATE_WINDOW_MS ? 0 : this.#eventsPerSec;
  }

  #guard(stream: S, fallback: number, run: () => number): number {
    try {
      return run();
    } catch (error) {
      this.#streams.delete(stream);
      this.#onError(stream, error);
      return fallback;
    }
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
