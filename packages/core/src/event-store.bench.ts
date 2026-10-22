/**
 * Cost of the stream engine's hot paths: `pnpm bench` (Vitest benchmark mode, Node). The stores
 * are full and wrap around, as they do once a stream has run for a while. Events are shaped like
 * the mock server's (traceId and payload on most) and generated once, outside the measured code.
 */
import { LOG_LEVELS, type LogEvent } from '@lsv/protocol';
import { test } from 'vitest';

import { type ColumnBatch, columnBatchTransferables } from './column-batch.ts';
import { createEventStore } from './event-store.ts';

const SERVICES = ['api-gateway', 'auth', 'orders', 'payments', 'search', 'notifications'];

function makeEvents(first: number, count: number): LogEvent[] {
  return Array.from({ length: count }, (_, index) => {
    const seq = first + index;
    const service = SERVICES[seq % SERVICES.length] ?? 'orders';
    return {
      seq,
      ts: 1_791_979_204_322 + seq,
      level: LOG_LEVELS[seq % LOG_LEVELS.length] ?? 'info',
      service,
      host: `${service}-7f9c-${String(seq % 3)}`,
      message: `Request ${String(seq)} completed in ${String(seq % 97)} ms`,
      ...(seq % 4 !== 0 && {
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        payload: {
          http: { method: 'GET', path: `/api/orders/${String(seq)}`, status: 200 },
          latencyMs: seq % 97,
        },
      }),
    };
  });
}

const CAPACITY = 100_000;
const BATCH = 500;
const OPTIONS = { warmupTime: 500, time: 2000 };

test(`appendEvents: ${String(CAPACITY)} events into a full store of ${String(CAPACITY)}`, async ({
  bench,
}) => {
  const events = makeEvents(1, CAPACITY);
  const store = createEventStore({ capacity: CAPACITY, keepPayload: true });
  store.appendEvents(events);
  await bench('appendEvents (100K)', () => {
    store.appendEvents(events);
  }).run(OPTIONS);
});

test(`encode: a ${String(BATCH)}-event batch in the worker`, async ({ bench }) => {
  const events = makeEvents(1, BATCH);
  const store = createEventStore({ capacity: CAPACITY, keepPayload: true });
  store.appendEvents(makeEvents(1, CAPACITY));
  store.takeColumnBatch();
  // The difference between the two rows is the cost of takeColumnBatch.
  await bench.compare(
    bench('appendEvents (500)', () => {
      store.appendEvents(events);
    }),
    bench('appendEvents + takeColumnBatch (500)', () => {
      store.appendEvents(events);
      store.takeColumnBatch();
    }),
    OPTIONS,
  );
});

test(`appendColumns: a ${String(BATCH)}-event batch on the main thread`, async ({ bench }) => {
  const source = createEventStore({ capacity: CAPACITY, keepPayload: true });
  source.appendEvents(makeEvents(1, BATCH));
  const encoded = source.takeColumnBatch();
  if (encoded === undefined) throw new Error('The benchmark batch must not be empty');
  const replica = createEventStore({ capacity: CAPACITY, keepPayload: false });
  // Fill the replica so that every append evicts, as in a long-running stream.
  for (let filled = 0; filled < CAPACITY; filled += BATCH) {
    replica.appendColumns({ ...encoded, firstPosition: replica.end });
  }
  await bench('appendColumns (500)', () => {
    replica.appendColumns({ ...encoded, firstPosition: replica.end });
  }).run(OPTIONS);
});

test(`postMessage payload: a ${String(BATCH)}-event batch to the main thread`, async ({
  bench,
}) => {
  const events = makeEvents(1, BATCH);
  const store = createEventStore({ capacity: CAPACITY, keepPayload: true });
  // structuredClone is the algorithm postMessage runs; transferring skips copying the columns.
  await bench.compare(
    bench('structuredClone(LogEvent[]) (500)', () => {
      structuredClone(events);
    }),
    bench('append + encode + structuredClone(ColumnBatch, transfer) (500)', () => {
      store.appendEvents(events);
      const batch: ColumnBatch | undefined = store.takeColumnBatch();
      if (batch !== undefined)
        structuredClone(batch, { transfer: columnBatchTransferables(batch) });
    }),
    OPTIONS,
  );
});
