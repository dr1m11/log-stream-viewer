import { MAX_SEED } from './limits.ts';
import { err, ok, type Result } from './result.ts';
import { isScenario, type Scenario } from './scenarios.ts';

/** Path of the WebSocket endpoint: `wss://<host>/ws?v=1&rate=200&scenario=steady&seed=42`. */
export const STREAM_PATH = '/ws';

const PARAM_NAMES = ['v', 'rate', 'scenario', 'seed', 'resume', 'after'] as const;

/** Query parameters of the connection URL. */
export type ConnectionParamName = (typeof PARAM_NAMES)[number];

/** Where a reconnecting client wants to continue. Reserved for B4: v1 servers start a new stream. */
export interface ResumePoint {
  /** `hello.streamId` of the stream to continue. */
  readonly streamId: string;
  /** Last `seq` the client has; the server would continue with `after + 1`. */
  readonly after: number;
}

/** What the client asks for when it connects. The server applies defaults and clamps (see `hello.stream`). */
export interface ConnectionParams {
  /** Protocol version the client speaks (`v`), normally `PROTOCOL_VERSION`. */
  readonly version: number;
  /** Events per second (`rate`). */
  readonly rate?: number;
  readonly scenario?: Scenario;
  /** PRNG seed (`seed`), an unsigned 32-bit integer. */
  readonly seed?: number;
  /** `resume` + `after`, reserved for B4. */
  readonly resume?: ResumePoint;
}

/** Why a query parameter was rejected. */
export type ConnectionParamProblem =
  | 'missing'
  | 'bad-encoding'
  | 'not-an-integer'
  | 'out-of-range'
  | 'unknown-scenario'
  | 'empty'
  | 'unpaired';

/** A query parameter that could not be used. */
export interface ConnectionParamIssue {
  readonly param: ConnectionParamName;
  /**
   * The value as it appeared in the query (still percent-encoded), cut to
   * `MAX_ISSUE_VALUE_LENGTH` characters so it fits a close reason (123 bytes).
   */
  readonly value: string;
  readonly problem: ConnectionParamProblem;
}

/** Result of reading a connection query. */
export interface ParsedConnectionQuery {
  readonly params: ConnectionParams;
  /** Optional parameters that were present but invalid and therefore left out of `params`. */
  readonly ignored: readonly ConnectionParamIssue[];
}

/** Builds the query string (without `?`) for {@link ConnectionParams}. Values are not validated. */
export function buildConnectionQuery(params: ConnectionParams): string {
  const parts = [`v=${String(params.version)}`];
  if (params.rate !== undefined) parts.push(`rate=${String(params.rate)}`);
  if (params.scenario !== undefined) parts.push(`scenario=${encodeURIComponent(params.scenario)}`);
  if (params.seed !== undefined) parts.push(`seed=${String(params.seed)}`);
  if (params.resume !== undefined) {
    parts.push(
      `resume=${encodeURIComponent(params.resume.streamId)}`,
      `after=${String(params.resume.after)}`,
    );
  }
  return parts.join('&');
}

/** Appends the connection query to an endpoint such as `ws://localhost:8787/ws`. */
export function buildConnectionUrl(endpoint: string, params: ConnectionParams): string {
  const separator = endpoint.includes('?') ? '&' : '?';
  return `${endpoint}${separator}${buildConnectionQuery(params)}`;
}

/**
 * Reads the connection query (with or without the leading `?`). Tolerant: unknown parameters are
 * skipped, the first occurrence of a repeated one wins, and an invalid optional parameter is left
 * out and reported in `ignored`, so the server falls back to its default. Only a missing or invalid
 * `v` is an error — the server answers it with close code 4001.
 */
export function parseConnectionQuery(
  query: string,
): Result<ParsedConnectionQuery, ConnectionParamIssue> {
  const raw = readQuery(query);
  const ignored: ConnectionParamIssue[] = [];

  const v = raw.get('v');
  if (v === undefined) return err({ param: 'v', value: '', problem: 'missing' });
  const version = readInteger(v, 1, Number.MAX_SAFE_INTEGER);
  if (typeof version !== 'number') return err({ param: 'v', value: v.raw, problem: version });

  let params: ConnectionParams = { version };

  const rate = raw.get('rate');
  if (rate !== undefined) {
    const value = readInteger(rate, 0, Number.MAX_SAFE_INTEGER);
    if (typeof value === 'number') params = { ...params, rate: value };
    else ignored.push({ param: 'rate', value: rate.raw, problem: value });
  }

  const scenario = raw.get('scenario');
  if (scenario !== undefined) {
    const value = scenario.decoded;
    if (isScenario(value)) params = { ...params, scenario: value };
    else {
      const problem = value === undefined ? 'bad-encoding' : 'unknown-scenario';
      ignored.push({ param: 'scenario', value: scenario.raw, problem });
    }
  }

  const seed = raw.get('seed');
  if (seed !== undefined) {
    const value = readInteger(seed, 0, MAX_SEED);
    if (typeof value === 'number') params = { ...params, seed: value };
    else ignored.push({ param: 'seed', value: seed.raw, problem: value });
  }

  const resume = readResume(raw.get('resume'), raw.get('after'), ignored);
  if (resume !== undefined) params = { ...params, resume };

  return ok({ params, ignored });
}

/** Longest `ConnectionParamIssue.value`; longer values are cut. */
export const MAX_ISSUE_VALUE_LENGTH = 64;

interface RawParam {
  /** The value as it appeared in the query, cut to `MAX_ISSUE_VALUE_LENGTH` for issues. */
  readonly raw: string;
  /** Percent-decoded value; `undefined` when the encoding is malformed. */
  readonly decoded: string | undefined;
}

const KNOWN_PARAM_NAMES: readonly string[] = PARAM_NAMES;

function isParamName(name: string): name is ConnectionParamName {
  return KNOWN_PARAM_NAMES.includes(name);
}

function readQuery(query: string): Map<ConnectionParamName, RawParam> {
  const params = new Map<ConnectionParamName, RawParam>();
  const text = query.startsWith('?') ? query.slice(1) : query;
  for (const pair of text.split('&')) {
    const separator = pair.indexOf('=');
    const name = decodeComponent(separator === -1 ? pair : pair.slice(0, separator));
    if (name === undefined || !isParamName(name) || params.has(name)) continue;
    const raw = separator === -1 ? '' : pair.slice(separator + 1);
    params.set(name, { raw: raw.slice(0, MAX_ISSUE_VALUE_LENGTH), decoded: decodeComponent(raw) });
  }
  return params;
}

/** Decodes like `URLSearchParams` (`+` is a space); `undefined` for malformed percent-encoding. */
function decodeComponent(text: string): string | undefined {
  try {
    return decodeURIComponent(text.replaceAll('+', ' '));
  } catch {
    return undefined;
  }
}

const DECIMAL_INTEGER = /^\d+$/;

function readInteger(
  param: RawParam,
  min: number,
  max: number,
): number | 'bad-encoding' | 'not-an-integer' | 'out-of-range' {
  if (param.decoded === undefined) return 'bad-encoding';
  if (!DECIMAL_INTEGER.test(param.decoded)) return 'not-an-integer';
  const value = Number(param.decoded);
  return value >= min && value <= max ? value : 'out-of-range';
}

function readResume(
  resume: RawParam | undefined,
  after: RawParam | undefined,
  ignored: ConnectionParamIssue[],
): ResumePoint | undefined {
  // `resume` and `after` only make sense together; a lone one is dropped.
  if (resume === undefined) {
    if (after !== undefined)
      ignored.push({ param: 'after', value: after.raw, problem: 'unpaired' });
    return undefined;
  }
  if (after === undefined) {
    ignored.push({ param: 'resume', value: resume.raw, problem: 'unpaired' });
    return undefined;
  }
  const streamId = resume.decoded;
  if (streamId === undefined || streamId === '') {
    const problem = streamId === undefined ? 'bad-encoding' : 'empty';
    ignored.push({ param: 'resume', value: resume.raw, problem });
    return undefined;
  }
  const seq = readInteger(after, 0, Number.MAX_SAFE_INTEGER);
  if (typeof seq !== 'number') {
    ignored.push({ param: 'after', value: after.raw, problem: seq });
    return undefined;
  }
  return { streamId, after: seq };
}
