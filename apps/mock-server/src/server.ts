import { randomInt, randomUUID } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
  STATUS_CODES,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createHistogram,
  type Histogram,
  monitorEventLoopDelay,
  performance,
} from 'node:perf_hooks';
import process from 'node:process';
import type { Duplex } from 'node:stream';

import {
  BATCH_INTERVAL_MS,
  busyCloseReason,
  CLOSE_CODES,
  DEFAULT_SCENARIO,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_SEED,
  MIN_RATE,
  parseConnectionQuery,
  PROTOCOL_VERSION,
  STREAM_PATH,
  type StreamLimits,
} from '@lsv/protocol';
import {
  type PerMessageDeflateOptions,
  type RawData,
  type ServerOptions,
  type WebSocket,
  WebSocketServer,
} from 'ws';

import { clientAddress, ipKey } from './client-ip.ts';
import { isOriginAllowed, type ServerConfig } from './config.ts';
import { StreamHub } from './hub.ts';
import { clampRate, Session } from './session.ts';

/** Delay a client should wait after a 4029 rejection (`busy; retry-after=30`). */
export const BUSY_RETRY_AFTER_S = 30;
/**
 * A socket the server closed (rejection, expiry, shutdown) that does not finish the closing
 * handshake within this time is destroyed, so it frees its slot (ws `closeTimeout`).
 */
export const CLOSE_TIMEOUT_MS = 5000;
/** On shutdown, clients get this long to answer the 1001 close before their sockets are destroyed. */
const SHUTDOWN_GRACE_MS = 2000;
/**
 * Flood protection: sockets (open, rejected or still closing) the server tolerates beyond
 * `MAX_CONNECTIONS` before it refuses handshakes with HTTP 503. Browsers see that only as 1006,
 * which is acceptable here — legitimate clients get 4029 long before.
 */
export const UPGRADE_HEADROOM = 10;
/** `/healthz` reports latency percentiles over windows of this length. */
const STATS_WINDOW_MS = 10_000;
/** A failing tick is logged at most this often. */
const TICK_ERROR_LOG_INTERVAL_MS = 10_000;

/**
 * permessage-deflate settings of every deployment: fast compression (level 1) with the server
 * keeping its compression context between messages, which is where the ratio comes from (keys
 * repeat across batches). With context takeover ws compresses every message — its `threshold`
 * option applies only without it — so none is set. Smaller zlib windows were measured and
 * rejected (docs/adr/0005).
 */
export const DEFLATE_OPTIONS: PerMessageDeflateOptions = {
  zlibDeflateOptions: { level: 1 },
};

/** Side effects and tuning of the server, replaceable in tests and measurements. */
export interface ServerDeps {
  /** Wall clock, epoch ms. */
  readonly clock: () => number;
  /** Writes one log line. */
  readonly log: (line: string) => void;
  readonly newStreamId: () => string;
  /** Seed for a client that did not ask for one. */
  readonly newSeed: () => number;
  /** permessage-deflate settings, or `false` to turn it off (measurements only). */
  readonly perMessageDeflate: PerMessageDeflateOptions | false;
  /** See {@link CLOSE_TIMEOUT_MS}. */
  readonly closeTimeoutMs: number;
  /** Length of the `/healthz` latency windows. */
  readonly statsWindowMs: number;
}

const DEFAULT_DEPS: ServerDeps = {
  clock: () => Date.now(),
  log: (line) => {
    console.log(line);
  },
  newStreamId: () => `st_${randomUUID().replaceAll('-', '')}`,
  newSeed: () => randomInt(0, MAX_SEED + 1),
  perMessageDeflate: DEFLATE_OPTIONS,
  closeTimeoutMs: CLOSE_TIMEOUT_MS,
  statsWindowMs: STATS_WINDOW_MS,
};

/** Percentiles of a latency in milliseconds. */
export interface LatencySummary {
  readonly p50: number;
  readonly p99: number;
  readonly max: number;
}

/** `/healthz` response body. */
export interface Health {
  readonly status: 'ok';
  /** `GIT_SHA` of the deployment. */
  readonly version: string;
  readonly uptimeS: number;
  /** Open streams. */
  readonly connections: number;
  readonly eventsPerSec: number;
  /** Resident set size of the process. */
  readonly rssMb: number;
  /** Event-loop delay over the last complete stats window (the current one before that). */
  readonly eventLoopDelayMs: LatencySummary;
  /** Duration of one tick (all streams) over the same window. */
  readonly tickMs: LatencySummary;
}

export interface MockServer {
  /** Starts listening on `config.host:config.port` (port 0 picks a free port). */
  listen(): Promise<AddressInfo>;
  /** Closes every stream with 1001, stops the tick timer and the HTTP server. Idempotent; never rejects. */
  close(): Promise<void>;
  /** Where the server listens, once it does. */
  readonly address: AddressInfo | undefined;
  /** The `/healthz` body. */
  health(): Health;
  /** Starts a new latency window now (benchmarks measure from a known point). */
  resetStats(): void;
}

/** JSON string of a client-supplied value for log lines: quoted, escaped and truncated. */
function quote(value: string | undefined): string {
  return value === undefined ? '-' : JSON.stringify(value.slice(0, 200));
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function splitTarget(target = '/'): { pathname: string; query: string } {
  const mark = target.indexOf('?');
  return mark === -1
    ? { pathname: target, query: '' }
    : { pathname: target.slice(0, mark), query: target.slice(mark + 1) };
}

function rawDataToText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

/** Answers a handshake with a plain HTTP error instead of upgrading it. */
function abortHandshake(socket: Duplex, status: number): void {
  const text = STATUS_CODES[status] ?? 'Error';
  const body = `${text}\n`;
  socket.once('finish', () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${String(status)} ${text}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${String(Buffer.byteLength(body))}\r\n\r\n${body}`,
  );
}

/** Resolves when the socket has closed; never rejects (a socket `error` must not break shutdown). */
function waitForClose(ws: WebSocket): Promise<void> {
  if (ws.readyState === ws.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    ws.once('close', () => {
      resolve();
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Percentiles of a histogram recorded in `unitsPerMs` units (ns for the event loop, µs for ticks). */
function summarize(histogram: Histogram, unitsPerMs: number): LatencySummary {
  if (histogram.count === 0) return { p50: 0, p99: 0, max: 0 };
  return {
    p50: round2(histogram.percentile(50) / unitsPerMs),
    p99: round2(histogram.percentile(99) / unitsPerMs),
    max: round2(histogram.max / unitsPerMs),
  };
}

/**
 * The mock log server: `GET /healthz`, `GET /` and the WebSocket stream at `/ws` (protocol v1,
 * `docs/protocol.md`) with all limits of `config`.
 */
export function createServer(
  config: ServerConfig,
  overrides: Partial<ServerDeps> = {},
): MockServer {
  const deps: ServerDeps = { ...DEFAULT_DEPS, ...overrides };
  const { clock, log } = deps;
  const startedAt = clock();
  const limits: StreamLimits = {
    minRate: MIN_RATE,
    maxRate: config.maxRate,
    sessionMaxMs: config.sessionMaxMs,
  };
  const hub = new StreamHub<Session>(config.globalMaxEventsPerSec, startedAt, (session, error) => {
    // The hub has dropped the session; it is logged once and its socket destroyed.
    log(`session-error stream=${session.streamId} error=${quote(errorText(error))}`);
    session.terminate();
  });
  const connectionsPerIp = new Map<string, number>();
  let ticker: NodeJS.Timeout | undefined;
  let closing: Promise<void> | undefined;
  let lastTickErrorAt = Number.NEGATIVE_INFINITY;

  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  const tickDurations = createHistogram();
  let statsWindowStart = startedAt;
  let lastWindow: Pick<Health, 'eventLoopDelayMs' | 'tickMs'> | undefined;

  const http = createHttpServer(handleRequest);
  // `closeTimeout` exists in ws 8.22 but not yet in @types/ws 8.18.
  const wsOptions: ServerOptions & { readonly closeTimeout: number } = {
    noServer: true,
    maxPayload: MAX_CLIENT_MESSAGE_BYTES,
    perMessageDeflate: deps.perMessageDeflate,
    // Browsers never send pings; answering them would let a client that does not read make the
    // server queue pongs. Liveness is the server's own ping/pong (session.ts).
    autoPong: false,
    closeTimeout: deps.closeTimeoutMs,
  };
  const wss = new WebSocketServer(wsOptions);
  http.on('upgrade', handleUpgrade);

  function windowStats(): Pick<Health, 'eventLoopDelayMs' | 'tickMs'> {
    return { eventLoopDelayMs: summarize(loopDelay, 1e6), tickMs: summarize(tickDurations, 1e3) };
  }

  function resetStats(now: number): void {
    loopDelay.reset();
    tickDurations.reset();
    statsWindowStart = now;
  }

  function rollStats(now: number): void {
    if (now - statsWindowStart < deps.statsWindowMs) return;
    lastWindow = windowStats();
    resetStats(now);
  }

  function tick(): void {
    const begin = performance.now();
    const now = clock();
    try {
      hub.tick(now);
    } catch (error) {
      if (now - lastTickErrorAt >= TICK_ERROR_LOG_INTERVAL_MS) {
        lastTickErrorAt = now;
        log(`tick-error ${quote(errorText(error))}`);
      }
    }
    tickDurations.record(Math.max(1, Math.round((performance.now() - begin) * 1000)));
    rollStats(now);
  }

  function health(): Health {
    const now = clock();
    rollStats(now);
    return {
      status: 'ok',
      version: config.gitSha,
      uptimeS: Math.floor((now - startedAt) / 1000),
      connections: hub.size,
      eventsPerSec: hub.eventsPerSec(now),
      rssMb: Math.round(process.memoryUsage.rss() / 1024 / 1024),
      ...(lastWindow ?? windowStats()),
    };
  }

  function handleRequest(request: IncomingMessage, response: ServerResponse): void {
    const { pathname } = splitTarget(request.url);
    const head = request.method === 'HEAD';
    const reply = (
      status: number,
      type: string,
      body: string,
      headers: OutgoingHttpHeaders = {},
    ) => {
      response.writeHead(status, {
        'Content-Type': type,
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...headers,
      });
      response.end(head ? undefined : body);
    };
    const text = 'text/plain; charset=utf-8';
    if (request.method !== 'GET' && !head) {
      reply(405, text, 'Method Not Allowed\n', { Allow: 'GET, HEAD' });
      return;
    }
    switch (pathname) {
      case '/healthz':
        reply(200, 'application/json', JSON.stringify(health()));
        return;
      case '/':
        reply(
          200,
          text,
          `Log Stream Viewer mock server. Open a WebSocket at ${STREAM_PATH}?v=${String(PROTOCOL_VERSION)} (see docs/protocol.md).\n`,
        );
        return;
      case STREAM_PATH:
        reply(426, text, 'Upgrade Required: connect with a WebSocket client\n', {
          Upgrade: 'websocket',
        });
        return;
      default:
        reply(404, text, 'Not Found\n');
    }
  }

  function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const destroy = () => socket.destroy();
    socket.on('error', destroy);
    const { pathname, query } = splitTarget(request.url);
    if (pathname !== STREAM_PATH) {
      abortHandshake(socket, 404);
      return;
    }
    const address = clientAddress(
      request.headers['fly-client-ip'],
      request.socket.remoteAddress,
      config.trustProxyIpHeader,
    );
    const origin = request.headers.origin;
    if (!isOriginAllowed(config.origins, origin)) {
      log(`reject status=403 reason=origin origin=${quote(origin)} ip=${quote(address)}`);
      abortHandshake(socket, 403);
      return;
    }
    if (wss.clients.size >= config.maxConnections + UPGRADE_HEADROOM) {
      log(
        `reject status=503 reason=flood sockets=${String(wss.clients.size)} ip=${quote(address)}`,
      );
      abortHandshake(socket, 503);
      return;
    }
    socket.off('error', destroy);
    wss.handleUpgrade(request, socket, head, (ws) => {
      accept(ws, address, query);
    });
  }

  /**
   * Closes an upgraded socket with a close code (browsers cannot read HTTP statuses). A peer that
   * never answers the close is destroyed after `closeTimeoutMs`.
   */
  function reject(ws: WebSocket, code: number, reason: string, details: string): void {
    log(`reject code=${String(code)} ${details}`);
    ws.on('error', () => undefined);
    ws.close(code, reason);
  }

  function accept(ws: WebSocket, address: string, query: string): void {
    const parsed = parseConnectionQuery(query);
    if (!parsed.ok || parsed.value.params.version !== PROTOCOL_VERSION) {
      // The issue value is already cut to MAX_ISSUE_VALUE_LENGTH by the protocol parser.
      const detail = parsed.ok
        ? `v=${String(parsed.value.params.version)}`
        : `problem=${parsed.error.problem} v=${quote(parsed.error.value)}`;
      reject(
        ws,
        CLOSE_CODES.unsupportedVersion,
        'unsupported protocol version',
        `reason=version ${detail} ip=${quote(address)}`,
      );
      return;
    }
    if (closing !== undefined) {
      reject(
        ws,
        CLOSE_CODES.goingAway,
        'server shutting down',
        `reason=shutdown ip=${quote(address)}`,
      );
      return;
    }
    const busy = busyCloseReason(BUSY_RETRY_AFTER_S);
    if (hub.size >= config.maxConnections) {
      reject(ws, CLOSE_CODES.busy, busy, `reason=capacity ip=${quote(address)}`);
      return;
    }
    const key = ipKey(address);
    const fromIp = connectionsPerIp.get(key) ?? 0;
    if (fromIp >= config.maxConnectionsPerIp) {
      reject(ws, CLOSE_CODES.busy, busy, `reason=per-ip ip=${quote(address)} key=${quote(key)}`);
      return;
    }

    const { params, ignored } = parsed.value;
    const session = new Session({
      socket: ws,
      streamId: deps.newStreamId(),
      settings: {
        rate: clampRate(params.rate ?? config.defaultRate, limits),
        scenario: params.scenario ?? DEFAULT_SCENARIO,
        seed: params.seed ?? deps.newSeed(),
      },
      limits,
      now: clock(),
    });
    connectionsPerIp.set(key, fromIp + 1);
    hub.add(session);
    ticker ??= setInterval(tick, BATCH_INTERVAL_MS);

    ws.on('error', (error) => {
      const code = 'code' in error ? String(error.code) : error.name;
      log(`ws-error stream=${session.streamId} error=${quote(code)}`);
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) session.receiveBinary(clock());
      else session.receive(rawDataToText(data), clock());
    });
    ws.on('pong', () => {
      session.pong();
    });
    ws.once('close', (code) => {
      hub.remove(session);
      const left = (connectionsPerIp.get(key) ?? 1) - 1;
      if (left > 0) connectionsPerIp.set(key, left);
      else connectionsPerIp.delete(key);
      if (hub.size === 0 && ticker !== undefined) {
        clearInterval(ticker);
        ticker = undefined;
      }
      const durationS = ((clock() - session.startedAt) / 1000).toFixed(1);
      const ignoredFrames =
        session.ignoredFrames > 0 ? ` ignoredFrames=${String(session.ignoredFrames)}` : '';
      log(
        `close stream=${session.streamId} code=${String(code)} reason=${session.endReason ?? 'client'} ` +
          `durationS=${durationS} sent=${String(session.sentEvents)} dropped=${String(session.droppedEvents)}` +
          `${ignoredFrames} connections=${String(hub.size)}`,
      );
    });

    session.start();
    const { rate, scenario, seed } = session.settings;
    const skipped = ignored.map((issue) => issue.param).join(',');
    // Resume is reserved for B4 (docs/protocol.md): a B1 server always starts a new stream.
    const resume = params.resume === undefined ? '' : ' resume=ignored';
    log(
      `connect stream=${session.streamId} ip=${quote(address)} rate=${String(rate)} scenario=${scenario} ` +
        `seed=${String(seed)}${skipped === '' ? '' : ` ignored=${skipped}`}${resume} ` +
        `connections=${String(hub.size)}`,
    );
  }

  /** Always runs to the end: a misbehaving client cannot keep the server listening. */
  async function shutdown(): Promise<void> {
    if (ticker !== undefined) {
      clearInterval(ticker);
      ticker = undefined;
    }
    try {
      for (const session of hub.streams()) {
        session.close(CLOSE_CODES.goingAway, 'server shutting down');
      }
      const clients = [...wss.clients];
      await Promise.race([Promise.all(clients.map(waitForClose)), delay(SHUTDOWN_GRACE_MS)]);
    } finally {
      const stragglers = [...wss.clients];
      for (const ws of stragglers) ws.terminate();
      await Promise.race([Promise.all(stragglers.map(waitForClose)), delay(SHUTDOWN_GRACE_MS)]);
      loopDelay.disable();
      await new Promise<void>((resolve) => {
        http.close(() => {
          resolve();
        });
        http.closeAllConnections();
      });
    }
  }

  return {
    listen() {
      return new Promise<AddressInfo>((resolve, rejectListen) => {
        const onError = (error: Error) => {
          rejectListen(error);
        };
        http.once('error', onError);
        http.listen(config.port, config.host, () => {
          http.off('error', onError);
          // Errors after the start (e.g. EMFILE on accept) must be logged, not crash the process.
          http.on('error', (error: NodeJS.ErrnoException) => {
            log(`http-error code=${error.code ?? error.name} ${quote(error.message)}`);
          });
          const address = http.address();
          if (address === null || typeof address === 'string') {
            rejectListen(new Error('The server is not listening on a TCP port'));
            return;
          }
          resolve(address);
        });
      });
    },
    close() {
      closing ??= shutdown().catch((error: unknown) => {
        log(`shutdown-error ${quote(errorText(error))}`);
      });
      return closing;
    },
    get address() {
      const address = http.address();
      return address === null || typeof address === 'string' ? undefined : address;
    },
    health,
    resetStats() {
      resetStats(clock());
      lastWindow = undefined;
    },
  };
}
