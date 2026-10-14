import { randomInt, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
  STATUS_CODES,
} from 'node:http';
import type { AddressInfo } from 'node:net';
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
import { type RawData, type WebSocket, WebSocketServer } from 'ws';

import { isOriginAllowed, type ServerConfig } from './config.ts';
import { StreamHub } from './hub.ts';
import { clampRate, Session } from './session.ts';

/** Delay a client should wait after a 4029 rejection (`busy; retry-after=30`). */
export const BUSY_RETRY_AFTER_S = 30;
/** A rejected socket that does not finish the closing handshake in time is destroyed. */
const REJECT_TIMEOUT_MS = 5000;
/** On shutdown, clients get this long to answer the 1001 close before their sockets are destroyed. */
const SHUTDOWN_GRACE_MS = 2000;

/** Side effects of the server, replaceable in tests and measurements. */
export interface ServerDeps {
  /** Wall clock, epoch ms. */
  readonly clock: () => number;
  /** Writes one log line. */
  readonly log: (line: string) => void;
  readonly newStreamId: () => string;
  /** Seed for a client that did not ask for one. */
  readonly newSeed: () => number;
  /** permessage-deflate; on in every deployment, off only to measure its cost. */
  readonly deflate: boolean;
}

const DEFAULT_DEPS: ServerDeps = {
  clock: () => Date.now(),
  log: (line) => {
    console.log(line);
  },
  newStreamId: () => `st_${randomUUID().replaceAll('-', '')}`,
  newSeed: () => randomInt(0, MAX_SEED + 1),
  deflate: true,
};

export interface MockServer {
  /** Starts listening on `config.host:config.port` (port 0 picks a free port). */
  listen(): Promise<AddressInfo>;
  /** Closes every stream with 1001, stops the tick timer and the HTTP server. Idempotent. */
  close(): Promise<void>;
  /** Where the server listens, once it does. */
  readonly address: AddressInfo | undefined;
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
}

/** JSON string of a client-supplied value for log lines: quoted, escaped and truncated. */
function quote(value: string | undefined): string {
  return value === undefined ? '-' : JSON.stringify(value.slice(0, 200));
}

function splitTarget(target = '/'): { pathname: string; query: string } {
  const mark = target.indexOf('?');
  return mark === -1
    ? { pathname: target, query: '' }
    : { pathname: target.slice(0, mark), query: target.slice(mark + 1) };
}

/** Client address: `Fly-Client-IP` behind the Fly proxy, the socket's peer otherwise. */
function clientIp(request: IncomingMessage): string {
  const header = request.headers['fly-client-ip'];
  const forwarded = (Array.isArray(header) ? header[0] : header)?.trim();
  const ip =
    forwarded !== undefined && forwarded !== ''
      ? forwarded
      : (request.socket.remoteAddress ?? 'unknown');
  return ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
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

function waitForClose(ws: WebSocket): Promise<void> {
  if (ws.readyState === ws.CLOSED) return Promise.resolve();
  return once(ws, 'close').then(() => undefined);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
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
  const hub = new StreamHub<Session>(config.globalMaxEventsPerSec, startedAt);
  const connectionsPerIp = new Map<string, number>();
  let ticker: NodeJS.Timeout | undefined;
  let closing: Promise<void> | undefined;

  const http = createHttpServer(handleRequest);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CLIENT_MESSAGE_BYTES,
    perMessageDeflate: deps.deflate ? { zlibDeflateOptions: { level: 1 }, threshold: 1024 } : false,
  });
  http.on('upgrade', handleUpgrade);

  function tick(): void {
    try {
      hub.tick(clock());
    } catch (error) {
      log(`tick-error ${quote(String(error))}`);
    }
  }

  function health(): Health {
    const now = clock();
    return {
      status: 'ok',
      version: config.gitSha,
      uptimeS: Math.floor((now - startedAt) / 1000),
      connections: hub.size,
      eventsPerSec: hub.eventsPerSec(now),
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
    const ip = clientIp(request);
    const origin = request.headers.origin;
    if (!isOriginAllowed(config.origins, origin)) {
      log(`reject status=403 reason=origin origin=${quote(origin)} ip=${quote(ip)}`);
      abortHandshake(socket, 403);
      return;
    }
    socket.off('error', destroy);
    wss.handleUpgrade(request, socket, head, (ws) => {
      accept(ws, ip, query);
    });
  }

  /** Closes an upgraded socket with an application close code (browsers cannot read HTTP statuses). */
  function reject(ws: WebSocket, code: number, reason: string, details: string): void {
    log(`reject code=${String(code)} ${details}`);
    ws.on('error', () => undefined);
    const timer = setTimeout(() => {
      ws.terminate();
    }, REJECT_TIMEOUT_MS).unref();
    ws.once('close', () => {
      clearTimeout(timer);
    });
    ws.close(code, reason);
  }

  function accept(ws: WebSocket, ip: string, query: string): void {
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
        `reason=version ${detail} ip=${quote(ip)}`,
      );
      return;
    }
    if (closing !== undefined) {
      reject(ws, CLOSE_CODES.goingAway, 'server shutting down', `reason=shutdown ip=${quote(ip)}`);
      return;
    }
    const busy = busyCloseReason(BUSY_RETRY_AFTER_S);
    if (hub.size >= config.maxConnections) {
      reject(ws, CLOSE_CODES.busy, busy, `reason=capacity ip=${quote(ip)}`);
      return;
    }
    const fromIp = connectionsPerIp.get(ip) ?? 0;
    if (fromIp >= config.maxConnectionsPerIp) {
      reject(ws, CLOSE_CODES.busy, busy, `reason=per-ip ip=${quote(ip)}`);
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
    connectionsPerIp.set(ip, fromIp + 1);
    hub.add(session);
    ticker ??= setInterval(tick, BATCH_INTERVAL_MS);

    ws.on('error', (error) => {
      const code = 'code' in error ? String(error.code) : error.name;
      log(`ws-error stream=${session.streamId} error=${quote(code)}`);
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) session.receiveBinary();
      else session.receive(rawDataToText(data), clock());
    });
    ws.on('pong', () => {
      session.pong();
    });
    ws.once('close', (code) => {
      hub.remove(session);
      const left = (connectionsPerIp.get(ip) ?? 1) - 1;
      if (left > 0) connectionsPerIp.set(ip, left);
      else connectionsPerIp.delete(ip);
      if (hub.size === 0 && ticker !== undefined) {
        clearInterval(ticker);
        ticker = undefined;
      }
      const durationS = ((clock() - session.startedAt) / 1000).toFixed(1);
      log(
        `close stream=${session.streamId} code=${String(code)} durationS=${durationS} ` +
          `sent=${String(session.sentEvents)} dropped=${String(session.droppedEvents)} connections=${String(hub.size)}`,
      );
    });

    session.start();
    const { rate, scenario, seed } = session.settings;
    const skipped = ignored.map((issue) => issue.param).join(',');
    // Resume is reserved for B4 (docs/protocol.md): a B1 server always starts a new stream.
    const resume = params.resume === undefined ? '' : ' resume=ignored';
    log(
      `connect stream=${session.streamId} ip=${quote(ip)} rate=${String(rate)} scenario=${scenario} ` +
        `seed=${String(seed)}${skipped === '' ? '' : ` ignored=${skipped}`}${resume} ` +
        `connections=${String(hub.size)}`,
    );
  }

  async function shutdown(): Promise<void> {
    if (ticker !== undefined) {
      clearInterval(ticker);
      ticker = undefined;
    }
    for (const session of hub.streams())
      session.close(CLOSE_CODES.goingAway, 'server shutting down');
    const clients = [...wss.clients];
    await Promise.race([Promise.all(clients.map(waitForClose)), delay(SHUTDOWN_GRACE_MS)]);
    const stragglers = [...wss.clients];
    for (const ws of stragglers) ws.terminate();
    await Promise.all(stragglers.map(waitForClose));
    await new Promise<void>((resolve) => {
      http.close(() => {
        resolve();
      });
      http.closeAllConnections();
    });
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
      closing ??= shutdown();
      return closing;
    },
    get address() {
      const address = http.address();
      return address === null || typeof address === 'string' ? undefined : address;
    },
  };
}
