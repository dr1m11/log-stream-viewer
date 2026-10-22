import { describe, expect, it } from 'vitest';

import { LOCAL_STREAM_URL, resolveStreamUrl, streamUrlProblem } from './stream-url';

describe('resolveStreamUrl', () => {
  it.each([undefined, '', '   '])('falls back to the local mock server for %j', (value) => {
    expect(resolveStreamUrl(value)).toBe(LOCAL_STREAM_URL);
  });

  it('trims a set value', () => {
    expect(resolveStreamUrl(' wss://log-stream-viewer-mock.fly.dev/ws\n')).toBe(
      'wss://log-stream-viewer-mock.fly.dev/ws',
    );
  });
});

describe('streamUrlProblem', () => {
  it.each([
    LOCAL_STREAM_URL,
    'wss://log-stream-viewer-mock.fly.dev/ws',
    'ws://127.0.0.1:9000/ws?x=1',
  ])('accepts %s', (value) => {
    expect(streamUrlProblem(value)).toBeUndefined();
  });

  it.each([
    ['localhost:8787/ws', 'absolute ws: or wss: URL'],
    ['https://log-stream-viewer-mock.fly.dev/ws', 'got the https: URL'],
    ['ws://localhost:8787/ws#live', 'must not have a #fragment'],
  ])('rejects %s', (value, problem) => {
    expect(streamUrlProblem(value)).toContain(problem);
  });
});
