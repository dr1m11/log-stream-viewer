/**
 * Token bucket: allows bursts of `burst` actions and `ratePerSec` actions per second sustained.
 * Pure — time comes in as an argument.
 */
export class TokenBucket {
  readonly #ratePerMs: number;
  readonly #burst: number;
  #tokens: number;
  #lastAt: number;

  constructor(ratePerSec: number, burst: number, now: number) {
    this.#ratePerMs = ratePerSec / 1000;
    this.#burst = burst;
    this.#tokens = burst;
    this.#lastAt = now;
  }

  /** Takes one token at `now`; `false` when the bucket is empty (the action is over the limit). */
  take(now: number): boolean {
    const elapsed = Math.max(0, now - this.#lastAt);
    this.#lastAt = Math.max(this.#lastAt, now);
    this.#tokens = Math.min(this.#burst, this.#tokens + elapsed * this.#ratePerMs);
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}
