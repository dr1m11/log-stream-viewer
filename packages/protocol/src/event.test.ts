import { describe, expect, it } from 'vitest';

import { isLogLevel, LOG_LEVELS } from './event.ts';

describe('log levels', () => {
  it('are ordered from the least to the most severe', () => {
    expect(LOG_LEVELS).toEqual(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
  });

  it.each(LOG_LEVELS)('recognizes "%s"', (level) => {
    expect(isLogLevel(level)).toBe(true);
  });

  it.each(['INFO', 'verbose', 'warning', '', ' info', null, undefined, 2, ['info']])(
    'rejects %j',
    (value) => {
      expect(isLogLevel(value)).toBe(false);
    },
  );
});
