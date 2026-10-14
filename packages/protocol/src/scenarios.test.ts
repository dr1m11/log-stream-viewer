import { describe, expect, it } from 'vitest';

import { DEFAULT_SCENARIO, isScenario, SCENARIOS } from './scenarios.ts';

describe('scenarios', () => {
  it.each(SCENARIOS)('recognizes "%s"', (scenario) => {
    expect(isScenario(scenario)).toBe(true);
  });

  it.each(['deploy', 'Steady', 'error_burst', '', null, undefined, 1])('rejects %j', (value) => {
    expect(isScenario(value)).toBe(false);
  });

  it('defaults to a known scenario', () => {
    expect(isScenario(DEFAULT_SCENARIO)).toBe(true);
  });
});
