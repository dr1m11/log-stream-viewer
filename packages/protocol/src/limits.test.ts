import { describe, expect, it } from 'vitest';

import {
  BATCH_INTERVAL_MS,
  DEFAULT_RATE,
  HEARTBEAT_INTERVAL_MS,
  MAX_SEED,
  MIN_RATE,
  PROTOCOL_VERSION,
} from './limits.ts';

describe('protocol limits', () => {
  it('is protocol version 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('defaults to a rate the floor allows', () => {
    expect(DEFAULT_RATE).toBeGreaterThanOrEqual(MIN_RATE);
  });

  it('sends heartbeats on a batch tick boundary', () => {
    expect(HEARTBEAT_INTERVAL_MS % BATCH_INTERVAL_MS).toBe(0);
  });

  it('uses unsigned 32-bit seeds', () => {
    expect(MAX_SEED).toBe(2 ** 32 - 1);
  });
});
