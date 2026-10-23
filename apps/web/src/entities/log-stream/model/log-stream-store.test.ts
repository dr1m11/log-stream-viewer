import { type ColumnBatch, createEventStore, type StreamCounters } from '@lsv/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeWorker, testBatch, testHello } from '@/shared/lib/testing';

import type { FromWorkerMessage } from '../api/worker-protocol';
import { createLogStreamStore, MAX_AUTO_RESTARTS } from './log-stream-store';

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

  it(`gives up after ${String(MAX_AUTO_RESTARTS)} automatic restarts per start()`, () => {
    const { store, worker, send } = setup();
    /** Sends the same rows twice in `session`: the second batch does not continue the replica. */
    const desync = (session: number): void => {
      const columns = createSource()([1, 2]);
      send({ type: 'batch', session, columns, counters: counters() });
      send({ type: 'batch', session, columns, counters: counters() });
    };

    for (let restart = 1; restart <= MAX_AUTO_RESTARTS; restart++) desync(restart);
    expect(worker().messages().at(-1)).toMatchObject({
      type: 'start',
      session: MAX_AUTO_RESTARTS + 1,
    });

    desync(MAX_AUTO_RESTARTS + 1);
    nextFrame();

    // No further connection: the current one is stopped and the status explains why.
    expect(worker().messages().at(-1)).toEqual({ type: 'stop', session: MAX_AUTO_RESTARTS + 1 });
    expect(store.getSnapshot().status).toMatchObject({
      phase: 'closed',
      code: 1002,
      reason: expect.stringMatching(
        /fell out of step.*gave up after 3 automatic restarts/,
      ) as unknown,
    });
    const starts = worker()
      .messages()
      .filter(
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          message.type === 'start',
      );
    expect(starts).toHaveLength(MAX_AUTO_RESTARTS + 1);

    // A manual start gets a fresh allowance.
    store.start();
    desync(MAX_AUTO_RESTARTS + 3);
    expect(worker().messages().at(-1)).toMatchObject({
      type: 'start',
      session: MAX_AUTO_RESTARTS + 4,
    });
  });

  it('restarts when a message from the worker cannot be deserialized, within the same cap', () => {
    const { store, worker, hello } = setup();
    hello();

    worker().receiveUnreadable();
    nextFrame();

    expect(worker().messages().at(-1)).toMatchObject({ type: 'start', session: 2 });
    expect(store.getSnapshot()).toMatchObject({
      status: { phase: 'connecting' },
      error: 'Restarted the stream: a message from the stream worker could not be deserialized.',
    });

    for (let restart = 2; restart <= MAX_AUTO_RESTARTS; restart++) worker().receiveUnreadable();
    worker().receiveUnreadable();
    nextFrame();

    expect(store.getSnapshot().status).toMatchObject({ phase: 'closed', code: 1002 });
    expect(worker().messages().at(-1)).toMatchObject({ type: 'stop' });
  });

  it('sends configure only while connected, with a new request id each time', () => {
    const { store, worker, hello } = setup();
    expect(store.configure({ rate: 1000 })).toBeUndefined();
    expect(worker().messages()).toHaveLength(1);

    hello();
    expect(store.configure({ rate: 1000 })).toBe('cfg-1');
    expect(store.configure({ scenario: 'error-burst' })).toBe('cfg-2');

    expect(worker().messages().slice(1)).toEqual([
      { type: 'configure', session: 1, requestId: 'cfg-1', rate: 1000, scenario: undefined },
      {
        type: 'configure',
        session: 1,
        requestId: 'cfg-2',
        rate: undefined,
        scenario: 'error-burst',
      },
    ]);
  });

  it("publishes the pending change at once and applies the server's config to the status", () => {
    const { store, listener, send, hello } = setup();
    hello();
    nextFrame();
    listener.mockClear();

    const requestId = store.configure({ rate: 50_000, scenario: 'traffic-spike' });
    expect(listener).toHaveBeenCalledOnce();
    expect(store.getSnapshot().settings).toEqual({
      pending: { requestId, rate: 50_000, scenario: 'traffic-spike' },
      error: undefined,
    });
    const before = store.getSnapshot().status;

    send({ type: 'config', session: 1, requestId, rate: 20_000, scenario: 'traffic-spike' });
    nextFrame();

    const { status, settings } = store.getSnapshot();
    expect(status).not.toBe(before);
    expect(status).toMatchObject({
      phase: 'connected',
      stream: { rate: 20_000, scenario: 'traffic-spike', seed: 42 },
      limits: testHello().limits,
    });
    expect(settings).toEqual({ pending: undefined, error: undefined });
  });

  it('keeps the latest request pending until its own answer arrives', () => {
    const { store, send, hello } = setup();
    hello();
    const first = store.configure({ rate: 300 });
    const second = store.configure({ rate: 400 });
    expect(first).not.toBe(second);

    // The answer to the first request, then a change the server made on its own.
    send({ type: 'config', session: 1, requestId: first, rate: 300, scenario: 'steady' });
    send({ type: 'config', session: 1, rate: 300, scenario: 'error-burst' });
    nextFrame();
    expect(store.getSnapshot()).toMatchObject({
      status: { stream: { rate: 300, scenario: 'error-burst' } },
      settings: { pending: { requestId: second, rate: 400 } },
    });

    send({ type: 'config', session: 1, requestId: second, rate: 400, scenario: 'error-burst' });
    nextFrame();
    expect(store.getSnapshot()).toMatchObject({
      status: { stream: { rate: 400 } },
      settings: { pending: undefined },
    });
  });

  it('merges unanswered requests, so a rate after a scenario keeps the pending scenario', () => {
    const { store, send, hello } = setup();
    hello();
    const first = store.configure({ scenario: 'error-burst' });
    const second = store.configure({ rate: 900 });
    expect(store.getSnapshot().settings.pending).toEqual({
      requestId: second,
      rate: 900,
      scenario: 'error-burst',
    });

    // The answer to the older request applies its settings but leaves the merged request pending.
    send({ type: 'config', session: 1, requestId: first, rate: 200, scenario: 'error-burst' });
    nextFrame();
    expect(store.getSnapshot()).toMatchObject({
      status: { stream: { rate: 200, scenario: 'error-burst' } },
      settings: { pending: { requestId: second, rate: 900, scenario: 'error-burst' } },
    });

    send({ type: 'config', session: 1, requestId: second, rate: 900, scenario: 'error-burst' });
    nextFrame();
    expect(store.getSnapshot()).toMatchObject({
      status: { stream: { rate: 900, scenario: 'error-burst' } },
      settings: { pending: undefined },
    });

    // Once answered, a new request starts from the effective settings again.
    const third = store.configure({ rate: 100 });
    expect(store.getSnapshot().settings.pending).toEqual({
      requestId: third,
      rate: 100,
      scenario: undefined,
    });
  });

  it('surfaces a stream-error, keeps the effective settings and clears it on the next request', () => {
    const { store, send, hello } = setup();
    hello();
    nextFrame();
    const { status } = store.getSnapshot();
    store.configure({ scenario: 'error-burst' });

    send({ type: 'stream-error', session: 1, code: 'bad-message', message: 'Invalid scenario' });
    nextFrame();

    expect(store.getSnapshot().status).toBe(status);
    expect(store.getSnapshot().settings).toEqual({
      pending: undefined,
      error: { code: 'bad-message', message: 'Invalid scenario' },
    });

    const requestId = store.configure({ rate: 500 });
    expect(store.getSnapshot().settings).toEqual({
      pending: { requestId, rate: 500, scenario: undefined },
      error: undefined,
    });
  });

  it('drops config and stream-error of an older session and forgets requests on start()', () => {
    const { store, send, hello } = setup();
    hello();
    store.configure({ rate: 700 });

    store.start();
    expect(store.getSnapshot().settings).toEqual({ pending: undefined, error: undefined });
    hello(2);
    nextFrame();
    const { status } = store.getSnapshot();

    send({ type: 'config', session: 1, requestId: 'cfg-1', rate: 700, scenario: 'steady' });
    send({ type: 'stream-error', session: 1, code: 'unsupported', message: 'late' });
    nextFrame();

    expect(store.getSnapshot().status).toBe(status);
    expect(store.getSnapshot().settings).toEqual({ pending: undefined, error: undefined });
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

  describe('pause', () => {
    /** A connected store that has received `count` events (seq 1…count) in one frame. */
    function setupWithEvents(capacity: number, count: number) {
      const harness = setup(capacity);
      const encode = createSource(capacity);
      let nextSeq = 1;
      /** The worker posts `n` more events. */
      const receive = (n: number): void => {
        harness.send({
          type: 'batch',
          session: 1,
          columns: encode(seqs(nextSeq, n)),
          counters: counters({ received: nextSeq + n - 1 }),
        });
        nextSeq += n;
      };
      harness.hello();
      receive(count);
      nextFrame();
      return { ...harness, receive };
    }

    it('freezes the view at the published range and publishes at once', () => {
      const { store, listener, receive } = setupWithEvents(1000, 100);
      // A batch after the last frame: in the replica, not yet on screen.
      receive(10);
      listener.mockClear();

      store.pause();

      expect(listener).toHaveBeenCalledOnce();
      expect(store.getSnapshot()).toMatchObject({ paused: { start: 0, end: 100 }, end: 110 });
    });

    it('keeps receiving while paused: end grows, the pause point stays', () => {
      const { store, receive } = setupWithEvents(1000, 100);
      store.pause();

      receive(50);
      nextFrame();
      receive(50);
      nextFrame();

      const snapshot = store.getSnapshot();
      expect(snapshot).toMatchObject({
        start: 0,
        end: 200,
        paused: { start: 0, end: 100 },
        counters: { received: 200 },
      });
      expect(snapshot.buffer.messageAt(199)).toBe('event 200');
    });

    it('keeps evicting at the capacity while paused', () => {
      const { store, receive } = setupWithEvents(1000, 1000);
      store.pause();

      receive(300);
      nextFrame();

      const { start, end, buffer, paused } = store.getSnapshot();
      expect([start, end, buffer.size]).toEqual([300, 1300, 1000]);
      expect(paused).toEqual({ start: 0, end: 1000 });
    });

    it('ignores a second pause, so the pause point stays where the user paused', () => {
      const { store, listener, receive } = setupWithEvents(1000, 100);
      store.pause();
      receive(50);
      nextFrame();
      listener.mockClear();

      store.pause();

      expect(listener).not.toHaveBeenCalled();
      expect(store.getSnapshot().paused).toEqual({ start: 0, end: 100 });
    });

    it('clears the pause on resume and publishes at once', () => {
      const { store, listener, receive } = setupWithEvents(1000, 100);
      store.pause();
      receive(50);
      nextFrame();
      listener.mockClear();

      store.resume();

      expect(listener).toHaveBeenCalledOnce();
      expect(store.getSnapshot()).toMatchObject({ paused: undefined, end: 150 });

      store.resume();
      expect(listener).toHaveBeenCalledOnce();
    });

    it('clears the pause when a new session starts', () => {
      const { store } = setupWithEvents(1000, 100);
      store.pause();

      store.start();

      expect(store.getSnapshot()).toMatchObject({ paused: undefined, start: 0, end: 0 });
    });

    it('clears the pause when the store restarts the session on its own', () => {
      const { store, send } = setupWithEvents(1000, 100);
      store.pause();

      // A batch that does not continue the replica: the store restarts with a new session.
      send({ type: 'batch', session: 1, columns: createSource()([1]), counters: counters() });
      nextFrame();

      expect(store.getSnapshot()).toMatchObject({
        status: { phase: 'connecting' },
        paused: undefined,
      });
    });

    it('pauses an empty view right after an automatic restart, before the next frame', () => {
      const { store, send } = setupWithEvents(1000, 100);
      send({ type: 'batch', session: 1, columns: createSource()([1]), counters: counters() });

      // The snapshot still shows the old session's 100 rows; the new replica is empty.
      store.pause();

      expect(store.getSnapshot()).toMatchObject({ paused: { start: 0, end: 0 }, end: 0 });
    });
  });
});
