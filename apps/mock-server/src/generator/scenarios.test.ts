import { describe, expect, it } from 'vitest';

import { ERROR_BURST, scenarioPhase, TRAFFIC_SPIKE } from './scenarios.ts';

const SERVICES = 6;

describe('scenarioPhase', () => {
  it('keeps steady traffic calm at all times', () => {
    for (const elapsed of [0, 7_000, 60_000, 3_600_000]) {
      expect(scenarioPhase('steady', elapsed, 42, SERVICES)).toEqual({
        rateMultiplier: 1,
        burstService: undefined,
        latencyFactor: 1,
      });
    }
  });

  it('runs an error burst in the window of every period', () => {
    const { periodMs, startMs, durationMs } = ERROR_BURST;
    const at = (elapsed: number) => scenarioPhase('error-burst', elapsed, 42, SERVICES);
    expect(at(0).burstService).toBeUndefined();
    expect(at(startMs - 1).burstService).toBeUndefined();
    expect(at(startMs).burstService).toBeTypeOf('number');
    expect(at(startMs + durationMs - 1).burstService).toBeTypeOf('number');
    expect(at(startMs + durationMs).burstService).toBeUndefined();
    expect(at(periodMs + startMs).burstService).toBeTypeOf('number');
    expect(at(startMs).rateMultiplier).toBe(1);
  });

  it('picks the bursting service from the seed and the period', () => {
    const { periodMs, startMs } = ERROR_BURST;
    const services = (seed: number) =>
      Array.from(
        { length: 24 },
        (_, period) =>
          scenarioPhase('error-burst', period * periodMs + startMs, seed, SERVICES).burstService,
      );
    expect(services(42)).toEqual(services(42));
    expect(services(42)).not.toEqual(services(7));
    expect(new Set(services(42)).size).toBeGreaterThan(1);
    for (const service of services(42)) {
      expect(service).toBeGreaterThanOrEqual(0);
      expect(service).toBeLessThan(SERVICES);
    }
  });

  it('multiplies the rate during a traffic spike only', () => {
    const { periodMs, startMs, durationMs, rateMultiplier, latencyFactor } = TRAFFIC_SPIKE;
    const at = (elapsed: number) => scenarioPhase('traffic-spike', elapsed, 1, SERVICES);
    expect(at(startMs - 1).rateMultiplier).toBe(1);
    expect(at(startMs)).toMatchObject({ rateMultiplier, latencyFactor });
    expect(at(startMs + durationMs - 1).rateMultiplier).toBe(rateMultiplier);
    expect(at(startMs + durationMs).rateMultiplier).toBe(1);
    expect(at(2 * periodMs + startMs + 1).rateMultiplier).toBe(rateMultiplier);
  });

  it('treats a time before the scenario start as calm', () => {
    expect(scenarioPhase('traffic-spike', -1, 1, SERVICES).rateMultiplier).toBe(1);
    expect(scenarioPhase('error-burst', -1, 1, SERVICES).burstService).toBeUndefined();
  });
});
