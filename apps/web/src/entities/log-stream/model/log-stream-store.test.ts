import { type ColumnBatch, createEventStore, type StreamCounters } from '@lsv/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeWorker, testBatch, testHello } from '@/shared/lib/testing';

import type { FromWorkerMessage } from '../api/worker-protocol';
import { createLogStreamStore, PREVIEW_INTERVAL_MS } from './log-stream-store';

const ENDPOINT = 'ws://localhost:8787/ws';

function counters(overrides: Partial<StreamCounters> = {}): StreamCounters {
  return { received: 0, eventsPerSecond: 0, missed: 0, dropped: 0, invalidFrames: 0, ...overrides };
}

/**
 * Stands in for the worker's store: encodes the events of `testBatch(seqs)` as the worker would
 * post them, positions continuing from the previous call.
 */
function createSource(capacity = 10_000) {
  const store = createEventStore({ capacity, keepPayload: true });
  return (seqs: readonly number[]): ColumnBatch => {
    store.appendEvents(testBatch(seqs).events);
    const batch = store.takeColumnBatch();
    if (batch === undefined) throw new Error('No rows to encode');
    return batch;
  };
}

/** `count` consecutive `seq` numbers starting at `first`. */
function seqs(first: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => first + index);
}

function setup(capacity = 10_000) {
  const store = createLogStreamStore({
    endpoint: ENDPOINT,
    request: { rate: 500 },
    capacity,
    spawnWorker: () => new FakeWorker(),
  });
  const listener = vi.fn<() => void>();
  store.subscribe(listener);
  store.start();
  const worker = (): FakeWorker => FakeWorker.latest();
  /** What the current worker posts for `session` (default: the latest one started). */
  const send = (message: FromWorkerMessage): void => {
    worker().receive(message);
  };
  const hello = (session = 1): void => {
    const { stream, limits, expiresAt } = testHello();
    send({ type: 'hello', session, stream, limits, expiresAt });
  };
  return { store, listener, worker, send, hello };
}

/** Lets one animation frame pass (the fake clock runs requestAnimationFrame every 16 ms). */
function nextFrame(): void {
  vi.advanceTimersByTime(16);
}

describe('createLogStreamStore', () => {
  beforeEach(() => {
    FakeWorker.reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts the worker with the endpoint, the stream request and the buffer capacity', () => {
    const { worker } = setup(250_000);

    expect(FakeWorker.instances).toHaveLength(1);
    expect(worker().messages()).toEqual([
      { type: 'start', session: 1, endpoint: ENDPOINT, request: { rate: 500 }, capacity: 250_000 },
    ]);
  });

  it('goes from connecting to connected with the stream and its limits, then to closed with the code', () => {
    const { store, send, hello } = setup();
    expect(store.getSnapshot().status).toEqual({ phase: 'connecting' });

    hello();
    nextFrame();
    const { stream, limits, expiresAt } = testHello();
    expect(store.getSnapshot().status).toEqual({ phase: 'connected', stream, limits, expiresAt });

    send({
      type: 'closed',
      session: 1,
      code: 4000,
      reason: 'session expired',
      counters: counters(),
    });
    nextFrame();
    expect(store.getSnapshot().status).toEqual({
      phase: 'closed',
      code: 4000,
      reason: 'session expired',
      wasConnected: true,
    });
  });

  it('remembers that a connection closed before the stream started', () => {
    const { store, send } = setup();

    send({ type: 'closed', session: 1, code: 1006, reason: '', counters: counters() });
    nextFrame();

    expect(store.getSnapshot().status).toMatchObject({ code: 1006, wasConnected: false });
  });

  it('appends batches to the replica and publishes at most once per animation frame', () => {
    const { store, listener, send, hello } = setup();
    const encode = createSource();
    hello();
    for (let batch = 0; batch < 5; batch++) {
      send({
        type: 'batch',
        session: 1,
        columns: encode(seqs(batch * 10 + 1, 10)),
        counters: counters({ received: (batch + 1) * 10, eventsPerSecond: 200 }),
      });
    }
    expect(listener).not.toHaveBeenCalled();

    nextFrame();
    expect(listener).toHaveBeenCalledOnce();
    const snapshot = store.getSnapshot();
    expect(snapshot).toMatchObject({
      start: 0,
      end: 50,
      counters: { received: 50, eventsPerSecond: 200 },
    });
    expect(snapshot.buffer.messageAt(49)).toBe('event 50');
    expect(snapshot.buffer.hasPayloadAt(49)).toBe(false);

    nextFrame();
    expect(listener).toHaveBeenCalledOnce();
  });

  it('keeps the replica at its capacity while no frame runs, as in a hidden tab', () => {
    const { store, send, hello } = setup(1000);
    const encode = createSource(1000);
    hello();

    for (let batch = 0; batch < 3; batch++) {
      send({
        type: 'batch',
        session: 1,
        columns: encode(seqs(batch * 600 + 1, 600)),
        counters: counters(),
      });
    }

    const { buffer } = store.getSnapshot();
    expect([buffer.start, buffer.end, buffer.size]).toEqual([800, 1800, 1000]);
    expect(buffer.seqAt(800)).toBe(801);
  });

  it('updates counters without rows and keeps the snapshot when nothing changed', () => {
    const { store, listener, send, hello } = setup();
    hello();
    send({ type: 'counters', session: 1, counters: counters({ invalidFrames: 1 }) });
    nextFrame();
    expect(listener).toHaveBeenCalledOnce();
    const snapshot = store.getSnapshot();
    expect(snapshot.counters.invalidFrames).toBe(1);

    send({ type: 'counters', session: 1, counters: counters({ invalidFrames: 1 }) });
    nextFrame();

    expect(store.getSnapshot()).toBe(snapshot);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('reports no events per second unless connected', () => {
    const { store, send, hello } = setup();
    send({ type: 'counters', session: 1, counters: counters({ eventsPerSecond: 120 }) });
    nextFrame();
    expect(store.getSnapshot().counters.eventsPerSecond).toBe(0);

    hello();
    nextFrame();
    expect(store.getSnapshot().counters.eventsPerSecond).toBe(120);

    send({
      type: 'closed',
      session: 1,
      code: 1001,
      reason: 'server shutting down',
      counters: counters({ received: 50, eventsPerSecond: 80 }),
    });
    nextFrame();
    expect(store.getSnapshot().counters).toMatchObject({ eventsPerSecond: 0, received: 50 });
  });

  it('refreshes the latest-event preview at most every 250 ms, and catches up afterwards', () => {
    const { store, send, hello } = setup();
    const encode = createSource();
    hello();

    send({ type: 'batch', session: 1, columns: encode([1, 2]), counters: counters() });
    nextFrame();
    expect(store.getSnapshot().latest?.seq).toBe(2);

    vi.advanceTimersByTime(50);
    send({ type: 'batch', session: 1, columns: encode([3, 4]), counters: counters() });
    nextFrame();
    expect(store.getSnapshot()).toMatchObject({ end: 4, latest: { seq: 2 } });

    // No further batches: the preview still shows the newest event once the interval is over.
    vi.advanceTimersByTime(PREVIEW_INTERVAL_MS);
    expect(store.getSnapshot().latest).toEqual(testBatch([4]).events[0]);
  });

  it('starts over with a new session, buffer and counters on start(), dropping old messages', () => {
    const { store, listener, worker, send, hello } = setup();
    const encode = createSource();
    hello();
    send({
      type: 'batch',
      session: 1,
      columns: encode([1, 2, 3]),
      counters: counters({ received: 3 }),
    });
    nextFrame();
    const first = store.getSnapshot().buffer;
    listener.mockClear();

    store.start();

    expect(FakeWorker.instances).toHaveLength(1);
    expect(worker().messages().at(-1)).toMatchObject({ type: 'start', session: 2 });
    expect(listener).toHaveBeenCalledOnce();
    const snapshot = store.getSnapshot();
    expect(snapshot).toMatchObject({
      status: { phase: 'connecting' },
      counters: { received: 0 },
      start: 0,
      end: 0,
      latest: undefined,
    });
    expect(snapshot.buffer).not.toBe(first);

    // Session 1 is over: what the worker still had queued for it changes nothing.
    send({ type: 'batch', session: 1, columns: encode([4]), counters: counters({ received: 4 }) });
    hello(1);
    nextFrame();
    expect(store.getSnapshot()).toBe(snapshot);
  });

  it('reuses a replica that never received a row', () => {
    const { store } = setup();
    const { buffer } = store.getSnapshot();

    store.start();

    expect(store.getSnapshot().buffer).toBe(buffer);
  });

  it('exposes the replica read-only', () => {
    const { store } = setup();

    const { buffer } = store.getSnapshot();

    expect(buffer).not.toHaveProperty('appendColumns');
    expect(buffer).not.toHaveProperty('clear');
    expect(buffer.capacity).toBe(10_000);
  });

  it('restarts with a new session when a batch does not continue the replica', () => {
    const { store, worker, send, hello } = setup();
    const encode = createSource();
    hello();
    const columns = encode([1, 2, 3]);
    send({ type: 'batch', session: 1, columns, counters: counters({ received: 3 }) });
    nextFrame();
    const first = store.getSnapshot().buffer;

    // The same rows again: they start before the replica's end, so the two stores disagree.
    send({ type: 'batch', session: 1, columns, counters: counters({ received: 6 }) });
    nextFrame();

    expect(worker().messages().at(-1)).toMatchObject({ type: 'start', session: 2 });
    const snapshot = store.getSnapshot();
    expect(snapshot).toMatchObject({
      status: { phase: 'connecting' },
      end: 0,
      counters: { received: 0 },
    });
    expect(snapshot.buffer).not.toBe(first);
    expect(snapshot.error).toMatch(/fell out of step/);

    // The new session runs normally; a manual start clears the error.
    hello(2);
    nextFrame();
    expect(store.getSnapshot().status.phase).toBe('connected');
    store.start();
    expect(store.getSnapshot().error).toBeUndefined();
  });

  it('terminates the worker and publishes nothing more on stop()', () => {
    const { store, listener, worker, send, hello } = setup();
    hello();
    const stopped = worker();

    store.stop();
    vi.advanceTimersByTime(1000);

    expect(stopped.messages().at(-1)).toEqual({ type: 'stop', session: 1 });
    expect(stopped.terminated).toBe(true);
    expect(stopped.onmessage).toBeNull();
    expect(listener).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    send({ type: 'counters', session: 1, counters: counters({ received: 9 }) });
    vi.advanceTimersByTime(1000);
    expect(listener).not.toHaveBeenCalled();
  });

  it('spawns a new worker when started again after stop()', () => {
    const { store, worker } = setup();

    store.stop();
    store.start();

    expect(FakeWorker.instances).toHaveLength(2);
    expect(worker().messages()).toEqual([expect.objectContaining({ type: 'start', session: 3 })]);
  });

  it('reports a worker that failed as a closed connection and lets it go', () => {
    const { store, worker, hello } = setup();
    hello();
    const failed = worker();

    failed.fail('Script error');
    nextFrame();

    expect(store.getSnapshot().status).toEqual({
      phase: 'closed',
      code: 1006,
      reason: 'The stream worker failed: Script error',
      wasConnected: true,
    });
    expect(failed.terminated).toBe(true);
  });
});
