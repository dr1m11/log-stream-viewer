import { describe, expect, it } from 'vitest';

import {
  buildConnectionQuery,
  buildConnectionUrl,
  type ConnectionParams,
  MAX_ISSUE_VALUE_LENGTH,
  parseConnectionQuery,
} from './connection.ts';
import { MAX_SEED, PROTOCOL_VERSION } from './limits.ts';

/** The params of a query that must parse; fails the test otherwise. */
function paramsOf(query: string) {
  const result = parseConnectionQuery(query);
  expect(result.ok).toBe(true);
  return result.ok ? result.value : undefined;
}

describe('buildConnectionQuery', () => {
  it('always sends the version first', () => {
    expect(buildConnectionQuery({ version: PROTOCOL_VERSION })).toBe('v=1');
  });

  it('adds the stream settings that are set', () => {
    expect(buildConnectionQuery({ version: 1, rate: 200, scenario: 'steady', seed: 42 })).toBe(
      'v=1&rate=200&scenario=steady&seed=42',
    );
    expect(buildConnectionQuery({ version: 1, scenario: 'error-burst' })).toBe(
      'v=1&scenario=error-burst',
    );
  });

  it('percent-encodes the stream id of a resume point', () => {
    expect(buildConnectionQuery({ version: 1, resume: { streamId: 'st/1 a&b', after: 99 } })).toBe(
      'v=1&resume=st%2F1%20a%26b&after=99',
    );
  });
});

describe('buildConnectionUrl', () => {
  it('appends the query to the endpoint', () => {
    expect(buildConnectionUrl('ws://localhost:8787/ws', { version: 1, rate: 50 })).toBe(
      'ws://localhost:8787/ws?v=1&rate=50',
    );
  });

  it('extends a query the endpoint already has', () => {
    expect(buildConnectionUrl('wss://example.test/ws?region=fra', { version: 1 })).toBe(
      'wss://example.test/ws?region=fra&v=1',
    );
  });
});

describe('parseConnectionQuery', () => {
  it.each<ConnectionParams>([
    { version: 1 },
    { version: 1, rate: 200, scenario: 'steady', seed: 42 },
    { version: 2, rate: 0, scenario: 'traffic-spike', seed: MAX_SEED },
    { version: 1, seed: 0, resume: { streamId: 'st_01JA2R7QK3M9X4V8T6', after: 0 } },
    { version: 1, resume: { streamId: 'st/1 a&b=c%', after: 2190 } },
  ])('round-trips %o through buildConnectionQuery', (params) => {
    expect(parseConnectionQuery(buildConnectionQuery(params))).toEqual({
      ok: true,
      value: { params, ignored: [] },
    });
  });

  it('accepts a leading question mark', () => {
    expect(paramsOf('?v=1&rate=200')).toEqual({ params: { version: 1, rate: 200 }, ignored: [] });
  });

  it('skips unknown, empty and undecodable parameter names', () => {
    expect(paramsOf('&&token=abc&debug&v=1&%ZZ=5&')).toEqual({
      params: { version: 1 },
      ignored: [],
    });
  });

  it('decodes parameter names and values like URLSearchParams', () => {
    expect(paramsOf('%76=1&scenario=error%2Dburst&resume=a+b&after=3')).toEqual({
      params: { version: 1, scenario: 'error-burst', resume: { streamId: 'a b', after: 3 } },
      ignored: [],
    });
  });

  it('uses the first occurrence of a repeated parameter', () => {
    expect(paramsOf('v=1&rate=100&rate=200&v=2')).toEqual({
      params: { version: 1, rate: 100 },
      ignored: [],
    });
  });

  it.each([
    ['', ''],
    ['rate=200', ''],
  ])('rejects %j because v is missing', (query, value) => {
    expect(parseConnectionQuery(query)).toEqual({
      ok: false,
      error: { param: 'v', value, problem: 'missing' },
    });
  });

  it.each([
    ['v=', '', 'not-an-integer'],
    ['v', '', 'not-an-integer'],
    ['v=abc', 'abc', 'not-an-integer'],
    ['v=1.0', '1.0', 'not-an-integer'],
    ['v=-1', '-1', 'not-an-integer'],
    ['v=0', '0', 'out-of-range'],
    ['v=99999999999999999999', '99999999999999999999', 'out-of-range'],
    ['v=%E0%A4%A', '%E0%A4%A', 'bad-encoding'],
  ])('rejects %j as an invalid version', (query, value, problem) => {
    expect(parseConnectionQuery(query)).toEqual({
      ok: false,
      error: { param: 'v', value, problem },
    });
  });

  it('leaves out invalid optional parameters and reports each of them', () => {
    expect(paramsOf('v=1&rate=fast&scenario=chaos&seed=4294967296')).toEqual({
      params: { version: 1 },
      ignored: [
        { param: 'rate', value: 'fast', problem: 'not-an-integer' },
        { param: 'scenario', value: 'chaos', problem: 'unknown-scenario' },
        { param: 'seed', value: '4294967296', problem: 'out-of-range' },
      ],
    });
  });

  it.each([
    ['rate=1e3', 'rate', '1e3', 'not-an-integer'],
    ['rate=99999999999999999999', 'rate', '99999999999999999999', 'out-of-range'],
    ['rate=%ZZ', 'rate', '%ZZ', 'bad-encoding'],
    ['scenario=', 'scenario', '', 'unknown-scenario'],
    ['scenario=%E0%A4%A', 'scenario', '%E0%A4%A', 'bad-encoding'],
    ['seed=-1', 'seed', '-1', 'not-an-integer'],
    ['resume=st_1', 'resume', 'st_1', 'unpaired'],
    ['after=10', 'after', '10', 'unpaired'],
    ['resume=&after=10', 'resume', '', 'empty'],
    ['resume=%ZZ&after=10', 'resume', '%ZZ', 'bad-encoding'],
    ['resume=st_1&after=last', 'after', 'last', 'not-an-integer'],
  ])('ignores %j and reports it', (query, param, value, problem) => {
    expect(paramsOf(`v=1&${query}`)).toEqual({
      params: { version: 1 },
      ignored: [{ param, value, problem }],
    });
  });

  it('cuts reported values to MAX_ISSUE_VALUE_LENGTH so they fit a close reason', () => {
    const long = 'x'.repeat(500);
    const cut = long.slice(0, MAX_ISSUE_VALUE_LENGTH);
    expect(parseConnectionQuery(`v=${long}`)).toEqual({
      ok: false,
      error: { param: 'v', value: cut, problem: 'not-an-integer' },
    });
    expect(paramsOf(`v=1&scenario=${long}`)?.ignored).toEqual([
      { param: 'scenario', value: cut, problem: 'unknown-scenario' },
    ]);
  });

  it('decodes a long resume id in full even though issues are cut', () => {
    const streamId = 's'.repeat(100);
    expect(paramsOf(`v=1&resume=${streamId}&after=5`)?.params.resume).toEqual({
      streamId,
      after: 5,
    });
  });

  it('keeps valid parameters next to invalid ones', () => {
    expect(paramsOf('v=1&rate=250&seed=x&scenario=traffic-spike')).toEqual({
      params: { version: 1, rate: 250, scenario: 'traffic-spike' },
      ignored: [{ param: 'seed', value: 'x', problem: 'not-an-integer' }],
    });
  });
});
