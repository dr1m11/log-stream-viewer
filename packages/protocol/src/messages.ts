import type { LogEvent } from './event.ts';
import type { Scenario } from './scenarios.ts';

/** Effective generator settings of a stream, after the server has clamped the request. */
export interface StreamSettings {
  /** Events per second. */
  readonly rate: number;
  readonly scenario: Scenario;
  /** PRNG seed; reusing it with the same scenario reproduces the stream. */
  readonly seed: number;
}

/** Limits of this deployment. The UI takes its rate bounds from here, never from constants. */
export interface StreamLimits {
  readonly minRate: number;
  readonly maxRate: number;
  /** The server closes the session with 4000 after this many milliseconds. */
  readonly sessionMaxMs: number;
}

/** First message on every connection: describes the stream the client is attached to. */
export interface HelloMessage {
  readonly type: 'hello';
  readonly protocolVersion: number;
  /** Identifies the stream that `LogEvent.seq` counts within. */
  readonly streamId: string;
  /** `true` when the server continued an earlier stream (`?resume=`, from B4); always `false` in B1. */
  readonly resumed: boolean;
  /** Server clock at sending, epoch ms; with `batch.sentAt` it lets the client estimate clock offset. */
  readonly serverTime: number;
  readonly stream: StreamSettings;
  readonly limits: StreamLimits;
  /** When the server will close the session with 4000, epoch ms. */
  readonly expiresAt: number;
}

/** Events generated during one tick (`BATCH_INTERVAL_MS`), in ascending `seq` order. */
export interface BatchMessage {
  readonly type: 'batch';
  /** Server clock when the batch was sent, epoch ms. */
  readonly sentAt: number;
  readonly events: readonly LogEvent[];
  /** Events skipped since the previous batch (backpressure). Informational; gaps in `seq` are authoritative. */
  readonly dropped?: number;
}

/** Liveness signal, sent every `HEARTBEAT_INTERVAL_MS` even when there are no events. */
export interface HeartbeatMessage {
  readonly type: 'heartbeat';
  readonly serverTime: number;
  /** Highest `seq` assigned in this stream so far, sent or dropped; 0 before the first event. */
  readonly lastSeq: number;
}

/** Current stream settings: the answer to `configure` or a change made by the server itself. */
export interface ConfigMessage {
  readonly type: 'config';
  /** Echo of `configure.requestId`; absent when the request had none or the server changed the settings. */
  readonly requestId?: string;
  readonly rate: number;
  readonly scenario: Scenario;
}

/** Codes of the `error` message. */
export const ERROR_CODES = ['bad-message', 'unsupported'] as const;

/**
 * Why the server rejected a client message:
 * - `bad-message` — not JSON or not a valid message;
 * - `unsupported` — a message type this server does not know.
 */
export type ErrorCode = (typeof ERROR_CODES)[number];

/** The server rejected a client message. The connection stays open. */
export interface ErrorMessage {
  readonly type: 'error';
  readonly code: ErrorCode;
  /** Human-readable details for logs; not meant for parsing. */
  readonly message: string;
}

/** Any message the server sends. */
export type ServerMessage =
  HelloMessage | BatchMessage | HeartbeatMessage | ConfigMessage | ErrorMessage;

/** Every server message type in protocol v1. */
export const SERVER_MESSAGE_TYPES = [
  'hello',
  'batch',
  'heartbeat',
  'config',
  'error',
] as const satisfies readonly ServerMessage['type'][];

/**
 * Asks the server to change the stream settings. Omitted fields stay as they are; the server clamps
 * `rate` to `hello.limits` and answers with `config`.
 */
export interface ConfigureMessage {
  readonly type: 'configure';
  /** Opaque id chosen by the client, echoed in the `config` answer. */
  readonly requestId?: string;
  readonly rate?: number;
  readonly scenario?: Scenario;
}

/** Any message the client sends. */
export type ClientMessage = ConfigureMessage;

/** Every client message type in protocol v1. */
export const CLIENT_MESSAGE_TYPES = [
  'configure',
] as const satisfies readonly ClientMessage['type'][];
