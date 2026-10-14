/**
 * Cost of validating a batch on top of `JSON.parse`: `pnpm bench` (Vitest benchmark mode, Node).
 * `bench.compare` warms every task up and then interleaves their iterations within a fixed time
 * budget. `JSON.parse` is listed twice: the gap between its two identical rows is the noise floor,
 * so only a difference larger than that gap means anything.
 */
import { test } from 'vitest';

import { LOG_LEVELS } from './event.ts';
import { parseServerMessage } from './parse.ts';

const SERVICES = ['api-gateway', 'auth', 'orders', 'payments', 'search', 'notifications'];

/** A `batch` frame with `size` events shaped like the mock server's (traceId and payload on most). */
function batchFrame(size: number): string {
  const events = Array.from({ length: size }, (_, index) => ({
    seq: 1000 + index,
    ts: 1791979204322 + index,
    level: LOG_LEVELS[index % LOG_LEVELS.length],
    service: SERVICES[index % SERVICES.length],
    host: `host-${String(index % 7)}`,
    message: `Request ${String(index)} completed in ${String(index % 97)} ms`,
    ...(index % 4 !== 0 && {
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      payload: {
        http: { method: 'GET', path: `/api/orders/${String(index)}`, status: 200 },
        latencyMs: index % 97,
      },
    }),
  }));
  return JSON.stringify({ type: 'batch', sentAt: 1791979204371, events });
}

const OPTIONS = { warmupTime: 500, time: 2000 };

for (const size of [25, 500]) {
  test(`validation overhead for a ${String(size)}-event batch`, async ({ bench }) => {
    const raw = batchFrame(size);
    if (!parseServerMessage(raw).ok) throw new Error('The benchmark frame must be valid');
    await bench.compare(
      bench('JSON.parse (before)', () => {
        JSON.parse(raw);
      }),
      bench('parseServerMessage', () => {
        parseServerMessage(raw);
      }),
      bench('JSON.parse (after)', () => {
        JSON.parse(raw);
      }),
      OPTIONS,
    );
  });
}
