import {
  BATCH_INTERVAL_MS,
  CLIENT_MESSAGE_BURST,
  CLOSE_CODES,
  type ConfigMessage,
  type ConfigureMessage,
  HEARTBEAT_INTERVAL_MS,
  type KnownErrorCode,
  MAX_CLIENT_MESSAGES_PER_SECOND,
  parseClientMessage,
  PROTOCOL_VERSION,
  type ServerMessage,
  type StreamLimits,
  type StreamSettings,
} from '@lsv/protocol';

import { createGenerator, type LogGenerator } from './generator/generator.ts';
import { TokenBucket } from './rate-limit.ts';
import {
  CATCH_UP_TICKS,
  createScheduler,
  eventsDue,
  type SchedulerState,
  withRate,
} from './scheduler.ts';

/** The server pings every client this often and terminates one that did not answer the previous ping. */
export const PING_INTERVAL_MS = 15_000;

/** Rough size of one serialized event, used to turn rates into buffer sizes. */
export const EVENT_BYTES_ESTIMATE = 300;
/** Bounds of the soft backpressure threshold (about one second of the session's stream). */
export const MIN_SOFT_BUFFER_BYTES = 64 * 1024;
export const MAX_SOFT_BUFFER_BYTES = 1024 * 1024;
/** Hard cap on a session's send buffer: above it the socket is terminated. */
export const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

/**
 * Soft backpressure threshold for a stream at `rate` events/s: about one second of its own
 * stream, within {@link MIN_SOFT_BUFFER_BYTES}…{@link MAX_SOFT_BUFFER_BYTES}. Above it the session
 * stops generating (and answering client frames) until the buffer drains below half of it.
 */
export function softBufferLimit(rate: number): number {
  return Math.min(
    MAX_SOFT_BUFFER_BYTES,
    Math.max(MIN_SOFT_BUFFER_BYTES, rate * EVENT_BYTES_ESTIMATE),
  );
}

/**
 * Hard cap for a deployment whose streams go up to `maxRate`: {@link MAX_BUFFERED_BYTES}, or more
 * when the largest batch (a catch-up tick at `maxRate`) on top of the largest soft threshold
 * would not fit under it.
 */
export function hardBufferLimit(maxRate: number): number {
  const largestBatch = (maxRate * BATCH_INTERVAL_MS * CATCH_UP_TICKS * EVENT_BYTES_ESTIMATE) / 1000;
  return Math.max(MAX_BUFFERED_BYTES, MAX_SOFT_BUFFER_BYTES + largestBatch);
}

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

/** Why a session ended on the server's initiative (for the close log line). */
export type EndReason =
  'expired' | 'liveness' | 'buffer-overflow' | 'message-rate' | 'shutdown' | 'error';

/** Clamps a requested rate to `[limits.minRate, limits.maxRate]`. */
export function clampRate(rate: number, limits: StreamLimits): number {
  return Math.min(limits.maxRate, Math.max(limits.minRate, rate));
}

/**
 * One client's stream: protocol v1 on top of a socket. It owns no timers — the server calls
 * {@link Session.due} and {@link Session.flush} on every tick with the current time, so tests drive
 * it with a fake clock.
 *
 * Memory is bounded per session: above a soft threshold of its send buffer the session generates
 * nothing (the `seq` numbers it would have sent become a gap, reported as `batch.dropped`) and
 * does not answer client frames; above the hard cap it terminates the socket. Client frames are
 * rate-limited and a flood closes the socket with 1008.
 */
export class Session {
  readonly streamId: string;
  readonly seed: number;
  readonly startedAt: number;
  readonly expiresAt: number;
  readonly #socket: SessionSocket;
  readonly #limits: StreamLimits;
  readonly #generator: LogGenerator;
  readonly #inbound: TokenBucket;
  readonly #hardLimit: number;
  #rate: number;
  #scheduler: SchedulerState;
  #softLimit: number;
  #backpressured = false;
  #nextHeartbeatAt: number;
  #nextPingAt: number;
  #awaitingPong = false;
  /** Events dropped since the last batch. */
  #pendingDropped = 0;
  #sentEvents = 0;
  #droppedEvents = 0;
  #ignoredFrames = 0;
  #closed = false;
  #endReason: EndReason | undefined;

  constructor(options: SessionOptions) {
    const { settings, now, limits } = options;
    this.streamId = options.streamId;
    this.seed = settings.seed;
    this.startedAt = now;
    this.expiresAt = now + limits.sessionMaxMs;
    this.#socket = options.socket;
    this.#limits = limits;
    this.#rate = settings.rate;
    this.#generator = createGenerator({
      seed: settings.seed,
      scenario: settings.scenario,
      startedAt: now,
    });
    this.#inbound = new TokenBucket(MAX_CLIENT_MESSAGES_PER_SECOND, CLIENT_MESSAGE_BURST, now);
    this.#hardLimit = hardBufferLimit(limits.maxRate);
    this.#scheduler = createScheduler(settings.rate, now);
    this.#softLimit = softBufferLimit(settings.rate);
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

  /** Client frames left unanswered because the send buffer was backed up. */
  get ignoredFrames(): number {
    return this.#ignoredFrames;
  }

  /** `true` once the session has closed or terminated its socket; it sends nothing afterwards. */
  get closed(): boolean {
    return this.#closed;
  }

  /** Why the server ended the session, if it did. */
  get endReason(): EndReason | undefined {
    return this.#endReason;
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
   * First half of a tick: how many events the stream wants at `now` (its share of the global
   * budget comes back in {@link Session.flush}). Closes an expired session and terminates one whose
   * send buffer exceeds the hard cap.
   */
  due(now: number): number {
    if (this.#closed) return 0;
    if (now >= this.expiresAt) {
      this.#end('expired');
      this.close(CLOSE_CODES.sessionExpired, 'session expired');
      return 0;
    }
    const buffered = this.#socket.bufferedAmount;
    if (buffered > this.#hardLimit) {
      this.#kill('buffer-overflow');
      return 0;
    }
    // A traffic spike multiplies the rate, but never above the deployment's ceiling.
    const multiplier = this.#generator.rateMultiplier(now);
    const rate = Math.min(this.#limits.maxRate, this.#rate * multiplier);
    const { count, state } = eventsDue(withRate(this.#scheduler, rate), now);
    this.#scheduler = state;
    this.#softLimit = softBufferLimit(rate);
    // Hysteresis: stop above the soft threshold, resume once the buffer drained below half of it.
    if (this.#backpressured) this.#backpressured = buffered >= this.#softLimit / 2;
    else this.#backpressured = buffered > this.#softLimit;
    return count;
  }

  /**
   * Second half of a tick: sends a batch of the `granted` events (the global budget may grant
   * fewer than were due) — or, under backpressure, skips exactly those events and reports them as
   * dropped later — then the heartbeat when one is due, and pings the client. Returns the number
   * of events sent.
   */
  flush(now: number, granted: number): number {
    if (this.#closed) return 0;
    if (now >= this.#nextPingAt && !this.#ping(now)) return 0;

    let sent = 0;
    if (granted > 0 && this.#backpressured) {
      this.#generator.skip(granted, now);
      this.#pendingDropped += granted;
      this.#droppedEvents += granted;
    } else if (granted > 0) {
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
    if (!this.#admit(now)) return;
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
  receiveBinary(now: number): void {
    if (!this.#admit(now)) return;
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
    if (code === CLOSE_CODES.goingAway) this.#end('shutdown');
    this.#socket.close(code, reason);
  }

  /** Destroys the socket without a closing handshake (the session failed). */
  terminate(): void {
    this.#kill('error');
  }

  /**
   * Rate-limits client frames (a flood closes the socket with 1008) and leaves them unanswered
   * while the send buffer is backed up: a client that does not read must not grow server memory
   * by provoking replies.
   */
  #admit(now: number): boolean {
    if (this.#closed) return false;
    if (!this.#inbound.take(now)) {
      this.#end('message-rate');
      this.close(CLOSE_CODES.policyViolation, 'too many messages');
      return false;
    }
    if (this.#socket.bufferedAmount > this.#softLimit) {
      this.#ignoredFrames++;
      return false;
    }
    return true;
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
      this.#kill('liveness');
      return false;
    }
    this.#awaitingPong = true;
    this.#nextPingAt = now + PING_INTERVAL_MS;
    this.#socket.ping();
    return true;
  }

  #end(reason: EndReason): void {
    this.#endReason ??= reason;
  }

  #kill(reason: EndReason): void {
    if (this.#closed) return;
    this.#end(reason);
    this.#closed = true;
    this.#socket.terminate();
  }

  #sendError(code: KnownErrorCode, message: string): void {
    this.#send({ type: 'error', code, message });
  }

  /** Sends a message; terminates the socket when its buffer grows past the hard cap. */
  #send(message: ServerMessage): void {
    if (this.#closed) return;
    this.#socket.send(JSON.stringify(message));
    if (this.#socket.bufferedAmount > this.#hardLimit) this.#kill('buffer-overflow');
  }
}
