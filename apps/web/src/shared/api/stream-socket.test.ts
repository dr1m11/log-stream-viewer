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

import { openStreamSocket, type StreamRequest } from './stream-socket';

const ENDPOINT = 'ws://localhost:8787/ws';

function parsed(frame: string): unknown {
  return JSON.parse(frame);
}

function connect(request: StreamRequest = {}) {
  const handlers = {
    onHello: vi.fn(),
    onBatch: vi.fn(),
    onHeartbeat: vi.fn(),
    onInvalidFrame: vi.fn(),
    onClose: vi.fn(),
  };
  const stream = openStreamSocket(ENDPOINT, request, handlers);
  return { stream, handlers, socket: FakeWebSocket.latest() };
}

describe('openStreamSocket', () => {
  beforeEach(() => {
    FakeWebSocket.reset();
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it('ignores messages of an unknown type and answers to configure', () => {
    const { stream, socket, handlers } = connect();

    socket.receive(unknownTypeFrame);
    socket.receive(configFrame);
    socket.receive(errorFrame);

    expect(stream.invalidFrames).toBe(0);
    for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
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
