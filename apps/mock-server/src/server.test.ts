import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import type { Duplex } from 'node:stream';

import {
  busyCloseReason,
  CLIENT_MESSAGE_BURST,
  CLOSE_CODES,
  isKnownErrorCode,
  type LogEvent,
  MAX_CLIENT_MESSAGE_BYTES,
  parseServerMessage,
  retryAfterSeconds,
  type ServerMessage,
} from '@lsv/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { type ClientOptions, type RawData, WebSocket } from 'ws';

import { parseConfig, type ServerConfig } from './config.ts';
import {
  BUSY_RETRY_AFTER_S,
  createServer,
  type MockServer,
  PER_IP_SOCKET_HEADROOM,
  type ServerDeps,
  UPGRADE_HEADROOM,
} from './server.ts';

// --- Fixtures -------------------------------------------------------------------------------------

const fixtureText = (name: string): string =>
  readFileSync(new URL(import.meta.resolve(`@lsv/protocol/fixtures/v1/${name}`)), 'utf8');
const fixture = (name: string): unknown => JSON.parse(fixtureText(name));

/** The structure of a JSON value: keys and `typeof` of the leaves, the first item of arrays. */
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.length === 0 ? [] : [shapeOf(value[0])];
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shapeOf(item)]));
  }
  return typeof value;
}

const FIXTURE_EVENTS: readonly Record<string, unknown>[] = (() => {
  const batch = fixture('batch.json');
  const events =
    typeof batch === 'object' && batch !== null && 'events' in batch ? batch.events : undefined;
  return Array.isArray(events) ? events.filter(isRecord) : [];
})();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every key of the event exists in the golden batch with the same JSON type; required keys exist. */
function expectEventShapeLikeFixtures(event: LogEvent): void {
  const types = new Map<string, string>();
  for (const sample of FIXTURE_EVENTS) {
    for (const [key, value] of Object.entries(sample)) types.set(key, typeof value);
  }
  const required = [...types.keys()].filter((key) =>
    FIXTURE_EVENTS.every((sample) => key in sample),
  );
  const keys = Object.keys(event);
  expect(keys.filter((key) => !types.has(key))).toEqual([]);
  expect(required.filter((key) => !keys.includes(key))).toEqual([]);
  for (const [key, value] of Object.entries(event)) expect(typeof value).toBe(types.get(key));
}

// --- Harness --------------------------------------------------------------------------------------

type MessageOf<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

const servers: MockServer[] = [];
const sockets: WebSocket[] = [];
const rawSockets: Duplex[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const socket of rawSockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function testConfig(overrides: Partial<ServerConfig>): ServerConfig {
  const defaults = parseConfig({});
  if (!defaults.ok) throw new Error(defaults.error.join('; '));
  return { ...defaults.value, port: 0, host: '127.0.0.1', ...overrides };
}

async function start(overrides: Partial<ServerConfig> = {}, deps: Partial<ServerDeps> = {}) {
  const logs: string[] = [];
  const server = createServer(testConfig(overrides), {
    log: (line) => logs.push(line),
    ...deps,
  });
  servers.push(server);
  const { port } = await server.listen();
  return { server, port, logs, url: `ws://127.0.0.1:${String(port)}/ws` };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Condition not met in time');
    await sleep(20);
  }
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

/** A real `ws` client that parses every server frame with the protocol parser. */
class TestClient {
  readonly ws: WebSocket;
  readonly messages: ServerMessage[] = [];
  readonly invalid: string[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  #waiters: ((message: ServerMessage) => boolean)[] = [];

  constructor(url: string, options: ClientOptions = {}) {
    this.ws = new WebSocket(url, { origin: 'http://localhost:5173', ...options });
    sockets.push(this.ws);
    this.ws.on('error', () => undefined);
    this.ws.on('message', (data, isBinary) => {
      const parsed = parseServerMessage(isBinary ? '' : rawText(data));
      if (!parsed.ok) {
        this.invalid.push(parsed.error.message);
        return;
      }
      this.messages.push(parsed.value);
      this.#waiters = this.#waiters.filter((waiter) => !waiter(parsed.value));
    });
    this.closed = new Promise((resolve) => {
      this.ws.once('close', (code, reason) => {
        resolve({ code, reason: reason.toString('utf8') });
      });
    });
  }

  /** The first message (already received or upcoming) that satisfies `predicate`. */
  waitFor<T extends ServerMessage>(
    predicate: (message: ServerMessage) => message is T,
    timeoutMs = 4000,
  ): Promise<T> {
    const found = this.messages.find(predicate);
    if (found !== undefined) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('No matching message in time'));
      }, timeoutMs);
      this.#waiters.push((message) => {
        if (!predicate(message)) return false;
        clearTimeout(timer);
        resolve(message);
        return true;
      });
    });
  }

  next<T extends ServerMessage['type']>(type: T): Promise<MessageOf<T>> {
    return this.waitFor((message): message is MessageOf<T> => message.type === type);
  }

  ofType<T extends ServerMessage['type']>(type: T): MessageOf<T>[] {
    return this.messages.filter((message): message is MessageOf<T> => message.type === type);
  }

  events(): LogEvent[] {
    return this.ofType('batch').flatMap((batch) => batch.events);
  }

  send(data: string | Buffer): void {
    this.ws.send(data);
  }
}

/** Sends a raw WebSocket handshake and returns the HTTP status (101 when upgraded). */
function handshake(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        ...headers,
      },
    });
    req.on('upgrade', (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 0);
    });
    req.on('response', (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

/** Upgrades a raw TCP socket (no WebSocket library), which then misbehaves as a test needs. */
function rawUpgrade(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ socket: Duplex; status: number }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        ...headers,
      },
    });
    req.on('upgrade', (response, socket) => {
      socket.on('error', () => undefined);
      socket.resume();
      rawSockets.push(socket);
      resolve({ socket, status: response.statusCode ?? 0 });
    });
    req.on('response', (response) => {
      reject(new Error(`Upgrade refused with ${String(response.statusCode)}`));
    });
    req.on('error', reject);
    req.end();
  });
}

async function get(port: number, path: string, method = 'GET') {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, { method });
  return {
    status: response.status,
    type: response.headers.get('content-type'),
    body: await response.text(),
  };
}

// --- Tests ----------------------------------------------------------------------------------------

describe('mock server', () => {
  it('streams hello, then batches with consecutive seq at about the requested rate', async () => {
    const { url } = await start();
    const client = new TestClient(`${url}?v=1&rate=500&scenario=steady&seed=42`);
    const hello = await client.next('hello');
    expect(hello).toMatchObject({
      protocolVersion: 1,
      resumed: false,
      stream: { rate: 500, scenario: 'steady', seed: 42 },
      limits: { minRate: 10, maxRate: 20_000, sessionMaxMs: 30 * 60 * 1000 },
    });
    expect(hello.streamId).toMatch(/^st_[0-9a-f]{32}$/);
    expect(hello.expiresAt - hello.serverTime).toBe(30 * 60 * 1000);

    await sleep(2000);
    const events = client.events();
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    // 2 s at 500/s is 1000 events; the window is wide on purpose (CI timers are coarse).
    expect(events.length).toBeGreaterThan(500);
    expect(events.length).toBeLessThan(1500);
    expect(client.ofType('heartbeat').length).toBeGreaterThanOrEqual(1);
    expect(client.invalid).toEqual([]);

    // Every message has the shape of its golden fixture.
    expect(shapeOf(hello)).toEqual(shapeOf(fixture('hello.json')));
    const heartbeat = client.ofType('heartbeat')[0];
    expect(shapeOf(heartbeat)).toEqual(shapeOf(fixture('heartbeat.json')));
    for (const batch of client.ofType('batch')) {
      expect(Object.keys(batch).sort()).toEqual(['events', 'sentAt', 'type']);
    }
    for (const event of events) expectEventShapeLikeFixtures(event);
  });

  it('applies defaults and clamps for the connection query', async () => {
    const { url, logs } = await start({ maxRate: 2000 }, { newSeed: () => 7 });
    const client = new TestClient(`${url}?v=1&rate=999999&scenario=bogus`);
    const hello = await client.next('hello');
    expect(hello.stream).toEqual({ rate: 2000, scenario: 'steady', seed: 7 });
    expect(logs.find((line) => line.startsWith('connect '))).toMatch(/ ignored=scenario /);
  });

  it('ignores a resume request and starts a new stream (reserved for B4)', async () => {
    const { url, logs } = await start();
    const client = new TestClient(`${url}?v=1&resume=st_previous&after=2190`);
    const hello = await client.next('hello');
    expect(hello.resumed).toBe(false);
    expect(hello.streamId).not.toBe('st_previous');
    const first = await client.next('batch');
    expect(first.events[0]?.seq).toBe(1);
    expect(logs.find((line) => line.startsWith('connect '))).toMatch(/ resume=ignored /);
  });

  it('logs the cut value of an invalid version', async () => {
    const { url, logs } = await start();
    const client = new TestClient(`${url}?v=${'9'.repeat(200)}x`);
    expect((await client.closed).code).toBe(CLOSE_CODES.unsupportedVersion);
    const line = logs.find((entry) => entry.startsWith('reject code=4001')) ?? '';
    expect(line).toMatch(/ problem=not-an-integer v="9{64}" /);
  });

  it('rejects a foreign Origin with 403 before the upgrade', async () => {
    const { port, logs } = await start();
    expect(await handshake(port, '/ws?v=1', { Origin: 'https://evil.example' })).toBe(403);
    expect(await handshake(port, '/ws?v=1', { Origin: 'http://localhost:5173' })).toBe(101);
    expect(logs).toContainEqual(
      expect.stringMatching(/^reject status=403 reason=origin origin="https:\/\/evil\.example"/),
    );
  });

  it('rejects a missing Origin in production and accepts allowlisted patterns', async () => {
    const { port } = await start({
      production: true,
      origins: {
        exact: new Set(['https://lsv.example.dev']),
        patterns: [/^https:\/\/pr-\d+-lsv\.example\.dev$/],
        allowMissing: false,
      },
    });
    expect(await handshake(port, '/ws?v=1')).toBe(403);
    expect(await handshake(port, '/ws?v=1', { Origin: 'https://pr-7-lsv.example.dev' })).toBe(101);
    expect(await handshake(port, '/ws?v=1', { Origin: 'https://lsv.example.dev.evil.test' })).toBe(
      403,
    );
  });

  it('accepts a missing Origin locally (CLI tools)', async () => {
    const { port } = await start();
    expect(await handshake(port, '/ws?v=1')).toBe(101);
  });

  it('upgrades only on /ws', async () => {
    const { port } = await start();
    expect(await handshake(port, '/stream?v=1', { Origin: 'http://localhost:5173' })).toBe(404);
  });

  it.each(['', '?rate=200', '?v=2', '?v=abc'])(
    'closes with 4001 for the query "%s"',
    async (query) => {
      const { url } = await start();
      const client = new TestClient(`${url}${query}`);
      expect(await client.closed).toEqual({
        code: CLOSE_CODES.unsupportedVersion,
        reason: 'unsupported protocol version',
      });
      expect(client.messages).toEqual([]);
    },
  );

  it('closes with 1009 when a client frame is larger than MAX_CLIENT_MESSAGE_BYTES', async () => {
    const { url } = await start();
    const client = new TestClient(`${url}?v=1`);
    await client.next('hello');
    const requestId = randomBytes(MAX_CLIENT_MESSAGE_BYTES).toString('hex');
    client.send(JSON.stringify({ type: 'configure', requestId }));
    expect((await client.closed).code).toBe(CLOSE_CODES.messageTooBig);
  });

  it('ignores Fly-Client-IP unless the proxy is trusted', async () => {
    const { url, logs } = await start({ maxConnectionsPerIp: 1, trustProxyIpHeader: false });
    const fromIp = (ip: string) =>
      new TestClient(`${url}?v=1`, { headers: { 'Fly-Client-IP': ip } });
    await fromIp('203.0.113.1').next('hello');
    expect((await fromIp('203.0.113.2').closed).code).toBe(CLOSE_CODES.busy);
    expect(logs).toContainEqual(
      expect.stringMatching(/^reject code=4029 reason=per-ip ip="127\.0\.0\.1"/),
    );
  });

  it('counts IPv6 clients by their /64 prefix', async () => {
    const { url } = await start({ maxConnectionsPerIp: 1, trustProxyIpHeader: true });
    const fromIp = (ip: string) =>
      new TestClient(`${url}?v=1`, { headers: { 'Fly-Client-IP': ip } });
    await fromIp('2001:db8:1:2::1').next('hello');
    expect((await fromIp('2001:db8:1:2:ffff::2').closed).code).toBe(CLOSE_CODES.busy);
    await fromIp('2001:db8:1:3::1').next('hello');
  });

  it('closes with 1008 when a client floods it with messages', async () => {
    const { url, logs } = await start();
    const client = new TestClient(`${url}?v=1`);
    await client.next('hello');
    // Twice the burst: the bucket refills while the client compresses and sends the frames.
    for (let index = 0; index < 2 * CLIENT_MESSAGE_BURST; index++) client.send('{}');
    expect(await client.closed).toEqual({
      code: CLOSE_CODES.policyViolation,
      reason: 'too many messages',
    });
    await until(() => logs.some((line) => line.startsWith('close ')));
    expect(logs.find((line) => line.startsWith('close '))).toMatch(/ reason=message-rate /);
  });

  it('closes with 4029 above the per-IP cap, counting a trusted Fly-Client-IP', async () => {
    const { url, logs } = await start({ maxConnectionsPerIp: 2, trustProxyIpHeader: true });
    const fromIp = (ip: string) =>
      new TestClient(`${url}?v=1`, { headers: { 'Fly-Client-IP': ip } });
    const first = fromIp('203.0.113.1');
    await first.next('hello');
    await fromIp('203.0.113.1').next('hello');
    await fromIp('203.0.113.2').next('hello');

    const third = await fromIp('203.0.113.1').closed;
    expect(third).toEqual({ code: CLOSE_CODES.busy, reason: busyCloseReason(BUSY_RETRY_AFTER_S) });
    expect(retryAfterSeconds(third.reason)).toBe(BUSY_RETRY_AFTER_S);
    expect(logs).toContainEqual(
      expect.stringMatching(/^reject code=4029 reason=per-ip ip="203\.0\.113\.1"/),
    );

    // A closed stream frees its slot.
    first.ws.close();
    await until(() => logs.some((line) => line.startsWith('close ')));
    await fromIp('203.0.113.1').next('hello');
  });

  it('closes with 4029 above the total cap', async () => {
    const { url, logs } = await start({ maxConnections: 2 });
    await new TestClient(`${url}?v=1`).next('hello');
    await new TestClient(`${url}?v=1`).next('hello');
    expect((await new TestClient(`${url}?v=1`).closed).code).toBe(CLOSE_CODES.busy);
    expect(logs).toContainEqual(expect.stringMatching(/^reject code=4029 reason=capacity /));
  });

  it('answers configure with the clamped settings', async () => {
    const { url } = await start({ maxRate: 2000 });
    const client = new TestClient(`${url}?v=1&rate=100`);
    expect((await client.next('hello')).limits.maxRate).toBe(2000);
    client.send(
      JSON.stringify({
        type: 'configure',
        requestId: 'cfg-1',
        rate: 50_000,
        scenario: 'error-burst',
      }),
    );
    const config = await client.next('config');
    expect(config).toEqual({
      type: 'config',
      requestId: 'cfg-1',
      rate: 2000,
      scenario: 'error-burst',
    });
    expect(shapeOf(config)).toEqual(shapeOf(fixture('config.json')));
  });

  it('answers unknown types and binary frames with error and keeps the socket open', async () => {
    const { url } = await start();
    const client = new TestClient(`${url}?v=1&rate=200`);
    await client.next('hello');
    client.send(fixtureText('invalid-client-unknown-type.json'));
    const error = await client.next('error');
    expect(error).toEqual({
      type: 'error',
      code: 'unsupported',
      message: 'Unknown message type "pause"',
    });
    expect(shapeOf(error)).toEqual(shapeOf(fixture('error.json')));
    expect(isKnownErrorCode(error.code)).toBe(true);
    client.send(Buffer.from([1, 2, 3]));
    await client.waitFor(
      (message): message is MessageOf<'error'> =>
        message.type === 'error' && message.code === 'bad-message',
    );
    const batchesBefore = client.ofType('batch').length;
    await client.waitFor(
      (message): message is MessageOf<'batch'> =>
        message.type === 'batch' && client.ofType('batch').length > batchesBefore,
    );
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('shares the global budget between streams', async () => {
    const { url } = await start({ globalMaxEventsPerSec: 400 });
    const a = new TestClient(`${url}?v=1&rate=1000`);
    const b = new TestClient(`${url}?v=1&rate=1000`);
    await Promise.all([a.next('hello'), b.next('hello')]);
    const before = a.events().length + b.events().length;
    await sleep(1000);
    const total = a.events().length + b.events().length - before;
    expect(total).toBeGreaterThan(150);
    expect(total).toBeLessThan(700);
    expect(Math.min(a.events().length, b.events().length)).toBeGreaterThan(50);
  });

  it('closes a session with 4000 when it expires', async () => {
    const { url } = await start({ sessionMaxMs: 300 });
    const client = new TestClient(`${url}?v=1`);
    const hello = await client.next('hello');
    expect(hello.expiresAt - hello.serverTime).toBe(300);
    expect(await client.closed).toEqual({
      code: CLOSE_CODES.sessionExpired,
      reason: 'session expired',
    });
  });

  it('closes every stream with 1001 on shutdown and logs one line per connection', async () => {
    const { server, url, logs } = await start();
    const client = new TestClient(`${url}?v=1`);
    await client.next('hello');
    expect(server.address?.port).toBeGreaterThan(0);
    await Promise.all([server.close(), server.close()]);
    expect(await client.closed).toEqual({
      code: CLOSE_CODES.goingAway,
      reason: 'server shutting down',
    });
    expect(logs.filter((line) => line.startsWith('connect '))).toHaveLength(1);
    expect(logs.filter((line) => line.startsWith('close '))).toHaveLength(1);
    expect(logs.join('\n')).not.toContain('"events"');
    expect(server.address).toBeUndefined();
  });

  it('finishes shutdown when a client answers the close with an invalid frame', async () => {
    const { server, port } = await start();
    const { socket } = await rawUpgrade(port, '/ws?v=1');
    const closing = server.close();
    // FIN + RSV2 + text, masked, empty: RSV2 must be clear, so the server's socket errors.
    socket.write(Buffer.from([0xa1, 0x80, 1, 2, 3, 4]));
    await expect(closing).resolves.toBeUndefined();
    expect(server.address).toBeUndefined();
    socket.destroy();
  }, 10_000);

  it('destroys a rejected socket that never finishes the closing handshake', async () => {
    const { port } = await start({}, { closeTimeoutMs: 200 });
    const { socket } = await rawUpgrade(port, '/ws?v=2');
    const started = Date.now();
    await new Promise((resolve) => socket.once('close', resolve));
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('refuses handshakes with 503 when too many sockets are open or closing', async () => {
    const { port, logs } = await start(
      { maxConnections: 1, trustProxyIpHeader: true },
      { closeTimeoutMs: 10_000 },
    );
    // Rejected (4001) sockets that never answer the close stay counted until closeTimeout; they
    // come from many addresses, so no single address hits its own limit first.
    const held = await Promise.all(
      Array.from({ length: 1 + UPGRADE_HEADROOM }, (_, index) =>
        rawUpgrade(port, '/ws?v=2', { 'Fly-Client-IP': `198.51.100.${String(index + 1)}` }),
      ),
    );
    expect(await handshake(port, '/ws?v=1', { 'Fly-Client-IP': '203.0.113.9' })).toBe(503);
    expect(logs).toContainEqual(expect.stringMatching(/^reject status=503 reason=flood /));
    for (const { socket } of held) socket.destroy();
  });

  it('refuses a flooding address with 429 without locking out other addresses', async () => {
    const { port, url, logs } = await start(
      { maxConnections: 5, maxConnectionsPerIp: 1, trustProxyIpHeader: true },
      { closeTimeoutMs: 10_000 },
    );
    const flooder = { 'Fly-Client-IP': '203.0.113.66' };
    // One open stream, then rejected (4029) sockets from the same address that never answer the
    // close: they stay counted until closeTimeout.
    await new TestClient(`${url}?v=1`, { headers: flooder }).next('hello');
    const held = await Promise.all(
      Array.from({ length: PER_IP_SOCKET_HEADROOM }, () => rawUpgrade(port, '/ws?v=1', flooder)),
    );
    // Everything else from that address is refused before the upgrade…
    const statuses = await Promise.all(
      Array.from({ length: 20 }, () => handshake(port, '/ws?v=1', flooder)),
    );
    expect(new Set(statuses)).toEqual(new Set([429]));
    expect(logs).toContainEqual(expect.stringMatching(/^reject status=429 reason=per-ip-flood /));
    // …and another address still gets a stream: the flood used only its own headroom.
    const other = new TestClient(`${url}?v=1`, { headers: { 'Fly-Client-IP': '203.0.113.7' } });
    await other.next('hello');
    for (const { socket } of held) socket.destroy();
  });
});

describe('HTTP endpoints', () => {
  it('reports health with the version, uptime, connections, rate, memory and latencies', async () => {
    const { port, url, server } = await start({ gitSha: 'abc1234' });
    const client = new TestClient(`${url}?v=1&rate=1000`);
    await client.next('hello');
    await until(async () => {
      const { body } = await get(port, '/healthz');
      const health: unknown = JSON.parse(body);
      return isRecord(health) && typeof health.eventsPerSec === 'number' && health.eventsPerSec > 0;
    });
    const { status, type, body } = await get(port, '/healthz');
    expect(status).toBe(200);
    expect(type).toBe('application/json');
    const latency = {
      p50: expect.any(Number) as unknown,
      p99: expect.any(Number) as unknown,
      max: expect.any(Number) as unknown,
    };
    const health: unknown = JSON.parse(body);
    expect(health).toEqual({
      status: 'ok',
      version: 'abc1234',
      uptimeS: expect.any(Number) as unknown,
      connections: 1,
      eventsPerSec: expect.any(Number) as unknown,
      rssMb: expect.any(Number) as unknown,
      eventLoopDelayMs: latency,
      tickMs: latency,
    });
    expect(server.health().tickMs.max).toBeGreaterThan(0);
    expect(server.health().rssMb).toBeGreaterThan(10);
    server.resetStats();
    expect(server.health().tickMs).toEqual({ p50: 0, p99: 0, max: 0 });
  });

  it('reports latencies of the last complete stats window', async () => {
    const { server, url } = await start({}, { statsWindowMs: 300 });
    const client = new TestClient(`${url}?v=1&rate=1000`);
    await client.next('hello');
    await sleep(700);
    // A full window has passed: the numbers come from it, not from the window just started.
    expect(server.health().tickMs.max).toBeGreaterThan(0);
  });

  it('serves a short text on / and explains /ws to plain HTTP clients', async () => {
    const { port } = await start();
    const root = await get(port, '/');
    expect(root.status).toBe(200);
    expect(root.body).toContain('/ws?v=1');
    expect((await get(port, '/ws')).status).toBe(426);
    expect((await get(port, '/missing')).status).toBe(404);
    expect((await get(port, '/healthz', 'POST')).status).toBe(405);
    const head = await get(port, '/healthz', 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
  });

  it('fails to listen on a port that is taken', async () => {
    const { port } = await start();
    const second = createServer(testConfig({ port }), { log: () => undefined });
    await expect(second.listen()).rejects.toThrow(/EADDRINUSE/);
    await second.close();
  });
});
