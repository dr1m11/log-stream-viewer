import { describe, expect, it } from 'vitest';

import {
  busyCloseReason,
  CLOSE_CODES,
  isTerminalCloseCode,
  MAX_RETRY_AFTER_SECONDS,
  retryAfterSeconds,
} from './close-codes.ts';

describe('close codes', () => {
  it('keeps application codes in the 4000–4999 range reserved for applications', () => {
    const appCodes = [CLOSE_CODES.sessionExpired, CLOSE_CODES.unsupportedVersion, CLOSE_CODES.busy];
    expect(appCodes).toEqual([4000, 4001, 4029]);
  });

  it.each([CLOSE_CODES.sessionExpired, CLOSE_CODES.unsupportedVersion])(
    'treats %i as terminal: no automatic reconnect',
    (code) => {
      expect(isTerminalCloseCode(code)).toBe(true);
    },
  );

  it.each([
    CLOSE_CODES.normal,
    CLOSE_CODES.goingAway,
    CLOSE_CODES.policyViolation,
    CLOSE_CODES.messageTooBig,
    CLOSE_CODES.busy,
    1006,
    1011,
    4999,
  ])('lets the client reconnect with backoff after %i', (code) => {
    expect(isTerminalCloseCode(code)).toBe(false);
  });
});

describe('busy close reason', () => {
  it('carries the retry delay in whole seconds', () => {
    expect(busyCloseReason(30)).toBe('busy; retry-after=30');
    expect(busyCloseReason(2.2)).toBe('busy; retry-after=3');
    expect(busyCloseReason(-5)).toBe('busy; retry-after=0');
  });

  it.each([
    [7200, MAX_RETRY_AFTER_SECONDS],
    [Number.MAX_SAFE_INTEGER, MAX_RETRY_AFTER_SECONDS],
    [Infinity, MAX_RETRY_AFTER_SECONDS],
    [NaN, MAX_RETRY_AFTER_SECONDS],
    [-Infinity, 0],
  ])('caps the delay %s at %i seconds', (input, seconds) => {
    expect(busyCloseReason(input)).toBe(`busy; retry-after=${String(seconds)}`);
  });

  it('fits the 123-byte limit of a close reason', () => {
    expect(busyCloseReason(Number.MAX_SAFE_INTEGER).length).toBeLessThanOrEqual(123);
  });

  it('round-trips the delay', () => {
    expect(retryAfterSeconds(busyCloseReason(45))).toBe(45);
  });

  it.each([
    ['retry-after=5', 5],
    ['busy;retry-after=12; region=fra', 12],
    ['busy; retry-after=7200', MAX_RETRY_AFTER_SECONDS],
    ['busy; retry-after=999999999', MAX_RETRY_AFTER_SECONDS],
    ['busy; retry-after=1234567890', undefined],
    ['busy', undefined],
    ['', undefined],
    ['busy; retry-after=soon', undefined],
    ['busy; retry-after=-5', undefined],
    ['busy; x-retry-after=5', undefined],
  ])('reads %j as %s', (reason, seconds) => {
    expect(retryAfterSeconds(reason)).toBe(seconds);
  });
});
