import {
  CLOSE_CODES,
  type ConfigMessage,
  type ConfigureMessage,
  type ErrorCode,
  HEARTBEAT_INTERVAL_MS,
  parseClientMessage,
  PROTOCOL_VERSION,
  type ServerMessage,
  type StreamLimits,
  type StreamSettings,
} from '@lsv/protocol';

import { createGenerator, type LogGenerator } from './generator/generator.ts';
import { createScheduler, eventsDue, type SchedulerState, withRate } from './scheduler.ts';

/** The server pings every client this often and terminates one that did not answer the previous ping. */
export const PING_INTERVAL_MS = 15_000;

/**
 * While more than this many bytes wait in the socket's send buffer, the session skips generation:
 * the `seq` numbers are still assigned (the client sees a gap) and reported as `batch.dropped`.
 */
export const BACKPRESSURE_BYTES = 4 * 1024 * 1024;

/** The part of a `ws` WebSocket a session uses; tests pass a fake. */
export interface SessionSocket {
  /** Bytes queued for sending and not yet handed to the OS. */
  readonly bufferedAmount: number;
  send(data: string): void;
  ping(): void;
  close(code: number, reason: string): void;
  terminate(): void;
}

export interface SessionOptions {
  readonly socket: SessionSocket;
  readonly streamId: string;
  /** Effective settings, already clamped with {@link clampRate}. */
  readonly settings: StreamSettings;
  readonly limits: StreamLimits;
  /** Connection time, epoch ms. */
  readonly now: number;
}

/** Clamps a requested rate to `[limits.minRate, limits.maxRate]`. */
export function clampRate(rate: number, limits: StreamLimits): number {
  return Math.min(limits.maxRate, Math.max(limits.minRate, rate));
}

/**
 * One client's stream: protocol v1 on top of a socket. It owns no timers — the server calls
 * {@link Session.due} and {@link Session.flush} on every tick with the current time, so tests drive
 * it with a fake clock.
 */
export class Session {
  readonly streamId: string;
  readonly seed: number;
  readonly startedAt: number;
  readonly expiresAt: number;
  readonly #socket: SessionSocket;
  readonly #limits: StreamLimits;
  readonly #generator: LogGenerator;
  #rate: number;
  #scheduler: SchedulerState;
  #nextHeartbeatAt: number;
  #nextPingAt: number;
  #awaitingPong = false;
  /** Events dropped since the last batch. */
  #pendingDropped = 0;
  #sentEvents = 0;
  #droppedEvents = 0;
  #closed = false;

  constructor(options: SessionOptions) {
    const { settings, now } = options;
    this.streamId = options.streamId;
    this.seed = settings.seed;
    this.startedAt = now;
    this.expiresAt = now + options.limits.sessionMaxMs;
    this.#socket = options.socket;
    this.#limits = options.limits;
    this.#rate = settings.rate;
    this.#generator = createGenerator({
      seed: settings.seed,
      scenario: settings.scenario,
      startedAt: now,
    });
    this.#scheduler = createScheduler(settings.rate, now);
    this.#nextHeartbeatAt = now + HEARTBEAT_INTERVAL_MS;
    this.#nextPingAt = now + PING_INTERVAL_MS;
  }

  /** Current settings (`configure` may change rate and scenario). */
  get settings(): StreamSettings {
    return { rate: this.#rate, scenario: this.#generator.scenario, seed: this.seed };
  }

  /** Events sent to the client so far. */
  get sentEvents(): number {
    return this.#sentEvents;
  }

  /** Events skipped because of backpressure so far. */
  get droppedEvents(): number {
    return this.#droppedEvents;
  }

  /** `true` once the session has closed or terminated its socket; it sends nothing afterwards. */
  get closed(): boolean {
    return this.#closed;
  }

  /** Sends `hello`, the first message of the stream. */
  start(): void {
    this.#send({
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      streamId: this.streamId,
      resumed: false,
      serverTime: this.startedAt,
      stream: this.settings,
      limits: this.#limits,
      expiresAt: this.expiresAt,
    });
  }

  /**
   * First half of a tick: how many events the stream wants at `now`. Closes an expired session.
   * Under backpressure the due events are skipped here (and reported later), so the session asks
   * for nothing.
   */
  due(now: number): number {
    if (this.#closed) return 0;
    if (now >= this.expiresAt) {
      this.close(CLOSE_CODES.sessionExpired, 'session expired');
      return 0;
    }
    const rate = this.#rate * this.#generator.rateMultiplier(now);
    const { count, state } = eventsDue(withRate(this.#scheduler, rate), now);
    this.#scheduler = state;
    if (count > 0 && this.#socket.bufferedAmount > BACKPRESSURE_BYTES) {
      this.#generator.skip(count, now);
      this.#pendingDropped += count;
      this.#droppedEvents += count;
      return 0;
    }
    return count;
  }

  /**
   * Second half of a tick: sends a batch of `granted` events (the global budget may grant fewer
   * than were due), the heartbeat when one is due, and pings the client. Returns the number of
   * events sent.
   */
  flush(now: number, granted: number): number {
    if (this.#closed) return 0;
    if (now >= this.#nextPingAt && !this.#ping(now)) return 0;

    let sent = 0;
    if (granted > 0) {
      const events = this.#generator.next(granted, now);
      const dropped = this.#pendingDropped;
      this.#send(
        dropped > 0
          ? { type: 'batch', sentAt: now, events, dropped }
          : { type: 'batch', sentAt: now, events },
      );
      this.#pendingDropped = 0;
      this.#sentEvents += events.length;
      sent = events.length;
    }

    if (now >= this.#nextHeartbeatAt) {
      this.#send({ type: 'heartbeat', serverTime: now, lastSeq: this.#generator.lastSeq });
      this.#nextHeartbeatAt += HEARTBEAT_INTERVAL_MS;
      // After a long stall send one heartbeat, not a burst of them.
      if (this.#nextHeartbeatAt <= now) this.#nextHeartbeatAt = now + HEARTBEAT_INTERVAL_MS;
    }
    return sent;
  }

  /** Handles a text frame from the client. */
  receive(text: string, now: number): void {
    if (this.#closed) return;
    const parsed = parseClientMessage(text);
    if (!parsed.ok) {
      const { error } = parsed;
      this.#sendError(error.kind === 'unknown-type' ? 'unsupported' : 'bad-message', error.message);
      return;
    }
    // `configure` is the only client message of v1; a new one fails to compile here until handled.
    this.#configure(parsed.value, now);
  }

  /** Handles a binary frame: not part of protocol v1, so it is treated like a malformed message. */
  receiveBinary(): void {
    if (this.#closed) return;
    this.#sendError('bad-message', 'Binary frames are not supported; send JSON text frames');
  }

  /** The client answered a ping. */
  pong(): void {
    this.#awaitingPong = false;
  }

  /** Closes the socket with a close code; the session sends nothing afterwards. */
  close(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.close(code, reason);
  }

  #configure(message: ConfigureMessage, now: number): void {
    if (message.rate !== undefined) this.#rate = clampRate(message.rate, this.#limits);
    if (message.scenario !== undefined && message.scenario !== this.#generator.scenario) {
      this.#generator.setScenario(message.scenario, now);
    }
    const scenario = this.#generator.scenario;
    const answer: ConfigMessage =
      message.requestId === undefined
        ? { type: 'config', rate: this.#rate, scenario }
        : { type: 'config', requestId: message.requestId, rate: this.#rate, scenario };
    this.#send(answer);
  }

  /** Pings the client, or terminates the socket when the previous ping went unanswered. */
  #ping(now: number): boolean {
    if (this.#awaitingPong) {
      this.#closed = true;
      this.#socket.terminate();
      return false;
    }
    this.#awaitingPong = true;
    this.#nextPingAt = now + PING_INTERVAL_MS;
    this.#socket.ping();
    return true;
  }

  #sendError(code: ErrorCode, message: string): void {
    this.#send({ type: 'error', code, message });
  }

  #send(message: ServerMessage): void {
    this.#socket.send(JSON.stringify(message));
  }
}
