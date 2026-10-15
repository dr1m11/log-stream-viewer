import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { StreamSocketHandlers } from '@/shared/api';
import { testBatch, testHeartbeat, testHello } from '@/shared/lib/testing';

import { createStreamStore, PREVIEW_INTERVAL_MS } from './stream-store';

interface FakeConnection {
  readonly handlers: StreamSocketHandlers;
  readonly close: Mock<() => void>;
}

function setup() {
  const connections: FakeConnection[] = [];
  const store = createStreamStore((handlers) => {
    const close = vi.fn<() => void>();
    connections.push({ handlers, close });
    return { url: 'ws://localhost:8787/ws?v=1', invalidFrames: 0, close };
  });
  const listener = vi.fn<() => void>();
  store.subscribe(listener);
  store.start();
  /** The handlers of the newest connection: what the socket would call. */
  const server = (): StreamSocketHandlers => {
    const connection = connections.at(-1);
    if (connection === undefined) throw new Error('The store has not connected');
    return connection.handlers;
  };
  return { store, listener, connections, server };
}

/** Lets one animation frame pass (the fake clock runs requestAnimationFrame every 16 ms). */
function nextFrame(): void {
  vi.advanceTimersByTime(16);
}

/** `count` consecutive `seq` numbers starting at `first`. */
function seqs(first: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => first + index);
}

describe('createStreamStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Start on a whole second so the 100 ms rate buckets line up with the test's steps.
    vi.advanceTimersByTime(1000 - (performance.now() % 1000));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('goes from connecting to connected with the stream settings, then to closed with the code', () => {
    const { store, server } = setup();
    expect(store.getSnapshot().status).toEqual({ phase: 'connecting' });

    server().onHello?.(testHello({ rate: 500, scenario: 'error-burst', seed: 7 }));
    nextFrame();
    expect(store.getSnapshot().status).toEqual({
      phase: 'connected',
      stream: { rate: 500, scenario: 'error-burst', seed: 7 },
    });

    server().onClose?.(4000, 'session expired');
    nextFrame();
    expect(store.getSnapshot().status).toEqual({
      phase: 'closed',
      code: 4000,
      reason: 'session expired',
      wasConnected: true,
    });
  });

  it('remembers that a connection closed before the stream started', () => {
    const { store, server } = setup();

    server().onClose?.(1006, '');
    nextFrame();

    expect(store.getSnapshot().status).toMatchObject({ code: 1006, wasConnected: false });
  });

  it('publishes at most once per animation frame, however many batches arrive', () => {
    const { store, listener, server } = setup();
    server().onHello?.(testHello());
    for (let batch = 0; batch < 5; batch++) server().onBatch?.(testBatch(seqs(batch * 10 + 1, 10)));
    expect(listener).not.toHaveBeenCalled();

    nextFrame();
    expect(listener).toHaveBeenCalledOnce();
    expect(store.getSnapshot().received).toBe(50);

    nextFrame();
    expect(listener).toHaveBeenCalledOnce();
  });

  it('counts the events lost in gaps of seq', () => {
    const { store, server } = setup();
    server().onHello?.(testHello());

    server().onBatch?.(testBatch([1, 2, 3]));
    server().onBatch?.(testBatch([6, 7]));
    server().onBatch?.(testBatch([8]));
    server().onBatch?.(testBatch([10, 12]));
    nextFrame();

    expect(store.getSnapshot()).toMatchObject({ received: 8, missed: 4 });
  });

  it('counts the events missing before the first batch of a stream', () => {
    const { store, server } = setup();
    server().onHello?.(testHello());

    server().onBatch?.(testBatch([5, 6]));
    nextFrame();

    expect(store.getSnapshot()).toMatchObject({ received: 2, missed: 4 });
  });

  it('counts invalid frames', () => {
    const { store, server } = setup();

    server().onInvalidFrame?.({ kind: 'invalid-json', message: 'Unexpected end of JSON input' });
    server().onInvalidFrame?.({ kind: 'invalid-message', message: 'batch.sentAt must be …' });
    nextFrame();

    expect(store.getSnapshot().invalidFrames).toBe(2);
  });

  it('reports the events received during the last second', () => {
    const { store, server } = setup();
    server().onHello?.(testHello());

    // 200 events per second: a batch of 10 every 50 ms for two seconds.
    for (let tick = 0; tick < 40; tick++) {
      server().onBatch?.(testBatch(seqs(tick * 10 + 1, 10)));
      vi.advanceTimersByTime(50);
    }
    server().onHeartbeat?.(testHeartbeat());
    nextFrame();
    const { eventsPerSecond } = store.getSnapshot();
    expect(eventsPerSecond).toBeGreaterThanOrEqual(180);
    expect(eventsPerSecond).toBeLessThanOrEqual(220);

    // No batches for over a second: heartbeats bring the rate down to zero.
    vi.advanceTimersByTime(1100);
    server().onHeartbeat?.(testHeartbeat());
    nextFrame();
    expect(store.getSnapshot().eventsPerSecond).toBe(0);
  });

  it('reports no events per second once the connection has closed', () => {
    const { store, server } = setup();
    server().onHello?.(testHello());
    server().onBatch?.(testBatch(seqs(1, 50)));
    nextFrame();
    expect(store.getSnapshot().eventsPerSecond).toBeGreaterThan(0);

    server().onClose?.(1001, 'server shutting down');
    nextFrame();

    expect(store.getSnapshot()).toMatchObject({ eventsPerSecond: 0, received: 50 });
  });

  it('refreshes the latest-event preview at most every 250 ms, and catches up afterwards', () => {
    const { store, server } = setup();
    server().onHello?.(testHello());

    server().onBatch?.(testBatch([1, 2]));
    nextFrame();
    expect(store.getSnapshot().latest?.seq).toBe(2);

    vi.advanceTimersByTime(50);
    server().onBatch?.(testBatch([3, 4]));
    nextFrame();
    expect(store.getSnapshot()).toMatchObject({ received: 4, latest: { seq: 2 } });

    // No further batches: the preview still shows the newest event once the interval is over.
    vi.advanceTimersByTime(PREVIEW_INTERVAL_MS);
    expect(store.getSnapshot().latest?.seq).toBe(4);
  });

  it('stops publishing and closes the socket on stop()', () => {
    const { store, listener, connections, server } = setup();
    server().onHello?.(testHello());
    server().onBatch?.(testBatch([1, 2]));

    store.stop();
    vi.advanceTimersByTime(1000);

    expect(listener).not.toHaveBeenCalled();
    expect(connections[0]?.close).toHaveBeenCalledOnce();
  });

  it('starts over with a new connection and fresh counters on start()', () => {
    const { store, listener, connections, server } = setup();
    server().onHello?.(testHello());
    server().onBatch?.(testBatch([1, 2, 3]));
    nextFrame();
    listener.mockClear();

    store.start();

    expect(connections).toHaveLength(2);
    expect(connections[0]?.close).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toMatchObject({
      status: { phase: 'connecting' },
      received: 0,
      latest: undefined,
    });
  });
});
