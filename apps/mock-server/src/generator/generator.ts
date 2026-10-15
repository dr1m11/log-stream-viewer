import { LOG_LEVELS, type LogEvent, type LogLevel, type Scenario } from '@lsv/protocol';

import { Prng } from './prng.ts';
import { ERROR_BURST, scenarioPhase } from './scenarios.ts';
import { type Draft, SERVICES } from './services.ts';

/** Share of each level in calm traffic (an error burst adds errors for one service on top). */
export const LEVEL_MIX: Readonly<Record<LogLevel, number>> = {
  trace: 0.08,
  debug: 0.2,
  info: 0.55,
  warn: 0.12,
  error: 0.045,
  fatal: 0.005,
};

/** Recent trace ids kept for reuse, so that one request shows up in several services. */
const TRACE_POOL_SIZE = 32;
/** Probability that a traced event continues a recent trace instead of starting a new one. */
const TRACE_REUSE = 0.35;

export interface GeneratorOptions {
  /** PRNG seed: the same seed, scenario and calls reproduce the same events. */
  readonly seed: number;
  readonly scenario: Scenario;
  /** Origin of the scenario clock, epoch ms; defaults to the `now` of the first call. */
  readonly startedAt?: number;
}

/**
 * Deterministic source of one stream's log events. Pure: randomness comes from the seeded PRNG,
 * time only from the `now` arguments.
 */
export interface LogGenerator {
  /** Highest `seq` assigned so far, generated or skipped; 0 before the first event. */
  readonly lastSeq: number;
  readonly scenario: Scenario;
  /**
   * Generates the next `count` events with consecutive `seq`, timestamps spread evenly between
   * the previous call and `now`.
   */
  next(count: number, now: number): LogEvent[];
  /** Assigns `count` sequence numbers without generating the events (they are dropped). */
  skip(count: number, now: number): void;
  /** Switches the scenario; its periodic windows start over at `now`. */
  setScenario(scenario: Scenario, now: number): void;
  /** Factor the scenario applies to the requested rate at `now` (e.g. 5 during a traffic spike). */
  rateMultiplier(now: number): number;
}

type MutableEvent = { -readonly [K in keyof LogEvent]: LogEvent[K] };

/** Cumulative thresholds for picking an index by weight with one uniform draw. */
function cumulative(weights: readonly number[]): Float64Array {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const thresholds = new Float64Array(weights.length);
  let running = 0;
  weights.forEach((weight, index) => {
    running += weight / total;
    thresholds[index] = running;
  });
  return thresholds;
}

function pickIndex(thresholds: Float64Array, draw: number): number {
  const last = thresholds.length - 1;
  for (let index = 0; index < last; index++) {
    if (draw < (thresholds[index] ?? 1)) return index;
  }
  return last;
}

const LEVEL_THRESHOLDS = cumulative(LOG_LEVELS.map((level) => LEVEL_MIX[level]));
const SERVICE_THRESHOLDS = cumulative(SERVICES.map((service) => service.weight));

class SeededLogGenerator implements LogGenerator {
  readonly #seed: number;
  readonly #rng: Prng;
  readonly #hosts: readonly (readonly string[])[];
  readonly #draft: Draft = { message: '', payload: undefined };
  readonly #recentTraces: string[] = [];
  #nextTraceSlot = 0;
  #scenario: Scenario;
  #scenarioStart: number | undefined;
  #lastAt: number | undefined;
  #lastSeq = 0;

  constructor(options: GeneratorOptions) {
    this.#seed = options.seed;
    this.#rng = new Prng(options.seed);
    this.#scenario = options.scenario;
    this.#scenarioStart = options.startedAt;
    this.#lastAt = options.startedAt;
    const rng = this.#rng;
    this.#hosts = SERVICES.map((service) => {
      const id = rng.hex(4);
      return Array.from(
        { length: service.instances },
        (_, index) => `${service.name}-${id}-${String(index + 1)}`,
      );
    });
  }

  get lastSeq(): number {
    return this.#lastSeq;
  }

  get scenario(): Scenario {
    return this.#scenario;
  }

  next(count: number, now: number): LogEvent[] {
    const from = this.#advance(now);
    const span = Math.max(0, now - from);
    const phase = scenarioPhase(
      this.#scenario,
      now - this.#start(now),
      this.#seed,
      SERVICES.length,
    );
    const rng = this.#rng;
    const draft = this.#draft;
    const events: LogEvent[] = [];
    for (let index = 0; index < count; index++) {
      const serviceIndex = pickIndex(SERVICE_THRESHOLDS, rng.next());
      const service = SERVICES[serviceIndex];
      const hosts = this.#hosts[serviceIndex];
      if (service === undefined || hosts === undefined) throw new RangeError('Unknown service');
      let level = LOG_LEVELS[pickIndex(LEVEL_THRESHOLDS, rng.next())] ?? 'info';
      if (phase.burstService === serviceIndex && rng.chance(ERROR_BURST.errorShare)) {
        level = 'error';
      }
      rng.pick(service.templates[level])(rng, phase, draft);
      const event: MutableEvent = {
        seq: ++this.#lastSeq,
        ts: from + Math.round((span * (index + 1)) / count),
        level,
        service: service.name,
        host: rng.pick(hosts),
        message: draft.message,
      };
      if (rng.chance(service.tracedShare)) event.traceId = this.#traceId();
      if (draft.payload !== undefined) event.payload = draft.payload;
      events.push(event);
    }
    return events;
  }

  skip(count: number, now: number): void {
    this.#advance(now);
    this.#lastSeq += Math.max(0, count);
  }

  setScenario(scenario: Scenario, now: number): void {
    this.#scenario = scenario;
    this.#scenarioStart = now;
  }

  rateMultiplier(now: number): number {
    const elapsed = now - this.#start(now);
    return scenarioPhase(this.#scenario, elapsed, this.#seed, SERVICES.length).rateMultiplier;
  }

  /** Moves the generator clock to `now`; returns where the previous call left it. */
  #advance(now: number): number {
    const from = this.#lastAt ?? now;
    this.#lastAt = Math.max(from, now);
    return from;
  }

  #start(now: number): number {
    this.#scenarioStart ??= now;
    return this.#scenarioStart;
  }

  #traceId(): string {
    const rng = this.#rng;
    const recent = this.#recentTraces;
    if (recent.length > 0 && rng.chance(TRACE_REUSE)) return rng.pick(recent);
    const id = rng.hex(32);
    recent[this.#nextTraceSlot] = id;
    this.#nextTraceSlot = (this.#nextTraceSlot + 1) % TRACE_POOL_SIZE;
    return id;
  }
}

/** Creates the event source of one stream. */
export function createGenerator(options: GeneratorOptions): LogGenerator {
  return new SeededLogGenerator(options);
}
