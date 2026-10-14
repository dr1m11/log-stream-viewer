import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { ServerMessage } from './messages.ts';
import { parseClientMessage, parseServerMessage, type ProtocolError } from './parse.ts';
import type { Result } from './result.ts';

const FIXTURES = new URL('../fixtures/v1/', import.meta.url);

/** A golden fixture, parsed and typed, to derive malformed variants from. */
function serverFixture<T extends ServerMessage['type']>(
  type: T,
): Extract<ServerMessage, { type: T }> {
  const result = parseServerMessage(readFileSync(new URL(`${type}.json`, FIXTURES), 'utf8'));
  if (!result.ok || result.value.type !== type) {
    throw new Error(`fixtures/v1/${type}.json is not a valid "${type}" message`);
  }
  return result.value as Extract<ServerMessage, { type: T }>;
}

/** The field an `invalid-message` error points at, e.g. `hello.stream.rate`. */
function failedField(result: Result<unknown, ProtocolError>): string | undefined {
  if (result.ok || result.error.kind !== 'invalid-message') return undefined;
  return result.error.message.split(' must be ')[0];
}

/** Serializes `base` with `patch` applied; `undefined` in the patch removes a field. */
function variant(base: object, patch: Record<string, unknown>): string {
  return JSON.stringify({ ...base, ...patch });
}

const hello = serverFixture('hello');
const batch = serverFixture('batch');
const heartbeat = serverFixture('heartbeat');
const config = serverFixture('config');
const error = serverFixture('error');

const event = {
  seq: 7,
  ts: 1791979204322,
  level: 'info',
  service: 'api-gateway',
  host: 'api-gateway-5d8b-1',
  message: 'GET /health 200',
};

/** A batch of `event` and a second event with `patch` applied. */
function batchWith(patch: Record<string, unknown>): string {
  return variant(batch, { events: [event, { ...event, seq: 8, ...patch }] });
}

describe('parseServerMessage', () => {
  describe('envelope', () => {
    it.each(['', '{', 'hello', '{"type":"hello",}', "{'type':'hello'}"])(
      'returns invalid-json for %j',
      (raw) => {
        const result = parseServerMessage(raw);
        expect(result.ok ? undefined : result.error.kind).toBe('invalid-json');
        expect(result.ok ? undefined : result.error.message).toMatch(/^Invalid JSON: SyntaxError/);
      },
    );

    it.each(['null', '42', '"hello"', 'true', '[]', '[{"type":"hello"}]'])(
      'rejects the non-object JSON value %s',
      (raw) => {
        expect(parseServerMessage(raw)).toEqual({
          ok: false,
          error: { kind: 'invalid-message', message: 'A message must be a JSON object' },
        });
      },
    );

    it.each(['{}', '{"type":42}', '{"type":null}', '{"type":["hello"]}'])(
      'rejects %s because type is not a string',
      (raw) => {
        expect(parseServerMessage(raw)).toEqual({
          ok: false,
          error: { kind: 'invalid-message', message: 'type must be a string' },
        });
      },
    );

    it.each(['subscribe', 'configure', 'toString', '__proto__', ''])(
      'reports the unknown type "%s" distinctly so the client can ignore it',
      (type) => {
        expect(parseServerMessage(JSON.stringify({ type }))).toEqual({
          ok: false,
          error: { kind: 'unknown-type', type, message: `Unknown message type "${type}"` },
        });
      },
    );

    it('keeps fields it does not know, so additive changes stay compatible', () => {
      const extended = { ...heartbeat, region: 'fra', uptime: { s: 3 } };
      expect(parseServerMessage(JSON.stringify(extended))).toEqual({ ok: true, value: extended });
    });

    it('never throws, even on hostile input', () => {
      const inputs = [
        '['.repeat(10_000) + ']'.repeat(10_000),
        '{"__proto__":{"type":"hello"}}',
        '{"type":"batch","sentAt":1,"events":{"length":1}}',
        '{"type":"batch","sentAt":1,"events":[1,2,3]}',
        '\u0000',
      ];
      for (const raw of inputs) {
        expect(() => parseServerMessage(raw)).not.toThrow();
        expect(parseServerMessage(raw).ok).toBe(false);
      }
    });

    it('describes the first invalid field and what it must be', () => {
      const messages = [
        variant(hello, { protocolVersion: 0 }),
        variant(hello, { resumed: 'no' }),
        variant(hello, { serverTime: -1 }),
        variant(hello, { stream: null }),
        variant(hello, { stream: { ...hello.stream, seed: 2 ** 32 } }),
        variant(hello, { limits: { ...hello.limits, maxRate: -1 } }),
        variant(batch, { events: 'none' }),
        variant(batch, { events: [event, 42] }),
        batchWith({ level: 'verbose' }),
        batchWith({ host: '' }),
        batchWith({ message: 1 }),
        batchWith({ payload: [] }),
        variant(config, { scenario: 'chaos' }),
        variant(error, { code: 'internal' }),
      ].map((raw) => {
        const result = parseServerMessage(raw);
        return result.ok ? undefined : result.error.message;
      });
      expect(messages).toEqual([
        'hello.protocolVersion must be a positive integer',
        'hello.resumed must be a boolean',
        'hello.serverTime must be a non-negative finite number',
        'hello.stream must be an object',
        'hello.stream.seed must be an integer from 0 to 4294967295',
        'hello.limits.maxRate must be a non-negative integer',
        'batch.events must be an array',
        'batch.events[1] must be an object',
        'batch.events[1].level must be one of trace, debug, info, warn, error, fatal',
        'batch.events[1].host must be a non-empty string',
        'batch.events[1].message must be a string',
        'batch.events[1].payload must be an object',
        'config.scenario must be one of steady, error-burst, traffic-spike',
        'error.code must be one of bad-message, unsupported',
      ]);
    });
  });

  describe('hello', () => {
    it.each([
      [{ protocolVersion: 0 }, 'protocolVersion'],
      [{ protocolVersion: 1.5 }, 'protocolVersion'],
      [{ protocolVersion: '1' }, 'protocolVersion'],
      [{ streamId: undefined }, 'streamId'],
      [{ streamId: '' }, 'streamId'],
      [{ resumed: 'false' }, 'resumed'],
      [{ serverTime: -1 }, 'serverTime'],
      [{ stream: undefined }, 'stream'],
      [{ stream: null }, 'stream'],
      [{ stream: [500, 'steady', 42] }, 'stream'],
      [{ stream: { ...hello.stream, rate: -10 } }, 'stream.rate'],
      [{ stream: { ...hello.stream, scenario: 'chaos' } }, 'stream.scenario'],
      [{ stream: { ...hello.stream, seed: 2 ** 32 } }, 'stream.seed'],
      [{ stream: { ...hello.stream, seed: -1 } }, 'stream.seed'],
      [{ limits: 'none' }, 'limits'],
      [{ limits: { ...hello.limits, minRate: '10' } }, 'limits.minRate'],
      [{ limits: { ...hello.limits, maxRate: undefined } }, 'limits.maxRate'],
      [{ limits: { ...hello.limits, sessionMaxMs: 1.5 } }, 'limits.sessionMaxMs'],
      [{ expiresAt: undefined }, 'expiresAt'],
    ])('rejects hello with %o (%s)', (patch, field) => {
      expect(failedField(parseServerMessage(variant(hello, patch)))).toBe(`hello.${field}`);
    });

    it('accepts a resumed stream and seed 0', () => {
      const resumed = { ...hello, resumed: true, stream: { ...hello.stream, seed: 0 } };
      expect(parseServerMessage(JSON.stringify(resumed))).toEqual({ ok: true, value: resumed });
    });
  });

  describe('batch', () => {
    it.each([
      [{ sentAt: '1791979204371' }, 'sentAt'],
      [{ events: undefined }, 'events'],
      [{ events: { 0: event } }, 'events'],
      [{ events: [event, null] }, 'events[1]'],
      [{ events: [[event]] }, 'events[0]'],
      [{ events: [{ ...event, seq: undefined }] }, 'events[0].seq'],
      [{ events: [{ ...event, message: undefined }] }, 'events[0].message'],
      [{ dropped: -1 }, 'dropped'],
      [{ dropped: 0.5 }, 'dropped'],
    ])('rejects a batch with %o (%s)', (patch, field) => {
      expect(failedField(parseServerMessage(variant(batch, patch)))).toBe(`batch.${field}`);
    });

    it.each([
      [{ seq: 0 }, 'seq'],
      [{ seq: -8 }, 'seq'],
      [{ seq: 8.5 }, 'seq'],
      [{ seq: 2 ** 53 }, 'seq'],
      [{ ts: -1 }, 'ts'],
      [{ ts: '2026-10-14T12:00:00Z' }, 'ts'],
      [{ level: 'verbose' }, 'level'],
      [{ level: 'INFO' }, 'level'],
      [{ service: '' }, 'service'],
      [{ host: 42 }, 'host'],
      [{ message: null }, 'message'],
      [{ traceId: '' }, 'traceId'],
      [{ traceId: null }, 'traceId'],
      [{ payload: [1, 2] }, 'payload'],
      [{ payload: '{}' }, 'payload'],
      [{ payload: null }, 'payload'],
    ])('rejects an event with %o (%s)', (patch, field) => {
      expect(failedField(parseServerMessage(batchWith(patch)))).toBe(`batch.events[1].${field}`);
    });

    it.each([
      '{"type":"batch","sentAt":1e999,"events":[]}',
      '{"type":"batch","sentAt":1,"events":[{"seq":1,"ts":-1e999,"level":"info","service":"a","host":"b","message":""}]}',
    ])('rejects non-finite numbers (JSON has no NaN; 1e999 parses to Infinity): %s', (raw) => {
      expect(parseServerMessage(raw).ok).toBe(false);
    });

    it('accepts an empty batch and an empty message text', () => {
      expect(parseServerMessage(variant(batch, { events: [] })).ok).toBe(true);
      expect(parseServerMessage(batchWith({ message: '' })).ok).toBe(true);
    });

    it('does not look inside payload', () => {
      const payload = { nested: [{ deep: [null, true, 1.5] }], '': { 'a.b': 'c' } };
      expect(parseServerMessage(batchWith({ payload })).ok).toBe(true);
    });
  });

  describe('heartbeat', () => {
    it.each([
      [{ serverTime: undefined }, 'serverTime'],
      [{ serverTime: '1791979205000' }, 'serverTime'],
      [{ lastSeq: '2190' }, 'lastSeq'],
      [{ lastSeq: -1 }, 'lastSeq'],
    ])('rejects a heartbeat with %o (%s)', (patch, field) => {
      expect(failedField(parseServerMessage(variant(heartbeat, patch)))).toBe(`heartbeat.${field}`);
    });

    it('accepts lastSeq 0 before the first event', () => {
      expect(parseServerMessage(variant(heartbeat, { lastSeq: 0 })).ok).toBe(true);
    });
  });

  describe('config', () => {
    it.each([
      [{ requestId: '' }, 'requestId'],
      [{ requestId: 3 }, 'requestId'],
      [{ rate: undefined }, 'rate'],
      [{ rate: 2.5 }, 'rate'],
      [{ scenario: undefined }, 'scenario'],
    ])('rejects a config with %o (%s)', (patch, field) => {
      expect(failedField(parseServerMessage(variant(config, patch)))).toBe(`config.${field}`);
    });

    it('accepts a config without requestId (a server-initiated change)', () => {
      expect(parseServerMessage(variant(config, { requestId: undefined })).ok).toBe(true);
    });
  });

  describe('error', () => {
    it.each([
      [{ code: 'internal' }, 'code'],
      [{ code: undefined }, 'code'],
      [{ message: undefined }, 'message'],
    ])('rejects an error with %o (%s)', (patch, field) => {
      expect(failedField(parseServerMessage(variant(error, patch)))).toBe(`error.${field}`);
    });
  });
});

describe('parseClientMessage', () => {
  it.each([
    { type: 'configure' },
    { type: 'configure', rate: 100 },
    { type: 'configure', rate: 0 },
    { type: 'configure', scenario: 'traffic-spike' },
    { type: 'configure', requestId: 'r1', rate: 10_000, scenario: 'steady' },
  ])('accepts configure %j', (message) => {
    expect(parseClientMessage(JSON.stringify(message))).toEqual({ ok: true, value: message });
  });

  it.each([
    [{ rate: '2000' }, 'rate'],
    [{ rate: -1 }, 'rate'],
    [{ rate: 1.5 }, 'rate'],
    [{ rate: null }, 'rate'],
    [{ scenario: 'chaos' }, 'scenario'],
    [{ requestId: '' }, 'requestId'],
    [{ requestId: 1 }, 'requestId'],
  ])('rejects configure with %o (%s)', (patch, field) => {
    expect(failedField(parseClientMessage(variant({ type: 'configure' }, patch)))).toBe(
      `configure.${field}`,
    );
  });

  it.each(['hello', 'subscribe', 'constructor'])(
    'reports the unknown type "%s" so the server can answer error/unsupported',
    (type) => {
      expect(parseClientMessage(JSON.stringify({ type }))).toEqual({
        ok: false,
        error: { kind: 'unknown-type', type, message: `Unknown message type "${type}"` },
      });
    },
  );

  it.each([
    ['{"type":', 'invalid-json'],
    ['[]', 'invalid-message'],
    ['{"rate":100}', 'invalid-message'],
  ])('rejects the malformed frame %s without throwing', (raw, kind) => {
    const result = parseClientMessage(raw);
    expect(result.ok ? undefined : result.error.kind).toBe(kind);
  });
});
