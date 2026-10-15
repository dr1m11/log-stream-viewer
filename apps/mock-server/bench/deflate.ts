/**
 * Load benchmark of the mock server: N sessions × rate events/s, with each permessage-deflate
 * variant, for several rounds. The server and the client each run in their own process, so the
 * server's CPU time (user + system of all its threads, zlib's pool included) excludes the client,
 * and the client's JSON parsing cannot throttle the server.
 *
 *   pnpm --filter @lsv/mock-server bench:deflate [seconds=8] [rounds=3] [modes=1x20000,10x2000,50x400,50x10]
 *
 * Reports achieved events/s, server CPU, RSS (idle, end and peak), tick p99, event-loop delay p99
 * and bytes per event on the wire. Results are recorded in docs/adr/0005.
 */
import { type ChildProcess, fork } from 'node:child_process';
import { once } from 'node:events';
import type { Socket } from 'node:net';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type { PerMessageDeflateOptions } from 'ws';
import { type RawData, WebSocket } from 'ws';

import { parseConfig } from '../src/config.ts';
import { createServer, DEFLATE_OPTIONS } from '../src/server.ts';

const WARM_UP_MS = 2000;
const SELF = fileURLToPath(import.meta.url);

/** permessage-deflate variants under test. */
const VARIANTS = {
  default: DEFLATE_OPTIONS,
  // Smaller zlib state per connection: 8 KiB window (negotiated as server_max_window_bits) and
  // memLevel 7; the client resets its context per message, so the server's inflater stays small.
  compact: {
    zlibDeflateOptions: { level: 1, memLevel: 7 },
    serverMaxWindowBits: 13,
    clientNoContextTakeover: true,
  },
  off: false,
} as const satisfies Record<string, PerMessageDeflateOptions | false>;

type Variant = keyof typeof VARIANTS;

function isVariant(value: string | undefined): value is Variant {
  return value !== undefined && value in VARIANTS;
}

// --- IPC ------------------------------------------------------------------------------------------

type Message = Readonly<Record<string, unknown>> & { readonly type: string };

function isMessage(value: unknown): value is Message {
  return (
    typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'
  );
}

function send(message: Message): void {
  process.send?.(message);
}

function nextMessage(child: ChildProcess, type: string): Promise<Message> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown) => {
      if (!isMessage(message) || message.type !== type) return;
      child.off('message', onMessage);
      child.off('exit', onExit);
      resolve(message);
    };
    const onExit = (code: number | null) => {
      reject(new Error(`Child exited with ${String(code)} while waiting for "${type}"`));
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
}

function numberField(message: Message, key: string): number {
  const value = message[key];
  return typeof value === 'number' ? value : Number.NaN;
}

function onCommand(handlers: Readonly<Record<string, () => void>>): void {
  process.on('message', (message: unknown) => {
    if (isMessage(message)) handlers[message.type]?.();
  });
}

const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;

// --- Server process -------------------------------------------------------------------------------

async function serve(variant: Variant): Promise<void> {
  const config = parseConfig({
    MAX_RATE: '20000',
    GLOBAL_MAX_EVENTS_PER_SEC: '200000',
    MAX_CONNECTIONS: '200',
    MAX_CONNECTIONS_PER_IP: '200',
  });
  if (!config.ok) throw new Error(config.error.join('; '));
  const server = createServer(
    { ...config.value, port: 0, host: '127.0.0.1' },
    { perMessageDeflate: VARIANTS[variant], log: () => undefined, statsWindowMs: 1e9 },
  );
  const { port } = await server.listen();
  const idleRss = process.memoryUsage.rss();
  let cpu = process.cpuUsage();
  let wall = performance.now();
  let peakRss = 0;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage.rss());
  }, 100);
  onCommand({
    start: () => {
      cpu = process.cpuUsage();
      wall = performance.now();
      peakRss = process.memoryUsage.rss();
      server.resetStats();
    },
    stop: () => {
      const used = process.cpuUsage(cpu);
      const health = server.health();
      clearInterval(sampler);
      send({
        type: 'result',
        cpuMs: (used.user + used.system) / 1000,
        wallMs: performance.now() - wall,
        idleRss,
        endRss: process.memoryUsage.rss(),
        peakRss: Math.max(peakRss, process.memoryUsage.rss()),
        tickP99: health.tickMs.p99,
        tickP50: health.tickMs.p50,
        loopP99: health.eventLoopDelayMs.p99,
      });
      void server.close().then(() => process.exit(0));
    },
  });
  send({ type: 'listening', port });
}

// --- Client process -------------------------------------------------------------------------------

function textOf(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

async function client(port: number, sessions: number, rate: number): Promise<void> {
  let events = 0;
  let jsonBytes = 0;
  const sockets: Socket[] = [];
  const connections = Array.from({ length: sessions }, (_, index) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${String(port)}/ws?v=1&rate=${String(rate)}&seed=${String(index + 1)}`,
    );
    ws.on('upgrade', (response) => {
      sockets.push(response.socket);
    });
    ws.on('message', (data) => {
      const text = textOf(data);
      jsonBytes += Buffer.byteLength(text);
      const message: unknown = JSON.parse(text);
      if (typeof message === 'object' && message !== null && 'events' in message) {
        events += Array.isArray(message.events) ? message.events.length : 0;
      }
    });
    return ws;
  });
  await Promise.all(connections.map((ws) => once(ws, 'open')));
  const wire = () => sockets.reduce((sum, socket) => sum + socket.bytesRead, 0);
  let before = { events, jsonBytes, wire: wire(), at: performance.now() };
  onCommand({
    start: () => {
      before = { events, jsonBytes, wire: wire(), at: performance.now() };
    },
    stop: () => {
      const seconds = (performance.now() - before.at) / 1000;
      send({
        type: 'result',
        eventsPerSec: (events - before.events) / seconds,
        jsonBytesPerSec: (jsonBytes - before.jsonBytes) / seconds,
        wireBytesPerSec: (wire() - before.wire) / seconds,
        extensions: connections[0]?.extensions ?? '',
      });
      for (const ws of connections) ws.terminate();
      process.exit(0);
    },
  });
  send({ type: 'connected' });
}

// --- Orchestrator ---------------------------------------------------------------------------------

interface Mode {
  readonly sessions: number;
  readonly rate: number;
}

interface Run {
  readonly mode: string;
  readonly variant: Variant;
  readonly eventsPerSec: number;
  readonly cpuPercent: number;
  readonly idleRssMb: number;
  readonly endRssMb: number;
  readonly peakRssMb: number;
  readonly tickP50: number;
  readonly tickP99: number;
  readonly loopP99: number;
  readonly wireBytesPerEvent: number;
  readonly jsonBytesPerEvent: number;
}

async function measure(mode: Mode, variant: Variant, seconds: number): Promise<Run> {
  const server = fork(SELF, ['serve', variant], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const port = numberField(await nextMessage(server, 'listening'), 'port');
  const clients = fork(SELF, ['client', String(port), String(mode.sessions), String(mode.rate)], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  await nextMessage(clients, 'connected');
  await sleep(WARM_UP_MS);
  server.send({ type: 'start' });
  clients.send({ type: 'start' });
  await sleep(seconds * 1000);
  const serverResult = nextMessage(server, 'result');
  const clientResult = nextMessage(clients, 'result');
  clients.send({ type: 'stop' });
  server.send({ type: 'stop' });
  const [s, c] = await Promise.all([serverResult, clientResult]);
  await Promise.all([once(server, 'exit'), once(clients, 'exit')]);
  const eventsPerSec = numberField(c, 'eventsPerSec');
  return {
    mode: `${String(mode.sessions)}×${String(mode.rate)}`,
    variant,
    eventsPerSec: Math.round(eventsPerSec),
    cpuPercent: Math.round((numberField(s, 'cpuMs') / numberField(s, 'wallMs')) * 1000) / 10,
    idleRssMb: mb(numberField(s, 'idleRss')),
    endRssMb: mb(numberField(s, 'endRss')),
    peakRssMb: mb(numberField(s, 'peakRss')),
    tickP50: numberField(s, 'tickP50'),
    tickP99: numberField(s, 'tickP99'),
    loopP99: numberField(s, 'loopP99'),
    wireBytesPerEvent: Math.round(numberField(c, 'wireBytesPerSec') / Math.max(1, eventsPerSec)),
    jsonBytesPerEvent: Math.round(numberField(c, 'jsonBytesPerSec') / Math.max(1, eventsPerSec)),
  };
}

function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

function parseModes(text: string): Mode[] {
  return text.split(',').map((entry) => {
    const [sessions = '1', rate = '1000'] = entry.split('x');
    return { sessions: Number(sessions), rate: Number(rate) };
  });
}

async function main(): Promise<void> {
  const seconds = Number(process.argv[2] ?? 8);
  const rounds = Number(process.argv[3] ?? 3);
  const modes = parseModes(process.argv[4] ?? '1x20000,10x2000,50x400,50x10');
  const variants = Object.keys(VARIANTS).filter(isVariant);
  console.log(
    `Node ${process.version}, ${process.platform}/${process.arch}: ${String(seconds)} s per run ` +
      `after ${String(WARM_UP_MS / 1000)} s warm-up, ${String(rounds)} rounds, variants ${variants.join('/')}`,
  );
  const runs: Run[] = [];
  for (let round = 0; round < rounds; round++) {
    for (const mode of modes) {
      for (const variant of variants) {
        const run = await measure(mode, variant, seconds);
        runs.push(run);
        console.log(JSON.stringify({ round: round + 1, ...run }));
      }
    }
  }
  const summary = modes.flatMap((mode) =>
    variants.map((variant) => {
      const label = `${String(mode.sessions)}×${String(mode.rate)}`;
      const own = runs.filter((run) => run.mode === label && run.variant === variant);
      const pick = (key: keyof Omit<Run, 'mode' | 'variant'>) => median(own.map((run) => run[key]));
      return {
        mode: label,
        deflate: variant,
        'events/s': pick('eventsPerSec'),
        'CPU %': pick('cpuPercent'),
        'CPU % min–max': `${String(Math.min(...own.map((run) => run.cpuPercent)))}–${String(Math.max(...own.map((run) => run.cpuPercent)))}`,
        'RSS idle/end/peak MB': `${String(pick('idleRssMb'))}/${String(pick('endRssMb'))}/${String(pick('peakRssMb'))}`,
        'tick p50/p99 ms': `${String(pick('tickP50'))}/${String(pick('tickP99'))}`,
        'loop p99 ms': pick('loopP99'),
        'wire B/event': pick('wireBytesPerEvent'),
        'JSON B/event': pick('jsonBytesPerEvent'),
      };
    }),
  );
  console.log('\nMedians over rounds:');
  console.table(summary);
}

const [role, first, second, third] = process.argv.slice(2);
if (role === 'serve' && isVariant(first)) await serve(first);
else if (role === 'client') await client(Number(first), Number(second), Number(third));
else await main();
