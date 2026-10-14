import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, expectTypeOf, it } from 'vitest';

import type { LogEvent } from './event.ts';
import {
  type BatchMessage,
  CLIENT_MESSAGE_TYPES,
  type ClientMessage,
  type ConfigMessage,
  type ConfigureMessage,
  type ErrorMessage,
  type HeartbeatMessage,
  type HelloMessage,
  isKnownErrorCode,
  SERVER_MESSAGE_TYPES,
  type ServerMessage,
  type StreamLimits,
  type StreamSettings,
} from './messages.ts';
import { parseClientMessage, parseServerMessage, type ProtocolError } from './parse.ts';
import type { Result } from './result.ts';

// Resolved through the package's `./fixtures/*` export, the way server and web tests load them.
const FIXTURES = new URL('./', import.meta.resolve('@lsv/protocol/fixtures/v1/hello.json'));

function readFixture(name: string): string {
  return readFileSync(new URL(name, FIXTURES), 'utf8');
}

type Side = 'server' | 'client';
type Parse = (raw: string) => Result<ServerMessage | ClientMessage, ProtocolError>;

const parsers: Record<Side, Parse> = { server: parseServerMessage, client: parseClientMessage };

function invalidMessage(message: string): ProtocolError {
  return { kind: 'invalid-message', message };
}

function unknownType(type: string): ProtocolError {
  return { kind: 'unknown-type', type, message: `Unknown message type "${type}"` };
}

/** Every file in fixtures/v1 with the side that sends it and, for invalid ones, the exact error. */
const MANIFEST: Record<string, { side: Side; error?: ProtocolError }> = {
  'hello.json': { side: 'server' },
  'hello-resumed.json': { side: 'server' },
  'batch.json': { side: 'server' },
  'batch-with-dropped.json': { side: 'server' },
  'batch-unknown-fields.json': { side: 'server' },
  'heartbeat.json': { side: 'server' },
  'config.json': { side: 'server' },
  'error.json': { side: 'server' },
  'error-unknown-code.json': { side: 'server' },
  'configure.json': { side: 'client' },
  'invalid-hello-missing-stream-id.json': {
    side: 'server',
    error: invalidMessage('hello.streamId must be a non-empty string'),
  },
  'invalid-batch-unknown-level.json': {
    side: 'server',
    error: invalidMessage(
      'batch.events[1].level must be one of trace, debug, info, warn, error, fatal',
    ),
  },
  'invalid-heartbeat-negative-seq.json': {
    side: 'server',
    error: invalidMessage('heartbeat.lastSeq must be a non-negative integer'),
  },
  'invalid-configure-rate-string.json': {
    side: 'client',
    error: invalidMessage('configure.rate must be a non-negative integer'),
  },
  'invalid-server-unknown-type.json': { side: 'server', error: unknownType('subscribe') },
  'invalid-client-unknown-type.json': { side: 'client', error: unknownType('pause') },
};

const entries = Object.entries(MANIFEST);
const valid = entries.filter(([, { error }]) => error === undefined);
const invalid = entries.filter(([, { error }]) => error !== undefined);

function parsedFixtures<T>(side: Side, parse: (raw: string) => Result<T, ProtocolError>): T[] {
  return valid
    .filter(([, entry]) => entry.side === side)
    .map(([name]) => {
      const result = parse(readFixture(name));
      if (!result.ok) throw new Error(`fixtures/v1/${name} does not parse`);
      return result.value;
    });
}

const serverMessages = parsedFixtures('server', parseServerMessage);
const clientMessages = parsedFixtures('client', parseClientMessage);

function messagesOf<T extends ServerMessage['type']>(
  type: T,
): Extract<ServerMessage, { type: T }>[] {
  return serverMessages.filter((message): message is Extract<ServerMessage, { type: T }> => {
    return message.type === type;
  });
}

describe('golden fixtures v1', () => {
  it('lists every fixture file in the manifest', () => {
    const files = readdirSync(FIXTURES).filter((name) => name.endsWith('.json'));
    expect(files.toSorted()).toEqual(Object.keys(MANIFEST).toSorted());
  });

  it('names invalid fixtures, and only them, with the invalid- prefix', () => {
    expect(invalid.every(([name]) => name.startsWith('invalid-'))).toBe(true);
    expect(valid.some(([name]) => name.startsWith('invalid-'))).toBe(false);
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

  it.each(invalid)('rejects %s with the expected error', (name, { side, error }) => {
    expect(parsers[side](readFixture(name))).toEqual({ ok: false, error });
  });

  it('accepts an error code this version does not know', () => {
    expect(messagesOf('error').map(({ code }) => [code, isKnownErrorCode(code)])).toEqual([
      ['unsupported', true],
      ['rate-limited', false],
    ]);
  });

  it('lists exactly the message types of the unions', () => {
    expectTypeOf<(typeof SERVER_MESSAGE_TYPES)[number]>().toEqualTypeOf<ServerMessage['type']>();
    expectTypeOf<(typeof CLIENT_MESSAGE_TYPES)[number]>().toEqualTypeOf<ClientMessage['type']>();
  });
});

// --- Guards and types stay in step ---------------------------------------------------------------
// The key tables are compared with the types by `tsc` (a new field fails the typecheck until its
// table is updated) and drive the tests below (which fail until the guard checks the field).

/** Keys `T` may omit: `T` does not extend an object where the key is required. */
type OptionalKeys<T> = { [K in keyof T]-?: T extends Record<K, T[K]> ? never : K }[keyof T];
type RequiredKeys<T> = Exclude<keyof T, OptionalKeys<T>>;

const HELLO_KEYS = {
  required: [
    'protocolVersion',
    'streamId',
    'resumed',
    'serverTime',
    'stream',
    'limits',
    'expiresAt',
  ],
  optional: [],
} as const;
const STREAM_SETTINGS_KEYS = { required: ['rate', 'scenario', 'seed'], optional: [] } as const;
const STREAM_LIMITS_KEYS = {
  required: ['minRate', 'maxRate', 'sessionMaxMs'],
  optional: [],
} as const;
const BATCH_KEYS = { required: ['sentAt', 'events'], optional: ['dropped'] } as const;
const LOG_EVENT_KEYS = {
  required: ['seq', 'ts', 'level', 'service', 'host', 'message'],
  optional: ['traceId', 'payload'],
} as const;
const HEARTBEAT_KEYS = { required: ['serverTime', 'lastSeq'], optional: [] } as const;
const CONFIG_KEYS = { required: ['rate', 'scenario'], optional: ['requestId'] } as const;
const ERROR_KEYS = { required: ['code', 'message'], optional: [] } as const;
const CONFIGURE_KEYS = { required: [], optional: ['requestId', 'rate', 'scenario'] } as const;

interface KeyTable {
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

interface Shape {
  readonly name: string;
  readonly keys: KeyTable;
  readonly parse: Parse;
  /** Valid fixture to mutate, and where the object of this shape sits inside it. */
  readonly fixture: string;
  readonly path: readonly string[];
  /** Prefix of the failing field in error messages. */
  readonly field: string;
  /** Every object of this shape across the valid fixtures. */
  readonly samples: () => readonly object[];
}

const SHAPES: readonly Shape[] = [
  {
    name: 'HelloMessage',
    keys: HELLO_KEYS,
    parse: parseServerMessage,
    fixture: 'hello.json',
    path: [],
    field: 'hello',
    samples: () => messagesOf('hello'),
  },
  {
    name: 'StreamSettings',
    keys: STREAM_SETTINGS_KEYS,
    parse: parseServerMessage,
    fixture: 'hello.json',
    path: ['stream'],
    field: 'hello.stream',
    samples: () => messagesOf('hello').map(({ stream }) => stream),
  },
  {
    name: 'StreamLimits',
    keys: STREAM_LIMITS_KEYS,
    parse: parseServerMessage,
    fixture: 'hello.json',
    path: ['limits'],
    field: 'hello.limits',
    samples: () => messagesOf('hello').map(({ limits }) => limits),
  },
  {
    name: 'BatchMessage',
    keys: BATCH_KEYS,
    parse: parseServerMessage,
    fixture: 'batch.json',
    path: [],
    field: 'batch',
    samples: () => messagesOf('batch'),
  },
  {
    name: 'LogEvent',
    keys: LOG_EVENT_KEYS,
    parse: parseServerMessage,
    fixture: 'batch.json',
    path: ['events', '0'],
    field: 'batch.events[0]',
    samples: () => messagesOf('batch').flatMap(({ events }) => events),
  },
  {
    name: 'HeartbeatMessage',
    keys: HEARTBEAT_KEYS,
    parse: parseServerMessage,
    fixture: 'heartbeat.json',
    path: [],
    field: 'heartbeat',
    samples: () => messagesOf('heartbeat'),
  },
  {
    name: 'ConfigMessage',
    keys: CONFIG_KEYS,
    parse: parseServerMessage,
    fixture: 'config.json',
    path: [],
    field: 'config',
    samples: () => messagesOf('config'),
  },
  {
    name: 'ErrorMessage',
    keys: ERROR_KEYS,
    parse: parseServerMessage,
    fixture: 'error.json',
    path: [],
    field: 'error',
    samples: () => messagesOf('error'),
  },
  {
    name: 'ConfigureMessage',
    keys: CONFIGURE_KEYS,
    parse: parseClientMessage,
    fixture: 'configure.json',
    path: [],
    field: 'configure',
    samples: () => clientMessages,
  },
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The fixture with `key` of the object at `path` set to `value`; `undefined` removes the key. */
function withField(shape: Shape, key: string, value: unknown): string {
  const message: unknown = JSON.parse(readFixture(shape.fixture));
  let target = message;
  for (const step of shape.path) target = isObject(target) ? target[step] : undefined;
  if (!isObject(target)) throw new Error(`${shape.fixture} has nothing at ${shape.path.join('.')}`);
  target[key] = value;
  return JSON.stringify(message);
}

/** The field an `invalid-message` error points at, e.g. `hello.stream.rate`. */
function failedField(result: Result<unknown, ProtocolError>): string | undefined {
  if (result.ok || result.error.kind !== 'invalid-message') return undefined;
  return result.error.message.split(' must be ')[0];
}

describe('key tables', () => {
  /** The keys of `T` as the tables list them: required (without `type`) and optional. */
  interface KeysOf<T> {
    required: Exclude<RequiredKeys<T>, 'type'>;
    optional: OptionalKeys<T>;
  }
  interface TableOf<K extends KeyTable> {
    required: K['required'][number];
    optional: K['optional'][number];
  }

  it('match the required and optional keys of the types', () => {
    expectTypeOf<TableOf<typeof HELLO_KEYS>>().toEqualTypeOf<KeysOf<HelloMessage>>();
    expectTypeOf<TableOf<typeof STREAM_SETTINGS_KEYS>>().toEqualTypeOf<KeysOf<StreamSettings>>();
    expectTypeOf<TableOf<typeof STREAM_LIMITS_KEYS>>().toEqualTypeOf<KeysOf<StreamLimits>>();
    expectTypeOf<TableOf<typeof BATCH_KEYS>>().toEqualTypeOf<KeysOf<BatchMessage>>();
    expectTypeOf<TableOf<typeof LOG_EVENT_KEYS>>().toEqualTypeOf<KeysOf<LogEvent>>();
    expectTypeOf<TableOf<typeof HEARTBEAT_KEYS>>().toEqualTypeOf<KeysOf<HeartbeatMessage>>();
    expectTypeOf<TableOf<typeof CONFIG_KEYS>>().toEqualTypeOf<KeysOf<ConfigMessage>>();
    expectTypeOf<TableOf<typeof ERROR_KEYS>>().toEqualTypeOf<KeysOf<ErrorMessage>>();
    expectTypeOf<TableOf<typeof CONFIGURE_KEYS>>().toEqualTypeOf<KeysOf<ConfigureMessage>>();
  });
});

describe.each(SHAPES)('guard for $name', (shape) => {
  const { required, optional } = shape.keys;

  it.each(required)('fails on exactly %s when it is missing or null', (key) => {
    for (const value of [undefined, null]) {
      expect(failedField(shape.parse(withField(shape, key, value)))).toBe(`${shape.field}.${key}`);
    }
  });

  it.each(optional)('accepts a missing %s and fails on exactly it when null', (key) => {
    expect(shape.parse(withField(shape, key, undefined)).ok).toBe(true);
    expect(failedField(shape.parse(withField(shape, key, null)))).toBe(`${shape.field}.${key}`);
  });

  it.each(optional)('has %s in at least one valid fixture', (key) => {
    expect(shape.samples().some((sample) => key in sample)).toBe(true);
  });
});
