import { describe, expect, it } from 'vitest';

import { formatEventDateTime, formatEventTime } from './event-time';

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

describe('formatEventTime', () => {
  it('formats the local time of day with milliseconds on a 24-hour clock', () => {
    const ts = Date.UTC(2026, 9, 22, 21, 4, 5, 7);
    const local = new Date(ts);

    expect(formatEventTime(ts)).toBe(
      `${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}.${pad(local.getMilliseconds(), 3)}`,
    );
  });
});

describe('formatEventDateTime', () => {
  it('puts the local date before the time of day', () => {
    const ts = Date.UTC(2026, 0, 2, 21, 4, 5, 7);
    const local = new Date(ts);

    expect(formatEventDateTime(ts)).toBe(
      `${String(local.getFullYear())}-${pad(local.getMonth() + 1)}-${pad(local.getDate())} ${formatEventTime(ts)}`,
    );
  });
});
