import type { ColumnBatch, StreamCounters } from '@lsv/core';
import type { HelloMessage } from '@lsv/protocol';

import type { StreamRequest } from '@/shared/api';

/**
 * Messages between the main thread and the stream worker (docs/adr/0006, "Main ↔ worker
 * messages"). Plain discriminated unions, no RPC library: transfers stay explicit and stale
 * messages are dropped in one place.
 *
 * Every message carries the `session` the main thread started: it increments the number on each
 * `start`, and drops whatever the worker still sends for an older session, so a restart never
 * mixes two streams. Later tasks add `configure`/`config`/`stream-error` (T6) and
 * `get-event`/`event` (T8) to these unions.
 */

/** Opens a stream: closes the current connection and starts a new session with a new buffer. */
export interface WorkerStartMessage {
  readonly type: 'start';
  readonly session: number;
  /** WebSocket endpoint of the mock server, e.g. `ws://localhost:8787/ws`. */
  readonly endpoint: string;
  readonly request: StreamRequest;
  /** Buffer capacity in events, already clamped; the main thread's replica uses the same value. */
  readonly capacity: number;
}

/** Closes the session's connection. A `stop` for an older session is ignored. */
export interface WorkerStopMessage {
  readonly type: 'stop';
  readonly session: number;
}

/** Main thread → worker. */
export type ToWorkerMessage = WorkerStartMessage | WorkerStopMessage;

/** The server accepted the connection (its `hello`): the stream has started. */
export interface WorkerHelloMessage extends Pick<HelloMessage, 'stream' | 'limits' | 'expiresAt'> {
  readonly type: 'hello';
  readonly session: number;
}

/**
 * Rows the worker appended since its previous batch. The typed arrays of `columns` are transferred
 * (`columnBatchTransferables`), so the worker no longer owns them once posted.
 */
export interface WorkerBatchMessage {
  readonly type: 'batch';
  readonly session: number;
  readonly columns: ColumnBatch;
  readonly counters: StreamCounters;
}

/** Counters without rows: after a server heartbeat or an invalid frame, so events/s stays current. */
export interface WorkerCountersMessage {
  readonly type: 'counters';
  readonly session: number;
  readonly counters: StreamCounters;
}

/** The connection ended (see `StreamSocketHandlers.onClose` for the codes). */
export interface WorkerClosedMessage {
  readonly type: 'closed';
  readonly session: number;
  readonly code: number;
  readonly reason: string;
  readonly counters: StreamCounters;
}

/** Worker → main thread. */
export type FromWorkerMessage =
  WorkerHelloMessage | WorkerBatchMessage | WorkerCountersMessage | WorkerClosedMessage;

/**
 * One end of a message channel, as the worker global scope, a `Worker` or a `MessagePort`
 * provides it (and a test double). Messages are typed by trust, not validated: both ends are this
 * app's own code, loaded from the app's origin.
 */
export interface MessageEndpoint<Receive, Send> {
  onmessage: ((event: MessageEvent<Receive>) => void) | null;
  postMessage(message: Send, options?: StructuredSerializeOptions): void;
}
