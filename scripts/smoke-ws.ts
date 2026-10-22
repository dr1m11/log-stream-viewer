/**
 * Smoke test of a running mock server: `GET /healthz` answers (with the expected commit as
 * `version`, if given), and a WebSocket opened with the given `Origin` receives `hello` and at least
 * one non-empty `batch` (protocol v1, parsed with @lsv/protocol).
 *
 *   node scripts/smoke-ws.ts <ws-url> [--origin <origin>] [--expect-version <sha>] [--timeout <ms>]
 *
 * Failed attempts are retried until the timeout (default 30 s): a suspended Fly machine resumes on
 * the first request and a fresh container may still be starting. A rejected Origin (HTTP 403) or a
 * terminal close code fails at once. Exits 0 when the stream works, 1 otherwise.
 *
 * Used by .github/workflows/deploy.yml (production) and ci.yml (`server-image`, the Docker image).
 */
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import {
  buildConnectionUrl,
  CLOSE_CODES,
  err,
  type HelloMessage,
  isTerminalCloseCode,
  ok,
  parseServerMessage,
  PROTOCOL_VERSION,
  type Result,
} from '@lsv/protocol';
import { type RawData, WebSocket } from 'ws';

export const USAGE =
  'Usage: node scripts/smoke-ws.ts <ws-url> [--origin <origin>] [--expect-version <sha>] [--timeout <ms>]';
export const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
/** One `/healthz` request or stream attempt gives up after this long (or at the deadline). */
const ATTEMPT_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 1000;
/** After success, how long to wait for the server to confirm the close before exiting anyway. */
const CLOSE_WAIT_MS = 1000;

export interface SmokeOptions {
  /** WebSocket URL with `?v=`, e.g. `wss://log-stream-viewer-mock.fly.dev/ws?v=1`. */
  readonly streamUrl: string;
  /** `http(s)://<same host>/healthz`. */
  readonly healthUrl: string;
  /** `Origin` header of the handshake; none when unset (production servers reject that). */
  readonly origin: string | undefined;
  /** Commit that `/healthz` must report as `version`. */
  readonly expectVersion: string | undefined;
  /** Deadline for the whole test, retries included. */
  readonly timeoutMs: number;
}

/** Why an attempt failed and whether trying again may help. */
export interface Failure {
  readonly message: string;
  readonly retry: boolean;
  /** The attempt ran out of its time budget rather than getting an answer. */
  readonly timedOut?: boolean;
}

export interface HealthSummary {
  readonly version: string;
  /** The whole `/healthz` body, for the log. */
  readonly body: Readonly<Record<string, unknown>>;
}

export interface StreamSummary {
  readonly hello: HelloMessage;
  /** Events of the first non-empty batch. */
  readonly events: number;
  readonly firstSeq: number;
  readonly lastSeq: number;
}

export type ProbeStep =
  | { readonly kind: 'waiting' }
  | ({ readonly kind: 'done' } & StreamSummary)
  | { readonly kind: 'failed'; readonly reason: string };

const DECIMAL_INTEGER = /^\d+$/;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(text: string, length = 200): string {
  return text.length <= length ? text : `${text.slice(0, length)}…`;
}

/** `ws://host/ws` → `http://host/healthz`, `wss://` → `https://`. */
export function healthUrlFor(endpoint: URL): string {
  const url = new URL(endpoint.href);
  url.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/healthz';
  url.search = '';
  url.hash = '';
  return url.href;
}

/** Adds `v=PROTOCOL_VERSION` unless the URL already names a version (e.g. to test 4001). */
export function streamUrlFor(endpoint: URL): string {
  const url = new URL(endpoint.href);
  url.hash = '';
  return url.searchParams.has('v')
    ? url.href
    : buildConnectionUrl(url.href, { version: PROTOCOL_VERSION });
}

function isOrigin(value: string): boolean {
  const url = URL.parse(value);
  return (
    url !== null && (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value
  );
}

/** Reads the command line (without `node` and the script path). */
export function parseSmokeArgs(args: readonly string[]): Result<SmokeOptions, string> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        origin: { type: 'string' },
        'expect-version': { type: 'string' },
        timeout: { type: 'string' },
      },
    });
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  }
  const { positionals, values } = parsed;
  const [target] = positionals;
  if (target === undefined || positionals.length > 1) {
    return err(`expected exactly one WebSocket URL, got ${String(positionals.length)}`);
  }
  const endpoint = URL.parse(target);
  if (endpoint === null || (endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:')) {
    return err(`not a ws:// or wss:// URL: ${JSON.stringify(target)}`);
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (values.timeout !== undefined) {
    timeoutMs = DECIMAL_INTEGER.test(values.timeout) ? Number(values.timeout) : Number.NaN;
    if (!(timeoutMs >= 1 && timeoutMs <= MAX_TIMEOUT_MS)) {
      return err(
        `--timeout must be milliseconds from 1 to ${String(MAX_TIMEOUT_MS)}, got ${JSON.stringify(values.timeout)}`,
      );
    }
  }
  const { origin } = values;
  if (origin !== undefined && !isOrigin(origin)) {
    return err(
      `--origin must be an origin like https://app.example.dev, got ${JSON.stringify(origin)}`,
    );
  }
  const expectVersion = values['expect-version']?.trim();
  if (expectVersion === '') return err('--expect-version must not be empty');

  return ok({
    streamUrl: streamUrlFor(endpoint),
    healthUrl: healthUrlFor(endpoint),
    origin,
    expectVersion,
    timeoutMs,
  });
}

/** Checks a `/healthz` response: HTTP 200, `{ status: 'ok', version }`, the expected version. */
export function checkHealth(
  status: number,
  body: string,
  expectVersion: string | undefined,
): Result<HealthSummary, string> {
  if (status !== 200) return err(`HTTP ${String(status)}: ${truncate(body.trim())}`);
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return err(`not JSON: ${truncate(body.trim())}`);
  }
  if (!isRecord(value) || value.status !== 'ok' || typeof value.version !== 'string') {
    return err(`expected { status: "ok", version }, got ${truncate(body.trim())}`);
  }
  if (expectVersion !== undefined && value.version !== expectVersion) {
    return err(
      `version is ${JSON.stringify(value.version)}, expected ${JSON.stringify(expectVersion)}`,
    );
  }
  return ok({ version: value.version, body: value });
}

/** Follows the start of a stream: `hello` first, then at least one non-empty `batch`. */
export class StreamProbe {
  #hello: HelloMessage | undefined;

  get hello(): HelloMessage | undefined {
    return this.#hello;
  }

  receive(text: string): ProbeStep {
    const parsed = parseServerMessage(text);
    if (!parsed.ok) {
      // Clients ignore message types they do not know (docs/protocol.md).
      if (parsed.error.kind === 'unknown-type') return { kind: 'waiting' };
      return { kind: 'failed', reason: `invalid server message: ${parsed.error.message}` };
    }
    const message = parsed.value;
    if (this.#hello === undefined) {
      if (message.type !== 'hello') {
        return { kind: 'failed', reason: `expected hello first, got ${message.type}` };
      }
      if (message.protocolVersion !== PROTOCOL_VERSION) {
        return {
          kind: 'failed',
          reason: `hello.protocolVersion is ${String(message.protocolVersion)}, expected ${String(PROTOCOL_VERSION)}`,
        };
      }
      this.#hello = message;
      return { kind: 'waiting' };
    }
    switch (message.type) {
      case 'batch': {
        const first = message.events[0];
        const last = message.events.at(-1);
        if (first === undefined || last === undefined) return { kind: 'waiting' };
        return {
          kind: 'done',
          hello: this.#hello,
          events: message.events.length,
          firstSeq: first.seq,
          lastSeq: last.seq,
        };
      }
      case 'hello':
        return { kind: 'failed', reason: 'a second hello on the same connection' };
      case 'error':
        return { kind: 'failed', reason: `server error ${message.code}: ${message.message}` };
      case 'heartbeat':
      case 'config':
        return { kind: 'waiting' };
    }
  }
}

/** A close before the stream proved itself. 4000 and 4001 end a session for good; busy (4029), going away (1001, a redeploy) and abnormal closes (1006) may pass. */
export function closeFailure(code: number, reason: string): Failure {
  const details = reason === '' ? '' : ` (${truncate(reason)})`;
  return {
    message: `the server closed the stream with ${String(code)}${details}`,
    retry: !isTerminalCloseCode(code),
  };
}

/** The server answered the upgrade with a plain HTTP status. */
export function handshakeFailure(status: number): Failure {
  if (status === 403) {
    return {
      message:
        'handshake rejected with HTTP 403: the Origin is not in ALLOWED_ORIGINS (production also rejects a missing Origin)',
      retry: false,
    };
  }
  // 5xx: Fly's proxy while the machine starts or resumes.
  return { message: `handshake rejected with HTTP ${String(status)}`, retry: status >= 500 };
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const { cause } = error;
  if (cause instanceof Error) return `${error.message}: ${cause.message}`;
  return error.message;
}

function textOf(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

async function fetchHealth(
  options: SmokeOptions,
  timeoutMs: number,
): Promise<Result<HealthSummary, Failure>> {
  try {
    const response = await fetch(options.healthUrl, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const checked = checkHealth(response.status, await response.text(), options.expectVersion);
    // A wrong version is retried too: the old release may still answer for a moment.
    return checked.ok ? checked : err({ message: checked.error, retry: true });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return err({ message: describeError(error), retry: true, timedOut });
  }
}

function probeStream(
  options: SmokeOptions,
  timeoutMs: number,
): Promise<Result<StreamSummary, Failure>> {
  return new Promise((resolve) => {
    const ws = new WebSocket(options.streamUrl, {
      origin: options.origin,
      handshakeTimeout: timeoutMs,
    });
    const probe = new StreamProbe();
    let settled = false;

    const finish = (result: Result<StreamSummary, Failure>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!result.ok) {
        ws.terminate();
        resolve(result);
        return;
      }
      // Close cleanly so the server logs 1000, but do not wait for it forever.
      const closed = new Promise((done) => ws.once('close', done));
      ws.close(CLOSE_CODES.normal, 'smoke test passed');
      void Promise.race([closed, sleep(CLOSE_WAIT_MS)]).then(() => {
        resolve(result);
      });
    };

    const timer = setTimeout(() => {
      const waitingFor = probe.hello === undefined ? 'hello' : 'batch';
      finish(
        err({
          message: `no ${waitingFor} within ${String(timeoutMs)} ms`,
          retry: true,
          timedOut: true,
        }),
      );
    }, timeoutMs);

    ws.on('unexpected-response', (_request, response) => {
      response.resume();
      finish(err(handshakeFailure(response.statusCode ?? 0)));
    });
    ws.on('error', (error) => {
      finish(err({ message: `connection failed: ${describeError(error)}`, retry: true }));
    });
    ws.on('close', (code, reason) => {
      finish(err(closeFailure(code, reason.toString('utf8'))));
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        finish(err({ message: 'unexpected binary frame (v1 sends text only)', retry: false }));
        return;
      }
      const step = probe.receive(textOf(data));
      if (step.kind === 'failed') finish(err({ message: step.reason, retry: false }));
      else if (step.kind === 'done') finish(ok(step));
    });
  });
}

/** Repeats `attempt` until it succeeds, fails for good or the deadline (`performance.now()`) passes. */
async function untilDeadline<T>(
  label: string,
  attempt: (timeoutMs: number) => Promise<Result<T, Failure>>,
  deadline: number,
  retryDelayMs: number,
  log: (line: string) => void,
): Promise<Result<T, string>> {
  let previous: string | undefined;
  for (let count = 1; ; count++) {
    // Whole milliseconds: AbortSignal.timeout() rejects fractions.
    const timeoutMs = Math.max(
      1,
      Math.ceil(Math.min(ATTEMPT_TIMEOUT_MS, deadline - performance.now())),
    );
    const result = await attempt(timeoutMs);
    if (result.ok) return result;
    const { message, retry, timedOut } = result.error;
    if (!retry) return err(`${label}: ${message}`);
    if (deadline - performance.now() <= retryDelayMs) {
      // A last attempt cut short by the deadline only says that time ran out; the one before says why.
      if (timedOut === true && timeoutMs < ATTEMPT_TIMEOUT_MS && previous !== undefined) {
        return err(
          `${label}: ${previous} (gave up after ${String(count)} attempts; the last one hit the deadline)`,
        );
      }
      return err(`${label}: ${message} (gave up after ${String(count)} attempts)`);
    }
    previous = message;
    log(`  ${label} attempt ${String(count)}: ${message}; retrying`);
    await sleep(retryDelayMs);
  }
}

export interface SmokeDeps {
  readonly log: (line: string) => void;
  readonly retryDelayMs: number;
}

/** Runs the health check and the stream check within `options.timeoutMs`. */
export async function runSmoke(
  options: SmokeOptions,
  { log, retryDelayMs }: SmokeDeps = { log: console.log, retryDelayMs: RETRY_DELAY_MS },
): Promise<Result<{ health: HealthSummary; stream: StreamSummary }, string>> {
  const deadline = performance.now() + options.timeoutMs;

  const expecting =
    options.expectVersion === undefined ? '' : ` (expecting version ${options.expectVersion})`;
  log(`GET ${options.healthUrl}${expecting}`);
  const health = await untilDeadline(
    'healthz',
    (timeoutMs) => fetchHealth(options, timeoutMs),
    deadline,
    retryDelayMs,
    log,
  );
  if (!health.ok) return health;
  log(`  ok ${JSON.stringify(health.value.body)}`);

  log(`WebSocket ${options.streamUrl} with Origin ${options.origin ?? '(none)'}`);
  const stream = await untilDeadline(
    'stream',
    (timeoutMs) => probeStream(options, timeoutMs),
    deadline,
    retryDelayMs,
    log,
  );
  if (!stream.ok) return stream;
  const { hello, events, firstSeq, lastSeq } = stream.value;
  log(
    `  ok hello: stream ${hello.streamId}, ${String(hello.stream.rate)} events/s, ${hello.stream.scenario}, ` +
      `maxRate ${String(hello.limits.maxRate)}, session ${String(hello.limits.sessionMaxMs / 1000)} s`,
  );
  log(`  ok batch: ${String(events)} events, seq ${String(firstSeq)}..${String(lastSeq)}`);
  return ok({ health: health.value, stream: stream.value });
}

async function main(args: readonly string[]): Promise<number> {
  const options = parseSmokeArgs(args);
  if (!options.ok) {
    console.error(`smoke-ws: ${options.error}\n${USAGE}`);
    return 1;
  }
  const started = performance.now();
  const result = await runSmoke(options.value);
  if (!result.ok) {
    console.error(`smoke-ws: FAIL ${result.error}`);
    return 1;
  }
  console.log(`smoke-ws: PASS in ${((performance.now() - started) / 1000).toFixed(1)} s`);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
