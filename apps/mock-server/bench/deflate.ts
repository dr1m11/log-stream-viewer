/**
 * Measures what permessage-deflate costs and saves: one client streams `rate` events/s for
 * `seconds`, alternately with the production setting (level 1, threshold 1024 bytes) and without
 * compression, for `rounds` rounds. The server runs in a child process so that its CPU time
 * (all threads, including zlib's thread pool) excludes the client.
 *
 *   pnpm --filter @lsv/mock-server bench:deflate [rate=10000] [seconds=10] [rounds=3]
 *
 * Results are recorded in docs/adr/0005.
 */
import { type ChildProcess, fork } from 'node:child_process';
import { once } from 'node:events';
import type { Socket } from 'node:net';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { type RawData, WebSocket } from 'ws';

import { parseConfig } from '../src/config.ts';
import { createServer } from '../src/server.ts';

const WARM_UP_MS = 2000;

interface Measurement {
  readonly deflate: boolean;
  readonly extensions: string;
  readonly eventsPerSec: number;
  readonly wireBytesPerSec: number;
  readonly jsonBytesPerSec: number;
  readonly serverCpuPercent: number;
}

function field(message: unknown, type: string, key: string): number | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  if (!('type' in message) || message.type !== type || !(key in message)) return undefined;
  const value: unknown = Reflect.get(message, key);
  return typeof value === 'number' ? value : undefined;
}

function nextMessage(child: ChildProcess, type: string, key: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown) => {
      const value = field(message, type, key);
      if (value === undefined) return;
      child.off('message', onMessage);
      resolve(value);
    };
    child.on('message', onMessage);
    child.once('exit', (code) => {
      reject(new Error(`Server process exited with ${String(code)}`));
    });
  });
}

/** Child process: a server with or without deflate that reports its own CPU time. */
async function serve(deflate: boolean): Promise<void> {
  const config = parseConfig({ MAX_RATE: '100000', GLOBAL_MAX_EVENTS_PER_SEC: '100000' });
  if (!config.ok) throw new Error(config.error.join('; '));
  const server = createServer(
    { ...config.value, port: 0, host: '127.0.0.1' },
    { deflate, log: () => undefined },
  );
  const { port } = await server.listen();
  let cpu = process.cpuUsage();
  let wall = performance.now();
  process.on('message', (message: unknown) => {
    if (field(message, 'start', 'at') !== undefined) {
      cpu = process.cpuUsage();
      wall = performance.now();
    } else if (field(message, 'stop', 'at') !== undefined) {
      const used = process.cpuUsage(cpu);
      process.send?.({
        type: 'cpu',
        cpuMs: (used.user + used.system) / 1000,
        wallMs: performance.now() - wall,
      });
      void server.close().then(() => process.exit(0));
    }
  });
  process.send?.({ type: 'listening', port });
}

function textOf(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

async function measure(deflate: boolean, rate: number, seconds: number): Promise<Measurement> {
  const child = fork(fileURLToPath(import.meta.url), ['serve', deflate ? 'on' : 'off'], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const port = await nextMessage(child, 'listening', 'port');
  const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/ws?v=1&rate=${String(rate)}&seed=42`);
  let socket: Socket | undefined;
  ws.on('upgrade', (response) => {
    socket = response.socket;
  });
  let events = 0;
  let jsonBytes = 0;
  ws.on('message', (data) => {
    const text = textOf(data);
    jsonBytes += Buffer.byteLength(text);
    const message: unknown = JSON.parse(text);
    if (typeof message === 'object' && message !== null && 'events' in message) {
      events += Array.isArray(message.events) ? message.events.length : 0;
    }
  });
  await once(ws, 'open');
  await sleep(WARM_UP_MS);

  const before = { events, jsonBytes, wire: socket?.bytesRead ?? 0 };
  child.send({ type: 'start', at: Date.now() });
  await sleep(seconds * 1000);
  const after = { events, jsonBytes, wire: socket?.bytesRead ?? 0 };
  const cpu = nextMessage(child, 'cpu', 'cpuMs');
  const wall = nextMessage(child, 'cpu', 'wallMs');
  child.send({ type: 'stop', at: Date.now() });
  const [cpuMs, wallMs] = await Promise.all([cpu, wall]);
  const extensions = ws.extensions;
  ws.terminate();
  await once(child, 'exit');

  return {
    deflate,
    extensions: extensions === '' ? 'none' : extensions,
    eventsPerSec: Math.round((after.events - before.events) / seconds),
    wireBytesPerSec: Math.round((after.wire - before.wire) / seconds),
    jsonBytesPerSec: Math.round((after.jsonBytes - before.jsonBytes) / seconds),
    serverCpuPercent: Math.round((cpuMs / wallMs) * 1000) / 10,
  };
}

async function main(): Promise<void> {
  const rate = Number(process.argv[2] ?? 10_000);
  const seconds = Number(process.argv[3] ?? 10);
  const rounds = Number(process.argv[4] ?? 3);
  console.log(
    `Node ${process.version}, ${process.platform}/${process.arch}: ${String(rate)} events/s, ` +
      `${String(seconds)} s per run, ${String(rounds)} rounds (modes alternate)`,
  );
  const runs: Measurement[] = [];
  for (let round = 0; round < rounds; round++) {
    runs.push(await measure(true, rate, seconds), await measure(false, rate, seconds));
  }
  const row = (result: Measurement) => ({
    deflate: result.deflate ? 'level 1' : 'off',
    'events/s': result.eventsPerSec,
    'server CPU %': result.serverCpuPercent,
    'wire KB/s': Math.round(result.wireBytesPerSec / 1024),
    'JSON KB/s': Math.round(result.jsonBytesPerSec / 1024),
    'wire B/event': Math.round(result.wireBytesPerSec / Math.max(1, result.eventsPerSec)),
    'JSON B/event': Math.round(result.jsonBytesPerSec / Math.max(1, result.eventsPerSec)),
    negotiated: result.extensions,
  });
  console.table(runs.map(row));
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  console.table(
    [true, false].map((deflate) => {
      const cpu = runs.filter((run) => run.deflate === deflate).map((run) => run.serverCpuPercent);
      return {
        deflate: deflate ? 'level 1' : 'off',
        'median server CPU %': median([...cpu]),
        'min %': Math.min(...cpu),
        'max %': Math.max(...cpu),
      };
    }),
  );
}

if (process.argv[2] === 'serve') await serve(process.argv[3] === 'on');
else await main();
