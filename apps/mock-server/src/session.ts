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
/** The same after permessage-deflate (measured 55–59 bytes, docs/adr/0005). */
export const COMPRESSED_EVENT_BYTES_ESTIMATE = 60;
/** Bounds of the soft backpressure threshold on buffered bytes. */
export const MIN_SOFT_BUFFER_BYTES = 64 * 1024;
export const MAX_SOFT_BUFFER_BYTES = 1024 * 1024;
/** Hard cap on a session's send buffer: above it the socket is terminated. */
export const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
/**
 * Messages handed to the socket whose write has not completed yet. Each one holds buffers (ws
 * allocates small frame headers from Node's shared pool, so a queued message can pin far more
 * memory than its bytes), so their number is bounded as well as their bytes: about one second of
 * batches makes the session backpressured…
 */
export const SOFT_IN_FLIGHT_MESSAGES = 25;
/** …and more than this terminates the socket. */
export const MAX_IN_FLIGHT_MESSAGES = 100;
/** A socket that completes no write for this long (the client reads nothing) is terminated. */
export const STALL_TIMEOUT_MS = 10_000;

/** Weight of the latest tick in the moving average of the granted rate. */
const RATE_SMOOTHING = 0.1;

/**
 * Soft backpressure threshold for a stream that is granted `rate` events/s of `bytesPerEvent`
 * each on the wire: about one second of it, within
 * {@link MIN_SOFT_BUFFER_BYTES}…{@link MAX_SOFT_BUFFER_BYTES}. Above it the session stops
 * generating (and answering client frames) until the buffer drains below half of it.
 */
export function softBufferLimit(rate: number, bytesPerEvent = EVENT_BYTES_ESTIMATE): number {
  return Math.min(MAX_SOFT_BUFFER_BYTES, Math.max(MIN_SOFT_BUFFER_BYTES, rate * bytesPerEvent));
}

/**
 * Hard cap for a deployment whose streams go up to `maxRate`: {@link MAX_BUFFERED_BYTES}, or more
 * when the largest batch (a catch-up tick at `maxRate`, uncompressed) on top of the largest soft
 * threshold would not fit under it.
 */
export function hardBufferLimit(maxRate: number): number {
  const largestBatch = (maxRate * BATCH_INTERVAL_MS * CATCH_UP_TICKS * EVENT_BYTES_ESTIMATE) / 1000;
  return Math.max(MAX_BUFFERED_BYTES, MAX_SOFT_BUFFER_BYTES + largestBatch);
}

/** The part of a `ws` WebSocket a session uses; tests pass a fake. */
export interface SessionSocket {
  /** Bytes queued for sending and not yet handed to the OS. */
  readonly bufferedAmount: number;
  /** Queues a text frame; `sent` runs once the write completed (or failed). */
  send(data: string, sent: (error?: Error) => void): void;
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
  /**
   * Bytes one event takes in the send buffer: {@link COMPRESSED_EVENT_BYTES_ESTIMATE} when the
   * connection negotiated permessage-deflate, {@link EVENT_BYTES_ESTIMATE} (the default) otherwise.
   */
  readonly bytesPerEvent?: number;
}

/** Why a session ended on the server's initiative (for the close log line). */
export type EndReason =
  'expired' | 'liveness' | 'stalled' | 'buffer-overflow' | 'message-rate' | 'shutdown' | 'error';

/** Clamps a requested rate to `[limits.minRate, limits.maxRate]`. */
export function clampRate(rate: number, limits: StreamLimits): number {
  return Math.min(limits.maxRate, Math.max(limits.minRate, rate));
}

/**
 * One client's stream: protocol v1 on top of a socket. It owns no timers — the server calls
 * {@link Session.due} and {@link Session.flush} on every tick with the current time, so tests drive
 * it with a fake clock.
 *
 * Memory is bounded per session. While its send buffer holds more than about a second of the
 * stream (bytes or in-flight messages) the session is backpressured: it generates nothing (the
 * `seq` numbers it would have sent become a gap, reported as `batch.dropped`), asks the global
 * budget for nothing, and answers no client frame — a `configure` is still applied and answered
 * once the buffer drains. Above the hard caps, or when no write completes for
 * {@link STALL_TIMEOUT_MS}, it terminates the socket. Client frames and pings are rate-limited; a
 * flood closes the socket with 1008.
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
  readonly #bytesPerEvent: number;
  #rate: number;
  /** Moving average of the events/s the session was granted (and sent). */
  #grantedRate: number;
  #scheduler: SchedulerState;
  #softLimit: number;
  #backpressured = false;
  #inFlight = 0;
  #lastDrainAt: number;
  #lastNow: number;
  /** `config` answer held back while the session was backpressured (the latest one wins). */
  #pendingConfig: ConfigMessage | undefined;
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
    this.#grantedRate = settings.rate;
    this.#bytesPerEvent = options.bytesPerEvent ?? EVENT_BYTES_ESTIMATE;
    this.#generator = createGenerator({
      seed: settings.seed,
      scenario: settings.scenario,
      startedAt: now,
    });
    this.#inbound = new TokenBucket(MAX_CLIENT_MESSAGES_PER_SECOND, CLIENT_MESSAGE_BURST, now);
    this.#hardLimit = hardBufferLimit(limits.maxRate);
    this.#scheduler = createScheduler(settings.rate, now);
    this.#softLimit = softBufferLimit(settings.rate, this.#bytesPerEvent);
    this.#lastDrainAt = now;
    this.#lastNow = now;
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

  /**
   * Client frames that got no answer because the send buffer was backed up: malformed, binary or
   * unknown ones (a `configure` is applied and answered later, so it does not count).
   */
  get ignoredFrames(): number {
    return this.#ignoredFrames;
  }

  /** Messages handed to the socket whose write has not completed yet. */
  get inFlight(): number {
    return this.#inFlight;
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
   * First half of a tick: how many events the stream asks the global budget for at `now` (its
   * share comes back in {@link Session.flush}). A backpressured session skips its due events
   * right here and asks for nothing, so a stuck client does not take budget from healthy ones.
   * Closes an expired session and terminates a stuck one.
   */
  due(now: number): number {
    if (this.#closed) return 0;
    this.#lastNow = now;
    if (now >= this.expiresAt) {
      this.#end('expired');
      this.close(CLOSE_CODES.sessionExpired, 'session expired');
      return 0;
    }
    if (!this.#withinHardLimits()) return 0;
    if (this.#inFlight > 0 && now - this.#lastDrainAt > STALL_TIMEOUT_MS) {
      this.#kill('stalled');
      return 0;
    }
    // A traffic spike multiplies the rate, but never above the deployment's ceiling.
    const multiplier = this.#generator.rateMultiplier(now);
    const rate = Math.min(this.#limits.maxRate, this.#rate * multiplier);
    const { count, state } = eventsDue(withRate(this.#scheduler, rate), now);
    this.#scheduler = state;
    this.#updateBackpressure();
    if (!this.#backpressured) return count;
    if (count > 0) {
      this.#generator.skip(count, now);
      this.#pendingDropped += count;
      this.#droppedEvents += count;
    }
    return 0;
  }

  /**
   * Second half of a tick: sends a held-back `config`, a batch of the `granted` events (the
   * global budget may grant fewer than were due) and the heartbeat when one is due, and pings the
   * client. Returns the number of events sent.
   */
  flush(now: number, granted: number): number {
    if (this.#closed) return 0;
    this.#lastNow = now;
    if (now >= this.#nextPingAt && !this.#ping(now)) return 0;

    if (!this.#backpressured) {
      if (this.#pendingConfig !== undefined) {
        this.#send(this.#pendingConfig);
        this.#pendingConfig = undefined;
      }
      const tickRate = (granted * 1000) / BATCH_INTERVAL_MS;
      this.#grantedRate += RATE_SMOOTHING * (tickRate - this.#grantedRate);
    }

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

  /**
   * Handles a text frame from the client. A valid `configure` is always applied; while the send
   * buffer is backed up its answer waits for the buffer to drain, and other frames get none.
   */
  receive(text: string, now: number): void {
    if (!this.#charge(now)) return;
    const backedUp = this.#backedUp();
    const parsed = parseClientMessage(text);
    if (!parsed.ok) {
      if (backedUp) this.#ignoredFrames++;
      else {
        const { error } = parsed;
        const code = error.kind === 'unknown-type' ? 'unsupported' : 'bad-message';
        this.#sendError(code, error.message);
      }
      return;
    }
    // `configure` is the only client message of v1; a new one fails to compile here until handled.
    const answer = this.#configure(parsed.value, now);
    if (backedUp) this.#pendingConfig = answer;
    else this.#send(answer);
  }

  /** Handles a binary frame: not part of protocol v1, so it is treated like a malformed message. */
  receiveBinary(now: number): void {
    if (!this.#charge(now)) return;
    if (this.#backedUp()) this.#ignoredFrames++;
    else this.#sendError('bad-message', 'Binary frames are not supported; send JSON text frames');
  }

  /** The client sent a ping: not answered (no automatic pongs), but charged to the rate limit. */
  receivePing(now: number): void {
    this.#charge(now);
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

  /** Charges a client frame to the rate limit; a flood closes the socket with 1008. */
  #charge(now: number): boolean {
    if (this.#closed) return false;
    this.#lastNow = now;
    if (this.#inbound.take(now)) return true;
    this.#end('message-rate');
    this.close(CLOSE_CODES.policyViolation, 'too many messages');
    return false;
  }

  /** Whether the send buffer is backed up right now (also between ticks). */
  #backedUp(): boolean {
    return (
      this.#backpressured ||
      this.#socket.bufferedAmount > this.#softLimit ||
      this.#inFlight >= SOFT_IN_FLIGHT_MESSAGES
    );
  }

  /** Hysteresis: backpressured above a threshold, free again below half of it. */
  #updateBackpressure(): void {
    this.#softLimit = softBufferLimit(this.#grantedRate, this.#bytesPerEvent);
    const buffered = this.#socket.bufferedAmount;
    this.#backpressured = this.#backpressured
      ? buffered >= this.#softLimit / 2 || this.#inFlight > SOFT_IN_FLIGHT_MESSAGES / 2
      : buffered > this.#softLimit || this.#inFlight >= SOFT_IN_FLIGHT_MESSAGES;
  }

  #withinHardLimits(): boolean {
    if (
      this.#socket.bufferedAmount <= this.#hardLimit &&
      this.#inFlight <= MAX_IN_FLIGHT_MESSAGES
    ) {
      return true;
    }
    this.#kill('buffer-overflow');
    return false;
  }

  #configure(message: ConfigureMessage, now: number): ConfigMessage {
    if (message.rate !== undefined) this.#rate = clampRate(message.rate, this.#limits);
    if (message.scenario !== undefined && message.scenario !== this.#generator.scenario) {
      this.#generator.setScenario(message.scenario, now);
    }
    const scenario = this.#generator.scenario;
    return message.requestId === undefined
      ? { type: 'config', rate: this.#rate, scenario }
      : { type: 'config', requestId: message.requestId, rate: this.#rate, scenario };
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

  /** A write completed (or failed): one message less in flight. */
  readonly #onSent = (): void => {
    if (this.#inFlight > 0) this.#inFlight--;
    this.#lastDrainAt = this.#lastNow;
  };

  /** Sends a message; terminates the socket when it pushes the session past a hard cap. */
  #send(message: ServerMessage): void {
    if (this.#closed) return;
    if (this.#inFlight === 0) this.#lastDrainAt = this.#lastNow;
    this.#inFlight++;
    this.#socket.send(JSON.stringify(message), this.#onSent);
    this.#withinHardLimits();
  }
}
