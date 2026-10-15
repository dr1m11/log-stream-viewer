const UINT32_RANGE = 0x1_0000_0000;

/**
 * Seeded pseudo-random generator (mulberry32): fast, 32-bit state, good enough statistics for
 * test data. The only source of randomness of the generator, so a seed reproduces a stream.
 */
export class Prng {
  #state: number;

  /** @param seed any number; only its unsigned 32-bit value is used. */
  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  /** Next unsigned 32-bit integer. */
  uint32(): number {
    this.#state = (this.#state + 0x6d2b79f5) | 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Next number in `[0, 1)`. */
  next(): number {
    return this.uint32() / UINT32_RANGE;
  }

  /** Integer in `[min, max)`. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min));
  }

  /** `true` with the given probability. */
  chance(probability: number): boolean {
    return this.next() < probability;
  }

  /** A uniformly chosen item of a non-empty list. */
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length)];
    if (item === undefined) throw new RangeError('Cannot pick from an empty list');
    return item;
  }

  /** Standard normal deviate (Box–Muller). */
  normal(): number {
    // 1 - next() is in (0, 1], so the logarithm stays finite.
    const radius = Math.sqrt(-2 * Math.log(1 - this.next()));
    return radius * Math.cos(2 * Math.PI * this.next());
  }

  /** Lowercase hex string of `length` characters (a multiple of 8 is cheapest). */
  hex(length: number): string {
    let text = '';
    while (text.length < length) text += this.uint32().toString(16).padStart(8, '0');
    return text.slice(0, length);
  }
}

/** Stateless 32-bit hash of two integers, for choices that must not consume the main sequence. */
export function hash32(a: number, b: number): number {
  return new Prng(a ^ Math.imul(b, 0x9e3779b9)).uint32();
}
