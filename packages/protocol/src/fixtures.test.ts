import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  CLIENT_MESSAGE_TYPES,
  type ClientMessage,
  SERVER_MESSAGE_TYPES,
  type ServerMessage,
} from './messages.ts';
import { parseClientMessage, parseServerMessage, type ProtocolError } from './parse.ts';

const FIXTURES = new URL('../fixtures/v1/', import.meta.url);

function readFixture(name: string): string {
  return readFileSync(new URL(name, FIXTURES), 'utf8');
}

type Side = 'server' | 'client';

const parsers = { server: parseServerMessage, client: parseClientMessage } as const;

/** Every file in fixtures/v1 with the side that sends it and the expected outcome. */
const MANIFEST: Record<string, { side: Side; error?: ProtocolError['kind'] }> = {
  'hello.json': { side: 'server' },
  'batch.json': { side: 'server' },
  'batch-with-dropped.json': { side: 'server' },
  'heartbeat.json': { side: 'server' },
  'config.json': { side: 'server' },
  'error.json': { side: 'server' },
  'configure.json': { side: 'client' },
  'invalid-hello-missing-stream-id.json': { side: 'server', error: 'invalid-message' },
  'invalid-batch-unknown-level.json': { side: 'server', error: 'invalid-message' },
  'invalid-heartbeat-negative-seq.json': { side: 'server', error: 'invalid-message' },
  'invalid-configure-rate-string.json': { side: 'client', error: 'invalid-message' },
  'invalid-unknown-type.json': { side: 'server', error: 'unknown-type' },
};

const entries = Object.entries(MANIFEST);
const valid = entries.filter(([, { error }]) => error === undefined);
const invalid = entries.filter(([, { error }]) => error !== undefined);

describe('golden fixtures v1', () => {
  it('lists every fixture file in the manifest', () => {
    const files = readdirSync(FIXTURES).filter((name) => name.endsWith('.json'));
    expect(files.toSorted()).toEqual(Object.keys(MANIFEST).toSorted());
  });

  it('names invalid fixtures with the invalid- prefix', () => {
    expect(invalid.map(([name]) => name).every((name) => name.startsWith('invalid-'))).toBe(true);
    expect(valid.map(([name]) => name).some((name) => name.startsWith('invalid-'))).toBe(false);
  });

  it.each(SERVER_MESSAGE_TYPES)('has a valid fixture for the server message "%s"', (type) => {
    const result = parseServerMessage(readFixture(`${type}.json`));
    expect(result.ok && result.value.type).toBe(type);
  });

  it.each(CLIENT_MESSAGE_TYPES)('has a valid fixture for the client message "%s"', (type) => {
    const result = parseClientMessage(readFixture(`${type}.json`));
    expect(result.ok && result.value.type).toBe(type);
  });

  it.each(valid)('parses %s into exactly the JSON it contains', (name, { side }) => {
    const raw = readFixture(name);
    const json: unknown = JSON.parse(raw);
    expect(parsers[side](raw)).toEqual({ ok: true, value: json });
  });

  it.each(invalid)('rejects %s without throwing', (name, { side, error }) => {
    const result = parsers[side](readFixture(name));
    expect(result.ok ? undefined : result.error.kind).toBe(error);
  });

  it('lists exactly the message types of the unions', () => {
    expectTypeOf<(typeof SERVER_MESSAGE_TYPES)[number]>().toEqualTypeOf<ServerMessage['type']>();
    expectTypeOf<(typeof CLIENT_MESSAGE_TYPES)[number]>().toEqualTypeOf<ClientMessage['type']>();
  });
});
