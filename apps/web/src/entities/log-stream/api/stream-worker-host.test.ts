import { createEventStore, MAX_COLUMN_BATCH_ROWS } from '@lsv/core';
import type { LogEvent } from '@lsv/protocol';
import configFrame from '@lsv/protocol/fixtures/v1/config.json?raw';
import errorUnknownCodeFrame from '@lsv/protocol/fixtures/v1/error-unknown-code.json?raw';
import helloFrame from '@lsv/protocol/fixtures/v1/hello.json?raw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StreamSocketHandlers } from '@/shared/api';
import {
  FakeMessagePort,
  FakeWebSocket,
  testBatch,
  testHeartbeat,
  testLogEvent,
} from '@/shared/lib/testing';

import { createStreamWorkerHost, NOT_CONNECTED_ERROR_CODE } from './stream-worker-host';
import type { FromWorkerMessage, ToWorkerMessage, WorkerBatchMessage } from './worker-protocol';

const ENDPOINT = 'ws://localhost:8787/ws';

/** `count` consecutive `seq` numbers starting at `first`. */
function seqs(first: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => first + index);
}

function frame(seqNumbers: readonly number[], dropped?: number): string {
  return JSON.stringify({ ...testBatch(seqNumbers), dropped });
}

function setup() {
  const port = new FakeMessagePort<ToWorkerMessage, FromWorkerMessage>();
  let clock = 10_000;
  const host = createStreamWorkerHost(port, { now: () => clock });
  return {
    port,
    host,
    advance: (ms: number) => {
      clock += ms;
    },
    start: (session = 1, capacity = 10_000) => {
      port.receive({
        type: 'start',
        session,
        endpoint: ENDPOINT,
        request: { rate: 500 },
        capacity,
      });
      return FakeWebSocket.latest();
    },
    /** The posted batch messages, oldest first. */
    batches: (): WorkerBatchMessage[] =>
      port.messages().filter((message) => message.type === 'batch'),
  };
}

/** Opens the socket and completes the handshake. */
function connect(socket: FakeWebSocket): void {
  socket.open();
  socket.receive(helloFrame);
}

describe('createStreamWorkerHost', () => {
  beforeEach(() => {
    FakeWebSocket.reset();
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('connects with protocol v1 and reports the stream once the server says hello', () => {
    const { port, start } = setup();

    const socket = start(3);
    expect(socket.url).toBe(`${ENDPOINT}?v=1&rate=500`);
    connect(socket);

    const messages = port.messages();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'hello',
      session: 3,
      stream: { rate: 200, scenario: 'steady', seed: 42 },
      limits: { minRate: 10 },
    });
    expect(messages[0]).toHaveProperty('expiresAt');
  });

  it('posts each server batch as transferred columns with the counters, never as events', () => {
    const { port, start, batches } = setup();
    const socket = start();
    connect(socket);

    socket.receive(frame([1, 2, 3]));
    socket.receive(frame([6, 7], 1));

    const [first, second] = batches();
    expect(first).toMatchObject({
      session: 1,
      columns: { firstPosition: 0, count: 3, message: ['event 1', 'event 2', 'event 3'] },
      counters: { received: 3, missed: 0, dropped: 0 },
    });
    expect(Object.keys(first ?? {}).sort()).toEqual(['columns', 'counters', 'session', 'type']);
    expect(second).toMatchObject({
      columns: { firstPosition: 3, count: 2, newServices: [], newHosts: [] },
      counters: { received: 5, missed: 2, dropped: 1 },
    });
    expect(Array.from(second?.columns.seq ?? [])).toEqual([6, 7]);

    // The six typed-array buffers went over as transferables and are detached in the worker.
    const posted = port.posted.filter(({ message }) => message.type === 'batch');
    for (const { transfer } of posted) {
      expect(transfer).toHaveLength(6);
      for (const buffer of transfer) {
        expect(buffer).toBeInstanceOf(ArrayBuffer);
        expect(buffer instanceof ArrayBuffer && buffer.byteLength).toBe(0);
      }
    }
  });

  it('replicates into a store on the main thread row for row', () => {
    const { start, batches } = setup();
    const socket = start(1, 1000);
    connect(socket);
    socket.receive(frame(seqs(1, 700)));
    socket.receive(frame(seqs(701, 700)));

    const replica = createEventStore({ capacity: 1000, keepPayload: false });
    for (const { columns } of batches()) replica.appendColumns(columns);

    // Both evicted on append: the worker's store and the replica keep the newest 1,000 events.
    expect([replica.start, replica.end]).toEqual([400, 1400]);
    expect(replica.eventAt(1399)).toEqual(testLogEvent(1400));
    expect(replica.eventAt(400)).toEqual(testLogEvent(401));
  });

  it(`splits a backlog into column batches of at most ${String(MAX_COLUMN_BATCH_ROWS)} rows`, () => {
    const { start, batches } = setup();
    const socket = start(1, 20_000);
    connect(socket);

    socket.receive(frame(seqs(1, 10_000)));

    expect(batches().map(({ columns }) => [columns.firstPosition, columns.count])).toEqual([
      [0, MAX_COLUMN_BATCH_ROWS],
      [MAX_COLUMN_BATCH_ROWS, 10_000 - MAX_COLUMN_BATCH_ROWS],
    ]);
  });

  it('posts counters on heartbeats, so events per second falls once batches stop', () => {
    const { port, start, advance } = setup();
    const socket = start();
    connect(socket);
    socket.receive(frame(seqs(1, 100)));
    advance(500);

    socket.receive(JSON.stringify(testHeartbeat(100)));
    expect(port.messages().at(-1)).toMatchObject({
      type: 'counters',
      session: 1,
      counters: { received: 100, eventsPerSecond: 200 },
    });

    advance(1000);
    socket.receive(JSON.stringify(testHeartbeat(100)));
    expect(port.messages().at(-1)).toMatchObject({
      type: 'counters',
      counters: { received: 100, eventsPerSecond: 0 },
    });
  });

  it('counts invalid frames and reports them without a batch', () => {
    const { port, start } = setup();
    const socket = start();
    connect(socket);

    socket.receive('not json');

    expect(port.messages().at(-1)).toMatchObject({
      type: 'counters',
      counters: { invalidFrames: 1, received: 0 },
    });
    expect(socket.closedWith).toBeUndefined();
  });

  it('reports the close code and reason with the final counters', () => {
    const { port, start, advance } = setup();
    const socket = start(2);
    connect(socket);
    socket.receive(frame([1, 2]));
    advance(500);

    socket.closeFromServer(4000, 'session expired');

    expect(port.messages().at(-1)).toEqual({
      type: 'closed',
      session: 2,
      code: 4000,
      reason: 'session expired',
      counters: { received: 2, eventsPerSecond: 4, missed: 0, dropped: 0, invalidFrames: 0 },
    });
  });

  it('reports a socket the browser refuses to open as a connection that never opened', async () => {
    vi.stubGlobal(
      'WebSocket',
      vi.fn(function refuse() {
        throw new SyntaxError("The URL 'ws://x/ws#a' contains a fragment identifier");
      }),
    );
    const { port } = setup();

    port.receive({ type: 'start', session: 1, endpoint: ENDPOINT, request: {}, capacity: 1000 });
    await Promise.resolve();

    expect(port.messages()).toEqual([
      {
        type: 'closed',
        session: 1,
        code: 1006,
        reason: "The URL 'ws://x/ws#a' contains a fragment identifier",
        counters: { received: 0, eventsPerSecond: 0, missed: 0, dropped: 0, invalidFrames: 0 },
      },
    ]);
  });

  it('starts a new session with a new connection and buffer, closing the previous one', () => {
    const { port, start, batches } = setup();
    const first = start(1);
    connect(first);
    first.receive(frame([1, 2, 3]));

    const second = start(2);
    connect(second);
    second.receive(frame([1]));

    expect(first.closedWith?.code).toBe(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(batches().at(-1)).toMatchObject({
      session: 2,
      columns: { firstPosition: 0, count: 1, newServices: ['orders'] },
      counters: { received: 1 },
    });
    // The closed connection's handlers are detached: nothing more for session 1.
    const posted = port.posted.length;
    first.receive(frame([4]));
    expect(port.posted).toHaveLength(posted);
  });

  it("closes the connection on stop, but only for the current session's stop", () => {
    const { port, start } = setup();
    const socket = start(5);
    connect(socket);

    port.receive({ type: 'stop', session: 4 });
    expect(socket.closedWith).toBeUndefined();

    port.receive({ type: 'stop', session: 5 });
    expect(socket.closedWith?.code).toBe(1000);
  });

  it('counts a batch the store rejects as an invalid frame and keeps the events before it', () => {
    let handlers: StreamSocketHandlers = {};
    const port = new FakeMessagePort<ToWorkerMessage, FromWorkerMessage>();
    createStreamWorkerHost(port, {
      now: () => 0,
      openSocket: (_endpoint, _request, socketHandlers) => {
        handlers = socketHandlers;
        return { url: ENDPOINT, invalidFrames: 0, configure: () => false, close: vi.fn() };
      },
    });
    port.receive({ type: 'start', session: 1, endpoint: ENDPOINT, request: {}, capacity: 100 });
    // A hole, which `parseServerMessage` never produces.
    const events: LogEvent[] = [testLogEvent(1)];
    events[2] = testLogEvent(3);

    handlers.onBatch?.({ type: 'batch', sentAt: 0, events });

    expect(port.messages().at(-1)).toMatchObject({
      type: 'batch',
      columns: { firstPosition: 0, count: 1 },
      counters: { invalidFrames: 1, received: 1 },
    });

    // Only the appended event counts as received; the rejected ones surface as missed.
    handlers.onBatch?.(testBatch([4]));
    expect(port.messages().at(-1)).toMatchObject({
      columns: { firstPosition: 1, count: 1 },
      counters: { received: 2, missed: 2, invalidFrames: 1 },
    });
  });

  it("forwards configure to the session's socket and posts the server's config", () => {
    const { port, start } = setup();
    const socket = start(4);
    connect(socket);

    port.receive({ type: 'configure', session: 4, requestId: 'cfg-3', rate: 50_000 });
    expect(socket.sent).toEqual(['{"type":"configure","requestId":"cfg-3","rate":50000}']);

    socket.receive(configFrame);
    socket.receive(JSON.stringify({ type: 'config', rate: 300, scenario: 'steady' }));

    expect(port.messages().slice(-2)).toEqual([
      { type: 'config', session: 4, requestId: 'cfg-3', rate: 20_000, scenario: 'error-burst' },
      { type: 'config', session: 4, rate: 300, scenario: 'steady' },
    ]);
  });

  it("posts the server's error as stream-error, whatever its code", () => {
    const { port, start } = setup();
    const socket = start(2);
    connect(socket);

    socket.receive(errorUnknownCodeFrame);

    expect(port.messages().at(-1)).toEqual({
      type: 'stream-error',
      session: 2,
      code: 'rate-limited',
      message: 'Too many configure messages; wait before sending another',
    });
    expect(socket.closedWith).toBeUndefined();
  });

  it('answers a configure without an open connection with stream-error', () => {
    const { port, start } = setup();
    const socket = start(1);

    port.receive({ type: 'configure', session: 1, requestId: 'cfg-1', scenario: 'steady' });

    expect(socket.sent).toEqual([]);
    expect(port.messages().at(-1)).toMatchObject({
      type: 'stream-error',
      session: 1,
      code: NOT_CONNECTED_ERROR_CODE,
    });
  });

  it('ignores a configure for an older session', () => {
    const { port, start } = setup();
    const socket = start(3);
    connect(socket);
    const posted = port.posted.length;

    port.receive({ type: 'configure', session: 2, requestId: 'cfg-1', rate: 500 });

    expect(socket.sent).toEqual([]);
    expect(port.posted).toHaveLength(posted);
  });

  it('closes the connection and stops listening when disposed', () => {
    const { port, host, start } = setup();
    const socket = start();
    connect(socket);

    host.dispose();
    port.receive({ type: 'start', session: 2, endpoint: ENDPOINT, request: {}, capacity: 1000 });

    expect(socket.closedWith?.code).toBe(1000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(port.onmessage).toBeNull();
  });
});
