/**
 * Cost of the stream engine's hot paths: `pnpm bench` (Vitest benchmark mode, Node). The stores
 * are full and wrap around, as they do once a stream has run for a while. Events are shaped like
 * the mock server's (traceId and payload on most).
 *
 * Caveat: most rows append the same pre-built event objects on every iteration, so those objects
 * and their strings stay hot in the CPU cache. The "fresh JSON.parse" rows parse a new frame per
 * iteration, as the worker does; the difference between their two rows is the closer estimate of
 * `appendEvents` in production.
 */
import { LOG_LEVELS, type LogEvent } from '@lsv/protocol';
import { test } from 'vitest';

import { columnBatchTransferables } from './column-batch.ts';
import { createEventStore, MAX_COLUMN_BATCH_ROWS } from './event-store.ts';

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

/** A store of `capacity` filled to the brim, with nothing left to take. */
function fullStore(capacity: number, keepPayload: boolean) {
  const store = createEventStore({ capacity, keepPayload });
  store.appendEvents(makeEvents(1, capacity));
  while (store.takeColumnBatch() !== undefined);
  return store;
}

const CAPACITY = 100_000;
const BATCH = 500;
const OPTIONS = { warmupTime: 500, time: 2000 };

test(`appendEvents: ${String(CAPACITY)} events into a full store of ${String(CAPACITY)}`, async ({
  bench,
}) => {
  const events = makeEvents(1, CAPACITY);
  const store = fullStore(CAPACITY, true);
  await bench('appendEvents (100K, hot objects)', () => {
    store.appendEvents(events);
  }).run(OPTIONS);
});

test(`appendEvents: a ${String(BATCH)}-event frame, fresh JSON.parse per iteration`, async ({
  bench,
}) => {
  const frame = JSON.stringify(makeEvents(1, BATCH));
  const store = fullStore(CAPACITY, true);
  // The difference between the two rows is appendEvents on freshly parsed (cold) objects.
  await bench.compare(
    bench('JSON.parse (500)', () => {
      JSON.parse(frame);
    }),
    bench('JSON.parse + appendEvents (500)', () => {
      // A validated boundary in production (parseServerMessage); trusted here.
      store.appendEvents(JSON.parse(frame) as LogEvent[]);
    }),
    OPTIONS,
  );
});

test(`encode: a ${String(BATCH)}-event batch in the worker`, async ({ bench }) => {
  const events = makeEvents(1, BATCH);
  // One store per task: bench.compare interleaves them, and a backlog would distort the encode.
  const appendOnly = fullStore(CAPACITY, true);
  const appendAndTake = fullStore(CAPACITY, true);
  // The difference between the two rows is the cost of takeColumnBatch.
  await bench.compare(
    bench('appendEvents (500)', () => {
      appendOnly.appendEvents(events);
    }),
    bench('appendEvents + takeColumnBatch (500)', () => {
      appendAndTake.appendEvents(events);
      appendAndTake.takeColumnBatch();
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
  const store = fullStore(CAPACITY, true);
  // structuredClone is the algorithm postMessage runs; transferring skips copying the columns.
  await bench.compare(
    bench('structuredClone(LogEvent[]) (500)', () => {
      structuredClone(events);
    }),
    bench('append + encode + structuredClone(ColumnBatch, transfer) (500)', () => {
      store.appendEvents(events);
      const batch = store.takeColumnBatch();
      if (batch !== undefined) {
        structuredClone(batch, { transfer: columnBatchTransferables(batch) });
      }
    }),
    OPTIONS,
  );
});

test(`backlog: one ${String(MAX_COLUMN_BATCH_ROWS)}-row batch through both threads`, async ({
  bench,
}) => {
  const events = makeEvents(1, MAX_COLUMN_BATCH_ROWS);
  const source = fullStore(CAPACITY, true);
  const replica = createEventStore({ capacity: CAPACITY, keepPayload: false });
  // The largest batch a stall produces: append, encode, clone with transfer and append to the
  // replica — an upper bound for the task that blocks either thread.
  await bench(`append + encode + clone + appendColumns (${String(MAX_COLUMN_BATCH_ROWS)})`, () => {
    source.appendEvents(events);
    const batch = source.takeColumnBatch();
    if (batch === undefined) return;
    replica.appendColumns(structuredClone(batch, { transfer: columnBatchTransferables(batch) }));
  }).run(OPTIONS);
});
