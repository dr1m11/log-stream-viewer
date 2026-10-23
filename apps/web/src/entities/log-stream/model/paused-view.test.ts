import { describe, expect, it } from 'vitest';

import { eventsSincePause, evictedSincePause, shownEnd } from './paused-view';

describe('shownEnd', () => {
  it('is the buffer end while following the stream', () => {
    expect(shownEnd({ start: 10, end: 500, paused: undefined })).toBe(500);
  });

  it('stays at the pause point while events arrive', () => {
    expect(shownEnd({ start: 0, end: 800, paused: { start: 0, end: 300 } })).toBe(300);
  });

  it('keeps start live, so eviction still shrinks the paused view from the top', () => {
    const range = { start: 250, end: 1250, paused: { start: 0, end: 1000 } };

    expect([range.start, shownEnd(range)]).toEqual([250, 1000]);
  });

  it('is empty, never negative, once eviction passes the pause point', () => {
    expect(shownEnd({ start: 1400, end: 2400, paused: { start: 0, end: 1000 } })).toBe(1400);
  });
});

describe('eventsSincePause', () => {
  it('counts the events received after the pause point, evicted ones included', () => {
    expect(eventsSincePause({ start: 1400, end: 2400, paused: { start: 0, end: 1000 } })).toBe(
      1400,
    );
    expect(eventsSincePause({ start: 0, end: 300, paused: undefined })).toBe(0);
  });
});

describe('evictedSincePause', () => {
  it('is 0 while the buffer still holds every row of the paused view', () => {
    expect(evictedSincePause({ start: 0, end: 900, paused: { start: 0, end: 400 } })).toBe(0);
    expect(evictedSincePause({ start: 500, end: 1500, paused: undefined })).toBe(0);
  });

  it('counts the rows of the paused view that eviction removed', () => {
    expect(evictedSincePause({ start: 1250, end: 2250, paused: { start: 1000, end: 2000 } })).toBe(
      250,
    );
  });

  it('includes events of the pause once eviction passes the pause point', () => {
    expect(evictedSincePause({ start: 2400, end: 3400, paused: { start: 1000, end: 2000 } })).toBe(
      1400,
    );
  });
});
