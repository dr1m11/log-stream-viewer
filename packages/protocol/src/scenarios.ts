/**
 * Traffic patterns the mock server can generate:
 * - `steady` — a constant rate with a realistic level mix;
 * - `error-burst` — one service periodically emits a burst of errors;
 * - `traffic-spike` — the rate periodically jumps several times above the requested one.
 */
export const SCENARIOS = ['steady', 'error-burst', 'traffic-spike'] as const;

/** Name of a generator scenario. */
export type Scenario = (typeof SCENARIOS)[number];

/** Scenario used when the client does not ask for one. */
export const DEFAULT_SCENARIO: Scenario = 'steady';

const KNOWN_SCENARIOS: readonly unknown[] = SCENARIOS;

/** Tells whether a value is one of {@link SCENARIOS}. */
export function isScenario(value: unknown): value is Scenario {
  return KNOWN_SCENARIOS.includes(value);
}
