import { assertNever, type Scenario } from '@lsv/protocol';

import { hash32 } from './prng.ts';

/** What a scenario changes at a moment of the stream. */
export interface ScenarioPhase {
  /** Factor applied to the requested rate (`traffic-spike`). */
  readonly rateMultiplier: number;
  /** Index (into the service list) of the service in an error burst, if one is running. */
  readonly burstService: number | undefined;
  /** Factor applied to request latencies. */
  readonly latencyFactor: number;
}

/**
 * `error-burst`: in every period one service, chosen by the seed, logs about 30% errors during the
 * burst window. The first burst starts a few seconds after the scenario is selected.
 */
export const ERROR_BURST = {
  periodMs: 45_000,
  startMs: 5_000,
  durationMs: 20_000,
  /** Probability that an event of the bursting service is turned into an error. */
  errorShare: 0.3,
} as const;

/** `traffic-spike`: in every period the rate jumps five-fold for the spike window. */
export const TRAFFIC_SPIKE = {
  periodMs: 30_000,
  startMs: 5_000,
  durationMs: 10_000,
  rateMultiplier: 5,
  /** A loaded system answers slower. */
  latencyFactor: 2,
} as const;

const CALM: ScenarioPhase = { rateMultiplier: 1, burstService: undefined, latencyFactor: 1 };
const SPIKE: ScenarioPhase = {
  rateMultiplier: TRAFFIC_SPIKE.rateMultiplier,
  burstService: undefined,
  latencyFactor: TRAFFIC_SPIKE.latencyFactor,
};

/** Where `elapsedMs` falls in a periodic window: the period index, or -1 outside the window. */
function windowIndex(
  elapsedMs: number,
  window: { readonly periodMs: number; readonly startMs: number; readonly durationMs: number },
): number {
  if (elapsedMs < 0) return -1;
  const offset = elapsedMs % window.periodMs;
  const inWindow = offset >= window.startMs && offset < window.startMs + window.durationMs;
  return inWindow ? Math.floor(elapsedMs / window.periodMs) : -1;
}

/**
 * The phase of a scenario `elapsedMs` after it was selected. Pure: the same scenario, time and
 * seed always give the same phase.
 * @param serviceCount number of services a burst can pick from
 */
export function scenarioPhase(
  scenario: Scenario,
  elapsedMs: number,
  seed: number,
  serviceCount: number,
): ScenarioPhase {
  switch (scenario) {
    case 'steady':
      return CALM;
    case 'error-burst': {
      const burst = windowIndex(elapsedMs, ERROR_BURST);
      if (burst < 0) return CALM;
      return { ...CALM, burstService: hash32(seed, burst) % serviceCount };
    }
    case 'traffic-spike':
      return windowIndex(elapsedMs, TRAFFIC_SPIKE) < 0 ? CALM : SPIKE;
    default:
      return assertNever(scenario);
  }
}
