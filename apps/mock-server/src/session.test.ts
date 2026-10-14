import { readFileSync } from 'node:fs';

import {
  BATCH_INTERVAL_MS,
  CLOSE_CODES,
  MIN_RATE,
  parseServerMessage,
  type ServerMessage,
  type StreamLimits,
  type StreamSettings,
} from '@lsv/protocol';
import { describe, expect, it } from 'vitest';

import { TRAFFIC_SPIKE } from './generator/scenarios.ts';
import {
  BACKPRESSURE_BYTES,
  clampRate,
  PING_INTERVAL_MS,
  Session,
  type SessionSocket,
} from './session.ts';

const FIXTURES = new URL('../../../packages/protocol/fixtures/v1/', import.meta.url);
const fixture = (name: string): string => readFileSync(new URL(name, FIXTURES), 'utf8');

type MessageOf<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

/** Records what the session sends; every frame must pass the protocol parser. */
class FakeSocket implements SessionSocket {
  bufferedAmount = 0;
  readonly messages: ServerMessage[] = [];
  pings = 0;
  closes: { code: number; reason: string }[] = [];
  terminated = false;
  /** Answers pings like a live client; `undefined` simulates a dead one. */
  onPing: (() => void) | undefined;

  send(data: string): void {
    const parsed = parseServerMessage(data);
    if (!parsed.ok) throw new Error(`Invalid server message: ${parsed.error.message}`);
    this.messages.push(parsed.value);
  }

  ping(): void {
    this.pings++;
    this.onPing?.();
  }

  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }

  terminate(): void {
    this.terminated = true;
  }

  ofType<T extends ServerMessage['type']>(type: T): MessageOf<T>[] {
    return this.messages.filter((message): message is MessageOf<T> => message.type === type);
  }

  events(): number[] {
    return this.ofType('batch').flatMap((batch) => batch.events.map((event) => event.seq));
  }
}

const T0 = 1_791_979_200_000;
const LIMITS: StreamLimits = { minRate: MIN_RATE, maxRate: 20_000, sessionMaxMs: 60_000 };

function open(settings: Partial<StreamSettings> = {}) {
  const socket = new FakeSocket();
  const session = new Session({
    socket,
    streamId: 'st_test',
    settings: { rate: 200, scenario: 'steady', seed: 42, ...settings },
    limits: LIMITS,
    now: T0,
  });
  socket.onPing = () => {
    session.pong();
  };
  session.start();
  return { socket, session };
}

/** Ticks every 50 ms in `(from, to]`, granting what `grant` allows of the due events. */
function run(
  session: Session,
  from: number,
  to: number,
  grant: (due: number) => number = (due) => due,
): void {
  for (let now = from + BATCH_INTERVAL_MS; now <= to; now += BATCH_INTERVAL_MS) {
    session.flush(now, grant(session.due(now)));
  }
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

describe('Session', () => {
  it('opens the stream with hello', () => {
    const { socket } = open();
    expect(socket.messages).toEqual([
      {
        type: 'hello',
        protocolVersion: 1,
        streamId: 'st_test',
        resumed: false,
        serverTime: T0,
        stream: { rate: 200, scenario: 'steady', seed: 42 },
        limits: LIMITS,
        expiresAt: T0 + LIMITS.sessionMaxMs,
      },
    ]);
  });

  it('sends one batch per tick with consecutive seq at the requested rate', () => {
    const { socket, session } = open();
    run(session, T0, T0 + 1000);
    const batches = socket.ofType('batch');
    expect(batches).toHaveLength(20);
    expect(batches.map((batch) => batch.sentAt)).toEqual(
      range(1, 20).map((tick) => T0 + tick * BATCH_INTERVAL_MS),
    );
    expect(socket.events()).toEqual(range(1, 200));
    for (const batch of batches) {
      expect(batch.dropped).toBeUndefined();
      for (const event of batch.events) expect(event.ts).toBeLessThanOrEqual(batch.sentAt);
    }
    expect(session.sentEvents).toBe(200);
  });

  it('skips ticks without events', () => {
    const { socket, session } = open({ rate: 10 });
    run(session, T0, T0 + 1000);
    const batches = socket.ofType('batch');
    expect(batches).toHaveLength(10);
    expect(batches.every((batch) => batch.events.length === 1)).toBe(true);
  });

  it('sends a heartbeat every second with the last assigned seq', () => {
    const { socket, session } = open();
    run(session, T0, T0 + 3000);
    expect(socket.ofType('heartbeat')).toEqual([
      { type: 'heartbeat', serverTime: T0 + 1000, lastSeq: 200 },
      { type: 'heartbeat', serverTime: T0 + 2000, lastSeq: 400 },
      { type: 'heartbeat', serverTime: T0 + 3000, lastSeq: 600 },
    ]);
  });

  it('sends a single heartbeat after a stall and keeps the cadence afterwards', () => {
    const { socket, session } = open();
    session.flush(T0 + 10_000, session.due(T0 + 10_000));
    run(session, T0 + 10_000, T0 + 11_000);
    expect(socket.ofType('heartbeat').map((beat) => beat.serverTime)).toEqual([
      T0 + 10_000,
      T0 + 11_000,
    ]);
  });

  it('sends fewer events when the budget grants fewer, without a gap', () => {
    const { socket, session } = open();
    run(session, T0, T0 + 1000, (due) => Math.min(due, 3));
    expect(socket.events()).toEqual(range(1, 60));
    expect(socket.ofType('batch').some((batch) => batch.dropped !== undefined)).toBe(false);
  });

  it('skips events under backpressure and reports them as dropped', () => {
    const { socket, session } = open();
    run(session, T0, T0 + 500);
    socket.bufferedAmount = BACKPRESSURE_BYTES + 1;
    run(session, T0 + 500, T0 + 1000);
    expect(socket.ofType('batch')).toHaveLength(10);
    expect(socket.ofType('heartbeat')).toEqual([
      { type: 'heartbeat', serverTime: T0 + 1000, lastSeq: 200 },
    ]);

    socket.bufferedAmount = 0;
    run(session, T0 + 1000, T0 + 1050);
    const last = socket.ofType('batch').at(-1);
    expect(last?.dropped).toBe(100);
    expect(last?.events.map((event) => event.seq)).toEqual(range(201, 210));
    expect(socket.events()).toEqual([...range(1, 100), ...range(201, 210)]);
    expect(session.droppedEvents).toBe(100);

    run(session, T0 + 1050, T0 + 1100);
    expect(socket.ofType('batch').at(-1)?.dropped).toBeUndefined();
  });

  it('answers configure with the clamped settings (golden fixtures)', () => {
    const { socket, session } = open();
    session.receive(fixture('configure.json'), T0 + 10);
    expect(socket.messages.at(-1)).toEqual(JSON.parse(fixture('config.json')));
    expect(session.settings).toEqual({ rate: 20_000, scenario: 'error-burst', seed: 42 });
  });

  it('applies a new rate from the next tick and clamps it to the minimum', () => {
    const { socket, session } = open();
    session.receive(JSON.stringify({ type: 'configure', rate: 1000 }), T0);
    run(session, T0, T0 + 1000);
    expect(socket.events()).toHaveLength(1000);
    session.receive(JSON.stringify({ type: 'configure', rate: 1 }), T0 + 1000);
    expect(socket.messages.at(-1)).toEqual({ type: 'config', rate: MIN_RATE, scenario: 'steady' });
  });

  it('keeps the rate when configure only changes the scenario', () => {
    const { socket, session } = open({ rate: 300 });
    session.receive(
      JSON.stringify({ type: 'configure', requestId: 'r1', scenario: 'traffic-spike' }),
      T0,
    );
    expect(socket.messages.at(-1)).toEqual({
      type: 'config',
      requestId: 'r1',
      rate: 300,
      scenario: 'traffic-spike',
    });
  });

  it('multiplies the rate during a traffic spike', () => {
    const { socket, session } = open({ scenario: 'traffic-spike' });
    // A tick counts the interval that ends at its time with the rate at that time.
    const beforeSpike = T0 + TRAFFIC_SPIKE.startMs - BATCH_INTERVAL_MS;
    run(session, T0, beforeSpike);
    expect(socket.events()).toHaveLength(990);
    run(session, beforeSpike, beforeSpike + 1000);
    expect(socket.events()).toHaveLength(990 + 200 * TRAFFIC_SPIKE.rateMultiplier);
  });

  it('answers an unknown message type with error unsupported (golden fixtures)', () => {
    const { socket, session } = open();
    session.receive(fixture('invalid-unknown-type.json'), T0);
    expect(socket.messages.at(-1)).toEqual(JSON.parse(fixture('error.json')));
    expect(socket.closes).toEqual([]);
  });

  it.each([
    ['not JSON', '{"type":'],
    ['not an object', '[1,2]'],
    ['an invalid configure', fixture('invalid-configure-rate-string.json')],
  ])('answers %s with error bad-message and keeps streaming', (_, raw) => {
    const { socket, session } = open();
    session.receive(raw, T0);
    expect(socket.messages.at(-1)).toMatchObject({ type: 'error', code: 'bad-message' });
    run(session, T0, T0 + 100);
    expect(socket.events()).toEqual(range(1, 20));
  });

  it('treats a binary frame like a malformed message', () => {
    const { socket, session } = open();
    session.receiveBinary();
    expect(socket.messages.at(-1)).toMatchObject({ type: 'error', code: 'bad-message' });
    expect(socket.closes).toEqual([]);
  });

  it('pings every 15 s and terminates a client that did not answer', () => {
    const { socket, session } = open({ rate: 10 });
    socket.onPing = undefined;
    run(session, T0, T0 + PING_INTERVAL_MS);
    expect(socket.pings).toBe(1);
    session.pong();
    run(session, T0 + PING_INTERVAL_MS, T0 + 2 * PING_INTERVAL_MS);
    expect(socket.pings).toBe(2);
    expect(socket.terminated).toBe(false);

    run(session, T0 + 2 * PING_INTERVAL_MS, T0 + 3 * PING_INTERVAL_MS);
    expect(socket.terminated).toBe(true);
    expect(session.closed).toBe(true);
    const sent = socket.messages.length;
    run(session, T0 + 3 * PING_INTERVAL_MS, T0 + 3 * PING_INTERVAL_MS + 1000);
    expect(socket.messages).toHaveLength(sent);
  });

  it('closes with 4000 when the session expires and goes quiet', () => {
    const { socket, session } = open();
    run(session, T0, T0 + LIMITS.sessionMaxMs - BATCH_INTERVAL_MS, () => 0);
    expect(socket.closes).toEqual([]);
    expect(session.due(T0 + LIMITS.sessionMaxMs)).toBe(0);
    expect(socket.closes).toEqual([
      { code: CLOSE_CODES.sessionExpired, reason: 'session expired' },
    ]);
    expect(session.closed).toBe(true);

    const sent = socket.messages.length;
    expect(session.flush(T0 + LIMITS.sessionMaxMs, 10)).toBe(0);
    session.receive(fixture('configure.json'), T0 + LIMITS.sessionMaxMs);
    session.receiveBinary();
    expect(socket.messages).toHaveLength(sent);
  });

  it('closes its socket only once', () => {
    const { socket, session } = open();
    session.close(CLOSE_CODES.goingAway, 'server shutting down');
    session.close(CLOSE_CODES.normal, 'again');
    expect(socket.closes).toEqual([{ code: 1001, reason: 'server shutting down' }]);
  });
});

describe('clampRate', () => {
  it('keeps a rate inside the limits', () => {
    expect(clampRate(0, LIMITS)).toBe(MIN_RATE);
    expect(clampRate(500, LIMITS)).toBe(500);
    expect(clampRate(1_000_000, LIMITS)).toBe(LIMITS.maxRate);
  });
});
