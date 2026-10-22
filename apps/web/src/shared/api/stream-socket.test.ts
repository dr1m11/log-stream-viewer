import batchFrame from '@lsv/protocol/fixtures/v1/batch.json?raw';
import batchUnknownFieldsFrame from '@lsv/protocol/fixtures/v1/batch-unknown-fields.json?raw';
import configFrame from '@lsv/protocol/fixtures/v1/config.json?raw';
import errorFrame from '@lsv/protocol/fixtures/v1/error.json?raw';
import heartbeatFrame from '@lsv/protocol/fixtures/v1/heartbeat.json?raw';
import helloFrame from '@lsv/protocol/fixtures/v1/hello.json?raw';
import invalidBatchFrame from '@lsv/protocol/fixtures/v1/invalid-batch-unknown-level.json?raw';
import invalidHelloFrame from '@lsv/protocol/fixtures/v1/invalid-hello-missing-stream-id.json?raw';
import unknownTypeFrame from '@lsv/protocol/fixtures/v1/invalid-server-unknown-type.json?raw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeWebSocket } from '@/shared/lib/testing';

import { HELLO_TIMEOUT_MS, openStreamSocket, type StreamRequest } from './stream-socket';

const ENDPOINT = 'ws://localhost:8787/ws';

function parsed(frame: string): unknown {
  return JSON.parse(frame);
}

function spyHandlers() {
  return {
    onHello: vi.fn(),
    onBatch: vi.fn(),
    onHeartbeat: vi.fn(),
    onConfig: vi.fn(),
    onError: vi.fn(),
    onInvalidFrame: vi.fn(),
    onClose: vi.fn(),
  };
}

function connect(request: StreamRequest = {}) {
  const handlers = spyHandlers();
  const stream = openStreamSocket(ENDPOINT, request, handlers);
  return { stream, handlers, socket: FakeWebSocket.latest() };
}

describe('openStreamSocket', () => {
  beforeEach(() => {
    FakeWebSocket.reset();
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reports a socket the browser refuses to create as a connection that never opened', async () => {
    vi.stubGlobal(
      'WebSocket',
      vi.fn(function refuse() {
        throw new SyntaxError("The URL 'ws://x/ws#a' contains a fragment identifier");
      }),
    );
    const handlers = spyHandlers();

    const stream = openStreamSocket('ws://x/ws#a', {}, handlers);
    expect(handlers.onClose).not.toHaveBeenCalled();
    await Promise.resolve();

    expect(handlers.onClose).toHaveBeenCalledExactlyOnceWith(
      1006,
      "The URL 'ws://x/ws#a' contains a fragment identifier",
    );
    expect(stream.invalidFrames).toBe(0);
  });

  it('stays silent about a refused socket that is closed right away', async () => {
    vi.stubGlobal(
      'WebSocket',
      vi.fn(function refuse() {
        throw new DOMException(
          'An insecure WebSocket connection may not be initiated',
          'SecurityError',
        );
      }),
    );
    const handlers = spyHandlers();

    openStreamSocket(ENDPOINT, {}, handlers).close();
    await Promise.resolve();

    expect(handlers.onClose).not.toHaveBeenCalled();
  });

  it('gives up when the server sends no hello in time after the socket opens', () => {
    vi.useFakeTimers();
    const { socket, handlers } = connect();
    socket.open();
    socket.receive(invalidHelloFrame);

    vi.advanceTimersByTime(HELLO_TIMEOUT_MS - 1);
    expect(handlers.onClose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(socket.closedWith?.code).toBe(1000);
    expect(handlers.onClose).toHaveBeenCalledExactlyOnceWith(
      1002,
      'server did not complete the handshake within 2 s',
    );
  });

  it('stops waiting for hello once it arrives or the connection ends', () => {
    vi.useFakeTimers();
    const answered = connect();
    answered.socket.open();
    answered.socket.receive(helloFrame);
    const dropped = connect();
    dropped.socket.open();
    dropped.socket.closeFromServer(1006);
    const closed = connect();
    closed.socket.open();
    closed.stream.close();

    vi.advanceTimersByTime(10 * HELLO_TIMEOUT_MS);

    expect(answered.handlers.onClose).not.toHaveBeenCalled();
    expect(answered.socket.closedWith).toBeUndefined();
    expect(dropped.handlers.onClose).toHaveBeenCalledExactlyOnceWith(1006, '');
    expect(closed.handlers.onClose).not.toHaveBeenCalled();
  });

  it('connects with protocol v1 and only the stream settings it was given', () => {
    const { stream, socket } = connect({ rate: 500, scenario: 'error-burst', seed: 42 });
    expect(socket.url).toBe(`${ENDPOINT}?v=1&rate=500&scenario=error-burst&seed=42`);
    expect(stream.url).toBe(socket.url);

    expect(connect().socket.url).toBe(`${ENDPOINT}?v=1`);
  });

  it('reports hello, batches and heartbeats as parsed messages', () => {
    const { socket, handlers } = connect();
    socket.open();

    socket.receive(helloFrame);
    socket.receive(batchFrame);
    socket.receive(heartbeatFrame);

    expect(handlers.onHello).toHaveBeenCalledExactlyOnceWith(parsed(helloFrame));
    expect(handlers.onBatch).toHaveBeenCalledExactlyOnceWith(parsed(batchFrame));
    expect(handlers.onHeartbeat).toHaveBeenCalledExactlyOnceWith(parsed(heartbeatFrame));
    expect(handlers.onInvalidFrame).not.toHaveBeenCalled();
  });

  it('accepts messages with fields this version does not know', () => {
    const { socket, handlers } = connect();

    socket.receive(batchUnknownFieldsFrame);

    expect(handlers.onBatch).toHaveBeenCalledExactlyOnceWith(parsed(batchUnknownFieldsFrame));
  });

  it('ignores messages of an unknown type', () => {
    const { stream, socket, handlers } = connect();

    socket.receive(unknownTypeFrame);

    expect(stream.invalidFrames).toBe(0);
    for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
  });

  it('reports the answers to configure: config and error', () => {
    const { socket, handlers } = connect();
    socket.open();
    socket.receive(helloFrame);

    socket.receive(configFrame);
    socket.receive(errorFrame);

    expect(handlers.onConfig).toHaveBeenCalledExactlyOnceWith(parsed(configFrame));
    expect(handlers.onError).toHaveBeenCalledExactlyOnceWith(parsed(errorFrame));
    expect(socket.closedWith).toBeUndefined();
  });

  it('sends configure as one JSON text frame with only the fields it was given', () => {
    const { stream, socket } = connect();
    socket.open();
    socket.receive(helloFrame);

    expect(stream.configure({ requestId: 'cfg-1', rate: 1000 })).toBe(true);
    expect(stream.configure({ requestId: 'cfg-2', scenario: 'traffic-spike' })).toBe(true);

    expect(socket.sent).toEqual([
      '{"type":"configure","requestId":"cfg-1","rate":1000}',
      '{"type":"configure","requestId":"cfg-2","scenario":"traffic-spike"}',
    ]);
  });

  it('sends no configure unless the socket is open', async () => {
    const { stream, socket } = connect();
    expect(stream.configure({ requestId: 'cfg-1', rate: 1000 })).toBe(false);

    socket.open();
    socket.closeFromServer(1001, 'server shutting down');
    expect(stream.configure({ requestId: 'cfg-2', rate: 1000 })).toBe(false);

    const open = connect();
    open.socket.open();
    open.stream.close();
    expect(open.stream.configure({ requestId: 'cfg-3', rate: 1000 })).toBe(false);

    vi.stubGlobal(
      'WebSocket',
      vi.fn(function refuse() {
        throw new SyntaxError('bad URL');
      }),
    );
    const refused = openStreamSocket(ENDPOINT, {}, spyHandlers());
    expect(refused.configure({ requestId: 'cfg-4', rate: 1000 })).toBe(false);
    await Promise.resolve();

    expect([...socket.sent, ...open.socket.sent]).toEqual([]);
  });

  it('counts and drops malformed frames without closing the connection', () => {
    const { stream, socket, handlers } = connect();
    socket.open();

    socket.receive('{"type": "batch", "events": [');
    socket.receive(invalidHelloFrame);
    socket.receive(invalidBatchFrame);
    socket.receive(new Blob([batchFrame]));
    socket.receive(batchFrame);

    expect(stream.invalidFrames).toBe(4);
    expect(handlers.onInvalidFrame.mock.calls.map(([error]: unknown[]) => error)).toEqual([
      expect.objectContaining({ kind: 'invalid-json' }),
      expect.objectContaining({ kind: 'invalid-message' }),
      expect.objectContaining({ kind: 'invalid-message' }),
      expect.objectContaining({ kind: 'invalid-message' }),
    ]);
    expect(handlers.onBatch).toHaveBeenCalledOnce();
    expect(socket.closedWith).toBeUndefined();
    expect(handlers.onClose).not.toHaveBeenCalled();
  });

  it.each([
    [4000, 'session expired'],
    [4001, 'unsupported protocol version'],
    [4029, 'busy; retry-after=30'],
    [1001, 'server shutting down'],
    [1006, ''],
  ])('reports the close code %i with its reason, once', (code, reason) => {
    const { socket, handlers } = connect();
    socket.open();

    socket.closeFromServer(code, reason);
    socket.closeFromServer(code, reason);

    expect(handlers.onClose).toHaveBeenCalledExactlyOnceWith(code, reason);
  });

  it('treats a hello in another protocol version like an unsupported version', () => {
    const { socket, handlers } = connect();
    socket.open();
    const helloV2 = helloFrame.replace('"protocolVersion": 1', '"protocolVersion": 2');
    expect(helloV2).not.toBe(helloFrame);

    socket.receive(helloV2);
    socket.receive(batchFrame);

    expect(handlers.onHello).not.toHaveBeenCalled();
    expect(handlers.onBatch).not.toHaveBeenCalled();
    expect(socket.closedWith?.code).toBe(1000);
    expect(handlers.onClose).toHaveBeenCalledExactlyOnceWith(4001, 'server speaks protocol v2');
  });

  it('closes an open socket on close() and runs no handler afterwards', () => {
    const { stream, socket, handlers } = connect();
    socket.open();

    stream.close();
    stream.close();
    socket.receive(batchFrame);
    socket.closeFromServer(1000);

    expect(socket.closedWith).toEqual({ code: 1000, reason: undefined });
    for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
  });

  it('waits for the handshake to finish before closing a connecting socket', () => {
    const { stream, socket, handlers } = connect();

    stream.close();
    expect(socket.closedWith).toBeUndefined();

    socket.open();
    socket.receive(helloFrame);

    expect(socket.closedWith?.code).toBe(1000);
    expect(handlers.onHello).not.toHaveBeenCalled();
  });

  it('does nothing on close() once the server has closed the connection', () => {
    const { stream, socket, handlers } = connect();
    socket.open();
    socket.closeFromServer(4000, 'session expired');

    stream.close();

    expect(socket.closedWith).toBeUndefined();
    expect(handlers.onClose).toHaveBeenCalledOnce();
  });
});
