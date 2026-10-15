import { describe, expect, it } from 'vitest';

import { readStreamRequest } from './read-stream-request';

describe('readStreamRequest', () => {
  it('reads rate, scenario and seed from the page query', () => {
    expect(readStreamRequest('?rate=500&scenario=error-burst&seed=42')).toEqual({
      rate: 500,
      scenario: 'error-burst',
      seed: 42,
    });
  });

  it('asks for nothing when the query is empty, so the server defaults apply', () => {
    expect(readStreamRequest('')).toEqual({});
    expect(readStreamRequest('?')).toEqual({});
  });

  it('leaves out invalid values and ignores unrelated parameters', () => {
    expect(readStreamRequest('?rate=fast&scenario=chaos&seed=-1&utm_source=x')).toEqual({});
    expect(readStreamRequest('?seed=7&rate=1.5')).toEqual({ seed: 7 });
  });

  it('never lets the page URL choose the protocol version or resume a stream', () => {
    expect(readStreamRequest('?v=99&resume=st_1&after=10&rate=50')).toEqual({ rate: 50 });
  });
});
