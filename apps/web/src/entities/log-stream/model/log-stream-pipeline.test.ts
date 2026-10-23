import helloFrame from '@lsv/protocol/fixtures/v1/hello.json?raw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeWebSocket, testBatch, testLogEvent } from '@/shared/lib/testing';

import type { StreamWorker } from '../api/spawn-stream-worker';
import { createStreamWorkerHost } from '../api/stream-worker-host';
import type { FromWorkerMessage, MessageEndpoint, ToWorkerMessage } from '../api/worker-protocol';
import { createLogStreamStore } from './log-stream-store';

/**
 * Runs the real worker host in this thread behind a `StreamWorker`: both directions go through
 * `structuredClone` with the transfer list, as `postMessage` does, and are delivered synchronously.
 */
function inProcessWorker(): StreamWorker {
  const worker: StreamWorker = {
    onmessage: null,
    onmessageerror: null,
    onerror: null,
    postMessage(message, options) {
      const data = structuredClone(message, options);
      port.onmessage?.(new MessageEvent('message', { data }));
    },
    terminate() {
      host.dispose();
    },
  };
  const port: MessageEndpoint<ToWorkerMessage, FromWorkerMessage> = {
    onmessage: null,
    postMessage(message, options) {
      const data = structuredClone(message, options);
      worker.onmessage?.(new MessageEvent('message', { data }));
    },
  };
  const host = createStreamWorkerHost(port, { now: () => performance.now() });
  return worker;
}

function frame(seqs: readonly number[]): string {
  return JSON.stringify(testBatch(seqs));
}

describe('the stream pipeline (store, worker host and socket)', () => {
  beforeEach(() => {
    FakeWebSocket.reset();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('carries the server frames into the main-thread replica and the snapshot', () => {
    const store = createLogStreamStore({
      endpoint: 'ws://localhost:8787/ws',
      request: { seed: 7 },
      capacity: 1000,
      spawnWorker: inProcessWorker,
    });
    store.start();
    const socket = FakeWebSocket.latest();
    expect(socket.url).toBe('ws://localhost:8787/ws?v=1&seed=7');

    socket.open();
    socket.receive(helloFrame);
    socket.receive(frame([1, 2, 3]));
    socket.receive(frame([5, 6]));
    vi.advanceTimersByTime(16);

    const snapshot = store.getSnapshot();
    expect(snapshot).toMatchObject({
      status: { phase: 'connected' },
      start: 0,
      end: 5,
      counters: { received: 5, missed: 1 },
    });
    // The replica has no payloads; the rows match what the server sent.
    expect(snapshot.buffer.eventAt(3)).toEqual(testLogEvent(5));

    store.stop();
    expect(socket.closedWith?.code).toBe(1000);
  });
  it('fetches the full event with its payload from the worker for the details view', async () => {
    const store = createLogStreamStore({
      endpoint: 'ws://localhost:8787/ws',
      request: {},
      capacity: 1000,
      spawnWorker: inProcessWorker,
    });
    store.start();
    const socket = FakeWebSocket.latest();
    socket.open();
    socket.receive(helloFrame);
    const withPayload = testLogEvent(2, { payload: { userId: 'u-9', cacheHit: false } });
    socket.receive(JSON.stringify({ ...testBatch([]), events: [testLogEvent(1), withPayload] }));

    // The replica does not keep the payload; the worker's buffer does.
    expect(store.getSnapshot().buffer.eventAt(1)).toEqual(testLogEvent(2));
    await expect(store.getEvent(1)).resolves.toEqual(withPayload);

    store.stop();
  });
});
