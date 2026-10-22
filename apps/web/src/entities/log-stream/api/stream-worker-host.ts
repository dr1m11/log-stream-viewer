import {
  columnBatchTransferables,
  createEventStore,
  createStreamStats,
  type EventStore,
} from '@lsv/core';
import { assertNever } from '@lsv/protocol';

import {
  openStreamSocket,
  type StreamRequest,
  type StreamSocket,
  type StreamSocketHandlers,
} from '@/shared/api';

import type {
  FromWorkerMessage,
  MessageEndpoint,
  ToWorkerMessage,
  WorkerStartMessage,
} from './worker-protocol';

export interface StreamWorkerHostDeps {
  /** Monotonic clock in milliseconds for the rate window: `performance.now` in the worker. */
  readonly now: () => number;
  /** Opens the connection; {@link openStreamSocket} unless a test passes another. */
  readonly openSocket?: (
    endpoint: string,
    request: StreamRequest,
    handlers: StreamSocketHandlers,
  ) => StreamSocket;
}

export interface StreamWorkerHost {
  /** Closes the connection and stops listening to the port. */
  readonly dispose: () => void;
}

/**
 * The stream worker's logic (docs/adr/0006), kept apart from the thin `stream.worker.ts` entry so
 * tests can drive it with a fake port and a fake `WebSocket`. It owns the socket, the parsing (in
 * `openStreamSocket`), the stream statistics and the authoritative `EventStore` with payloads.
 *
 * Per server batch it appends the events, then posts every row appended since the previous post
 * as column batches of at most `MAX_COLUMN_BATCH_ROWS` rows with their typed arrays transferred —
 * never raw frames or `LogEvent` arrays. The server sends at most 20 batches per second, so the
 * main thread gets no more posts than that, plus one per heartbeat and invalid frame.
 */
export function createStreamWorkerHost(
  port: MessageEndpoint<ToWorkerMessage, FromWorkerMessage>,
  deps: StreamWorkerHostDeps,
): StreamWorkerHost {
  const { now, openSocket = openStreamSocket } = deps;
  const stats = createStreamStats();

  let session = 0;
  let socket: StreamSocket | undefined;
  // Replaced on every `start`; this one only exists so the variable is never undefined.
  let store: EventStore = createEventStore({ capacity: 1, keepPayload: true });

  function post(message: FromWorkerMessage, transfer: Transferable[] = []): void {
    port.postMessage(message, { transfer });
  }

  function postCounters(): void {
    post({ type: 'counters', session, counters: stats.counters(now()) });
  }

  /** Posts the rows appended since the previous call, one message per column batch. */
  function flush(): void {
    let columns = store.takeColumnBatch();
    if (columns === undefined) {
      postCounters();
      return;
    }
    // One counters object per server batch, not per column batch: they did not change in between.
    const counters = stats.counters(now());
    while (columns !== undefined) {
      post({ type: 'batch', session, columns, counters }, columnBatchTransferables(columns));
      columns = store.takeColumnBatch();
    }
  }

  function closeSocket(): void {
    socket?.close();
    socket = undefined;
  }

  function start(message: WorkerStartMessage): void {
    closeSocket();
    session = message.session;
    store = createEventStore({ capacity: message.capacity, keepPayload: true });
    stats.reset(now());
    // `openStreamSocket` calls no handler after `close()`, so these only ever see this session.
    socket = openSocket(message.endpoint, message.request, {
      onHello({ stream, limits, expiresAt }) {
        stats.onHello(now());
        post({ type: 'hello', session, stream, limits, expiresAt });
      },
      onBatch(batch) {
        const { events } = batch;
        const dropped = batch.dropped ?? 0;
        const previousEnd = store.end;
        try {
          store.appendEvents(events);
          stats.onBatch(events, dropped, now());
        } catch (error) {
          // `parseServerMessage` lets no hole or unknown level through, so this is a bug, not
          // input. The store keeps the events before the bad one: count those as received (the
          // rest shows up as a `seq` gap, i.e. missed), count the frame as invalid and post them.
          if (!(error instanceof TypeError)) throw error;
          stats.onBatch(events.slice(0, store.end - previousEnd), dropped, now());
          stats.onInvalidFrame();
        }
        flush();
      },
      // The server's heartbeat comes every second: enough to bring events/s down when batches stop.
      onHeartbeat: postCounters,
      onInvalidFrame() {
        stats.onInvalidFrame();
        postCounters();
      },
      onClose(code, reason) {
        socket = undefined;
        post({ type: 'closed', session, code, reason, counters: stats.counters(now()) });
      },
    });
  }

  port.onmessage = ({ data }) => {
    switch (data.type) {
      case 'start':
        start(data);
        return;
      case 'stop':
        if (data.session === session) closeSocket();
        return;
      default:
        // A message type added to `ToWorkerMessage` without a case here fails to compile.
        assertNever(data);
    }
  };

  return {
    dispose() {
      port.onmessage = null;
      closeSocket();
    },
  };
}
