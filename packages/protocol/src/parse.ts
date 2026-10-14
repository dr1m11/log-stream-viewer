import { isLogLevel, LOG_LEVELS } from './event.ts';
import { MAX_SEED } from './limits.ts';
import { type ClientMessage, ERROR_CODES, type ServerMessage } from './messages.ts';
import { err, ok, type Result } from './result.ts';
import { isScenario, SCENARIOS } from './scenarios.ts';

/**
 * Why a frame could not be turned into a message:
 * - `invalid-json` — the text is not JSON;
 * - `invalid-message` — JSON, but the envelope or a scalar field has the wrong shape;
 * - `unknown-type` — a well-formed envelope with a `type` this protocol version does not know.
 *   Clients ignore such messages; the server answers `error` / `unsupported`.
 */
export type ProtocolError =
  | { readonly kind: 'invalid-json'; readonly message: string }
  | { readonly kind: 'invalid-message'; readonly message: string }
  | { readonly kind: 'unknown-type'; readonly type: string; readonly message: string };

/**
 * Parses a text frame from the server. Checks the envelope and scalar fields (including every
 * event of a batch) but not the contents of `payload`. Never throws.
 */
export function parseServerMessage(raw: string): Result<ServerMessage, ProtocolError> {
  const decoded = decode(raw);
  if (!decoded.ok) return decoded;
  const message = decoded.value;
  let problem: Problem;
  switch (message.type) {
    case 'hello':
      problem = checkHello(message);
      break;
    case 'batch':
      problem = checkBatch(message);
      break;
    case 'heartbeat':
      problem = checkHeartbeat(message);
      break;
    case 'config':
      problem = checkConfig(message);
      break;
    case 'error':
      problem = checkError(message);
      break;
    default:
      return unknownType(message.type);
  }
  if (problem !== undefined) return invalid(message.type, problem);
  // Validated boundary: the check above covered every field the message type declares.
  const validated: unknown = message;
  return ok(validated as ServerMessage);
}

/** Parses a text frame from the client. Never throws. */
export function parseClientMessage(raw: string): Result<ClientMessage, ProtocolError> {
  const decoded = decode(raw);
  if (!decoded.ok) return decoded;
  const message = decoded.value;
  if (message.type !== 'configure') return unknownType(message.type);
  const problem = checkConfigure(message);
  if (problem !== undefined) return invalid(message.type, problem);
  const validated: unknown = message;
  return ok(validated as ClientMessage);
}

// --- Envelope -----------------------------------------------------------------------------------

type Fields = Readonly<Record<string, unknown>>;

interface Envelope extends Fields {
  readonly type: string;
}

/** Description of the first invalid field, or `undefined` when the value is valid. */
type Problem = string | undefined;

function decode(raw: string): Result<Envelope, ProtocolError> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return err({ kind: 'invalid-json', message: `Invalid JSON: ${String(error)}` });
  }
  if (!isRecord(value)) {
    return err({ kind: 'invalid-message', message: 'A message must be a JSON object' });
  }
  if (!hasStringType(value)) {
    return err({ kind: 'invalid-message', message: 'type must be a string' });
  }
  return ok(value);
}

function hasStringType(value: Fields): value is Envelope {
  return typeof value.type === 'string';
}

function invalid(type: string, problem: string): Result<never, ProtocolError> {
  return err({ kind: 'invalid-message', message: `${type}.${problem}` });
}

function unknownType(type: string): Result<never, ProtocolError> {
  return err({ kind: 'unknown-type', type, message: `Unknown message type "${type}"` });
}

// --- Messages -----------------------------------------------------------------------------------

function checkHello(m: Fields): Problem {
  return (
    required(m, 'protocolVersion', POSITIVE_INTEGER) ??
    required(m, 'streamId', NON_EMPTY_STRING) ??
    required(m, 'resumed', BOOLEAN) ??
    required(m, 'serverTime', TIMESTAMP) ??
    nested(m, 'stream', checkStreamSettings) ??
    nested(m, 'limits', checkStreamLimits) ??
    required(m, 'expiresAt', TIMESTAMP)
  );
}

function checkStreamSettings(m: Fields): Problem {
  return (
    required(m, 'rate', NON_NEGATIVE_INTEGER) ??
    required(m, 'scenario', SCENARIO) ??
    required(m, 'seed', SEED)
  );
}

function checkStreamLimits(m: Fields): Problem {
  return (
    required(m, 'minRate', NON_NEGATIVE_INTEGER) ??
    required(m, 'maxRate', NON_NEGATIVE_INTEGER) ??
    required(m, 'sessionMaxMs', NON_NEGATIVE_INTEGER)
  );
}

function checkBatch(m: Fields): Problem {
  return (
    required(m, 'sentAt', TIMESTAMP) ??
    checkEvents(m) ??
    optional(m, 'dropped', NON_NEGATIVE_INTEGER)
  );
}

function checkEvents(m: Fields): Problem {
  const events = m.events;
  if (!Array.isArray(events)) return 'events must be an array';
  // Hot path: an index loop with no allocations unless an event is invalid.
  for (let index = 0; index < events.length; index++) {
    const event: unknown = events[index];
    if (!isRecord(event)) return `events[${String(index)}] must be an object`;
    const problem = checkEvent(event);
    if (problem !== undefined) return `events[${String(index)}].${problem}`;
  }
  return undefined;
}

function checkEvent(m: Fields): Problem {
  return (
    required(m, 'seq', POSITIVE_INTEGER) ??
    required(m, 'ts', TIMESTAMP) ??
    required(m, 'level', LEVEL) ??
    required(m, 'service', NON_EMPTY_STRING) ??
    required(m, 'host', NON_EMPTY_STRING) ??
    required(m, 'message', STRING) ??
    optional(m, 'traceId', NON_EMPTY_STRING) ??
    optional(m, 'payload', OBJECT)
  );
}

function checkHeartbeat(m: Fields): Problem {
  return required(m, 'serverTime', TIMESTAMP) ?? required(m, 'lastSeq', NON_NEGATIVE_INTEGER);
}

function checkConfig(m: Fields): Problem {
  return (
    optional(m, 'requestId', NON_EMPTY_STRING) ??
    required(m, 'rate', NON_NEGATIVE_INTEGER) ??
    required(m, 'scenario', SCENARIO)
  );
}

function checkError(m: Fields): Problem {
  return required(m, 'code', ERROR_CODE) ?? required(m, 'message', STRING);
}

function checkConfigure(m: Fields): Problem {
  return (
    optional(m, 'requestId', NON_EMPTY_STRING) ??
    optional(m, 'rate', NON_NEGATIVE_INTEGER) ??
    optional(m, 'scenario', SCENARIO)
  );
}

// --- Fields -------------------------------------------------------------------------------------

interface Rule {
  readonly test: (value: unknown) => boolean;
  /** Completes the sentence "<field> must be …". */
  readonly expected: string;
}

function required(m: Fields, key: string, rule: Rule): Problem {
  return rule.test(m[key]) ? undefined : `${key} must be ${rule.expected}`;
}

function optional(m: Fields, key: string, rule: Rule): Problem {
  return m[key] === undefined ? undefined : required(m, key, rule);
}

function nested(m: Fields, key: string, check: (fields: Fields) => Problem): Problem {
  const value = m[key];
  if (!isRecord(value)) return `${key} must be an object`;
  const problem = check(value);
  return problem === undefined ? undefined : `${key}.${problem}`;
}

function isRecord(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

const KNOWN_ERROR_CODES: readonly unknown[] = ERROR_CODES;

const STRING: Rule = { test: (value) => typeof value === 'string', expected: 'a string' };
const NON_EMPTY_STRING: Rule = {
  test: (value) => typeof value === 'string' && value !== '',
  expected: 'a non-empty string',
};
const BOOLEAN: Rule = { test: (value) => typeof value === 'boolean', expected: 'a boolean' };
const OBJECT: Rule = { test: isRecord, expected: 'an object' };
const NON_NEGATIVE_INTEGER: Rule = {
  test: isNonNegativeInteger,
  expected: 'a non-negative integer',
};
const POSITIVE_INTEGER: Rule = {
  test: (value) => isNonNegativeInteger(value) && value !== 0,
  expected: 'a positive integer',
};
/** Epoch milliseconds. */
const TIMESTAMP: Rule = {
  test: (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0,
  expected: 'a non-negative finite number',
};
const SEED: Rule = {
  test: (value) => isNonNegativeInteger(value) && value <= MAX_SEED,
  expected: `an integer from 0 to ${String(MAX_SEED)}`,
};
const LEVEL: Rule = { test: isLogLevel, expected: `one of ${LOG_LEVELS.join(', ')}` };
const SCENARIO: Rule = { test: isScenario, expected: `one of ${SCENARIOS.join(', ')}` };
const ERROR_CODE: Rule = {
  test: (value) => KNOWN_ERROR_CODES.includes(value),
  expected: `one of ${ERROR_CODES.join(', ')}`,
};
