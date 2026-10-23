import { createEventStore, type EventStore, type StreamCounters } from '@lsv/core';
import { assertNever, type Scenario, type StreamLimits, type StreamSettings } from '@lsv/protocol';

import { SOCKET_FAILURE_CODES, type StreamRequest } from '@/shared/api';

import { spawnStreamWorker, type StreamWorker } from '../api/spawn-stream-worker';
import type { FromWorkerMessage, LogEventDetails } from '../api/worker-protocol';

/** Where the connection is. `connected` starts with the server's `hello`, not with the socket opening. */
export type ConnectionStatus =
  | { readonly phase: 'connecting' }
  | {
      readonly phase: 'connected';
      /** Effective stream settings, after the server's defaults and clamping. */
      readonly stream: StreamSettings;
      /** Bounds of this deployment; a rate control must clamp to them (`docs/protocol.md`). */
      readonly limits: StreamLimits;
      /** When the server will end the session with 4000, epoch ms (server clock). */
      readonly expiresAt: number;
    }
  | {
      readonly phase: 'closed';
      readonly code: number;
      readonly reason: string;
      /** Whether the stream had started (`hello`) before the connection closed. */
      readonly wasConnected: boolean;
    };

/**
 * Read access to the main thread's replica of the event buffer (docs/adr/0006): rows by position,
 * for the table. The row accessors do not check their position; read only positions inside
 * `[start, end)` read in the same task, or check `has(position)`. Batches are appended as they
 * arrive, between snapshots, so the replica may already be ahead of the snapshot that rendered:
 * a row the snapshot still lists may have been evicted since.
 */
export type LogBufferView = Pick<
  EventStore,
  | 'capacity'
  | 'start'
  | 'end'
  | 'size'
  | 'has'
  | 'seqAt'
  | 'tsAt'
  | 'levelAt'
  | 'serviceAt'
  | 'hostAt'
  | 'messageAt'
  | 'traceIdAt'
  | 'hasPayloadAt'
  | 'eventAt'
>;

/** A change of the stream settings; omitted fields stay as they are. */
export interface StreamSettingsChange {
  /** Events per second, an integer; the server clamps it to `limits`. */
  readonly rate?: number;
  readonly scenario?: Scenario;
}

/** The state of the settings changes the user asked for (`configure`). */
export interface StreamSettingsRequests {
  /**
   * The changes sent and not answered yet, merged (a later value of a field wins) under the
   * newest `requestId`. The server applies every `configure` in order, so its answer to the newest
   * one reflects them all: the `config` with that `requestId` clears it (and updates
   * `status.stream`), as do a `stream-error` and a new session.
   */
  readonly pending: (StreamSettingsChange & { readonly requestId: string }) | undefined;
  /**
   * Why the latest change was not applied (`code` is the server's open `error.code` or
   * `not-connected`); `status.stream` still holds the effective settings. Cleared by the next
   * `configure()` and by a new session.
   */
  readonly error: { readonly code: string; readonly message: string } | undefined;
}

/**
 * Where the user paused the view (`pause()`): the buffer range the table showed at that moment.
 * The buffer keeps receiving and evicting while paused; only the view holds still.
 */
export interface PausedView {
  /**
   * `start` when paused: the oldest row the user could scroll to. Once the buffer's `start` passes
   * it, rows of the paused view (and then events received during the pause) are being evicted.
   */
  readonly start: number;
  /** `end` when paused: the table shows no row at or after this position until `resume()`. */
  readonly end: number;
}

/** What the UI shows. A new object only when a value changed, at most once per animation frame. */
export interface LogStreamSnapshot {
  readonly status: ConnectionStatus;
  /** The worker's counters for this session; `eventsPerSecond` is 0 unless connected. */
  readonly counters: StreamCounters;
  /** This session's buffer replica: a new view for every session, whose positions restart at 0. */
  readonly buffer: LogBufferView;
  /** `buffer.start` when the snapshot was taken: the oldest retained position. */
  readonly start: number;
  /** `buffer.end` when the snapshot was taken: the position after the newest row. */
  readonly end: number;
  /**
   * The last failure the store recovered from on its own by restarting the stream (the replica
   * fell out of step with the worker's buffer), for the UI to mention; cleared by `start()`.
   */
  readonly error: string | undefined;
  /** Settings changes in flight and the last one that failed. */
  readonly settings: StreamSettingsRequests;
  /** The paused view, or `undefined` while the view follows the stream; cleared by a new session. */
  readonly paused: PausedView | undefined;
}

export interface LogStreamOptions {
  /** WebSocket endpoint of the mock server, e.g. `ws://localhost:8787/ws`. */
  readonly endpoint: string;
  readonly request: StreamRequest;
  /** Buffer capacity in events, already clamped (`clampBufferCapacity`); used by both threads. */
  readonly capacity: number;
  /** Starts the worker; {@link spawnStreamWorker} unless a test passes a fake. */
  readonly spawnWorker?: () => StreamWorker;
}

export interface LogStreamStore {
  /** Subscribes to snapshot changes (`useSyncExternalStore`). Returns the unsubscribe function. */
  readonly subscribe: (listener: () => void) => () => void;
  /** The current snapshot: the same object until a value changes. */
  readonly getSnapshot: () => LogStreamSnapshot;
  /** Starts a new session (new buffers on both threads), spawning the worker if needed. */
  readonly start: () => void;
  /** Closes the connection, terminates the worker and cancels pending publications. */
  readonly stop: () => void;
  /**
   * Asks the server to change the stream's settings and publishes the request right away as
   * `settings.pending`, merged with the changes still unanswered. Returns the request's id (`cfg-<n>`), or `undefined` without
   * sending anything unless the stream is connected. Each call is one client message and the
   * server closes a client that sends more than 20 per second (`docs/protocol.md`), so call it
   * once per user commit, never per input event.
   */
  readonly configure: (change: StreamSettingsChange) => string | undefined;
  /**
   * Freezes the view at the range of the current snapshot (`paused`) and publishes at once. Only
   * the view: the worker and the replica keep receiving, and the replica keeps evicting at its
   * capacity. Does nothing while already paused.
   */
  readonly pause: () => void;
  /** Lets the view follow the stream again (`paused` becomes `undefined`) and publishes at once. */
  readonly resume: () => void;
  /**
   * The details of the event at a buffer position from the worker's buffer, which keeps the
   * payloads the replica drops: every field, and the payload pretty-printed (and cut at
   * `MAX_PAYLOAD_TEXT_LENGTH`) in the worker. Resolves `undefined` when the position is no longer retained — evicted, or
   * the session it belongs to is over: a new session, `stop()`, a failed worker and the
   * {@link MAX_PENDING_EVENT_REQUESTS} bound all resolve the requests still waiting with
   * `undefined`, so a caller never waits forever and never sees an event of another stream. It
   * never rejects.
   */
  readonly getEventDetails: (position: number) => Promise<LogEventDetails | undefined>;
}

/**
 * Restarts the store makes on its own per `start()` when the replica can no longer be trusted.
 * Each one opens a new connection, and the server admits only a few per client IP (then 4029),
 * so a fault that keeps coming back ends in a closed status instead of a reconnect loop.
 */
export const MAX_AUTO_RESTARTS = 3;

/**
 * `getEventDetails` requests waiting for the worker's answer at most; a further request resolves the
 * oldest one with `undefined`. The details view asks for one event at a time, so the bound only
 * matters for a caller that does not wait for its answers.
 */
export const MAX_PENDING_EVENT_REQUESTS = 16;

const CONNECTING: ConnectionStatus = { phase: 'connecting' };
const NO_SETTINGS_REQUESTS: StreamSettingsRequests = { pending: undefined, error: undefined };
const NO_COUNTERS: StreamCounters = {
  received: 0,
  eventsPerSecond: 0,
  missed: 0,
  dropped: 0,
  invalidFrames: 0,
};

/** A view of `store` that exposes no mutating method. The accessors use no `this`. */
function readOnlyView(store: EventStore): LogBufferView {
  return {
    capacity: store.capacity,
    get start() {
      return store.start;
    },
    get end() {
      return store.end;
    },
    get size() {
      return store.size;
    },
    has: store.has,
    seqAt: store.seqAt,
    tsAt: store.tsAt,
    levelAt: store.levelAt,
    serviceAt: store.serviceAt,
    hostAt: store.hostAt,
    messageAt: store.messageAt,
    traceIdAt: store.traceIdAt,
    hasPayloadAt: store.hasPayloadAt,
    eventAt: store.eventAt,
  };
}

function sameCounters(a: StreamCounters, b: StreamCounters): boolean {
  return (
    a.received === b.received &&
    a.eventsPerSecond === b.eventsPerSecond &&
    a.missed === b.missed &&
    a.dropped === b.dropped &&
    a.invalidFrames === b.invalidFrames
  );
}

/**
 * The main thread's side of the stream pipeline (docs/adr/0006). The worker owns the socket and
 * the authoritative buffer; this store keeps a replica without payloads, fed by the worker's
 * column batches as they arrive, and publishes a snapshot for React at most once per animation
 * frame, whatever the batch rate. A hidden tab pauses the frames but not the batches: the replica
 * evicts on append, so it stays at its capacity.
 *
 * Every `start` opens a new session; messages of an older one are dropped. If a batch does not
 * continue the replica (`appendColumns` throws a `RangeError`) or a message from the worker cannot
 * be deserialized (`messageerror`), the rows can no longer be trusted to match the worker's, so
 * the store records the error and restarts with a new session — at most
 * {@link MAX_AUTO_RESTARTS} times per `start()`, then it reports the stream as closed.
 */
export function createLogStreamStore(options: LogStreamOptions): LogStreamStore {
  const { endpoint, request, capacity, spawnWorker = spawnStreamWorker } = options;
  const listeners = new Set<() => void>();

  let worker: StreamWorker | undefined;
  let session = 0;
  let frame: number | undefined;

  let buffer = createEventStore({ capacity, keepPayload: false });
  let view = readOnlyView(buffer);
  let status: ConnectionStatus = CONNECTING;
  let counters = NO_COUNTERS;
  let error: string | undefined;
  let autoRestarts = 0;
  let settings = NO_SETTINGS_REQUESTS;
  /** Numbers the `configure` request ids; never reset, so an id is unique per store. */
  let configureRequests = 0;
  let paused: PausedView | undefined;
  /** `getEventDetails` callers waiting for the worker, by request id, oldest first (insertion order). */
  const pendingEvents = new Map<number, (event: LogEventDetails | undefined) => void>();
  /** Numbers the `get-event` requests; never reset, so an id is unique per store. */
  let eventRequests = 0;

  let snapshot: LogStreamSnapshot = {
    status,
    counters,
    buffer: view,
    start: 0,
    end: 0,
    error: undefined,
    settings,
    paused,
  };

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function schedulePublish(): void {
    frame ??= requestAnimationFrame(publish);
  }

  function publish(): void {
    frame = undefined;
    const { start, end } = buffer;
    const previous = snapshot;
    const shown =
      status.phase === 'connected' || counters.eventsPerSecond === 0
        ? counters
        : { ...counters, eventsPerSecond: 0 };
    const nextCounters = sameCounters(previous.counters, shown) ? previous.counters : shown;
    if (
      previous.status === status &&
      previous.counters === nextCounters &&
      previous.buffer === view &&
      previous.start === start &&
      previous.end === end &&
      previous.error === error &&
      previous.settings === settings &&
      previous.paused === paused
    ) {
      return;
    }
    snapshot = {
      status,
      counters: nextCounters,
      buffer: view,
      start,
      end,
      error,
      settings,
      paused,
    };
    notify();
  }

  /** Publishes now instead of on the next frame, for a change the user just made. */
  function publishNow(): void {
    cancelPending();
    publish();
  }

  function cancelPending(): void {
    if (frame !== undefined) {
      cancelAnimationFrame(frame);
      frame = undefined;
    }
  }

  /** Resolves every waiting `getEventDetails` with `undefined`: their session is over or unreachable. */
  function settleEventRequests(): void {
    for (const resolve of pendingEvents.values()) resolve(undefined);
    pendingEvents.clear();
  }

  function receive({ data }: MessageEvent<FromWorkerMessage>): void {
    if (data.session !== session) return;
    switch (data.type) {
      case 'hello': {
        const { stream, limits, expiresAt } = data;
        status = { phase: 'connected', stream, limits, expiresAt };
        break;
      }
      case 'batch':
        try {
          buffer.appendColumns(data.columns);
        } catch (failure) {
          if (!(failure instanceof RangeError)) throw failure;
          recover(`the table fell out of step with the stream (${failure.message})`);
          return;
        }
        counters = data.counters;
        break;
      case 'counters':
        counters = data.counters;
        break;
      case 'config': {
        const { requestId, rate, scenario } = data;
        if (status.phase === 'connected') {
          // A new `stream` object, so everything that shows the settings re-renders; `seed` stays.
          status = { ...status, stream: { ...status.stream, rate, scenario } };
        }
        if (requestId !== undefined && requestId === settings.pending?.requestId) {
          settings = { ...settings, pending: undefined };
        }
        break;
      }
      case 'stream-error':
        settings = { pending: undefined, error: { code: data.code, message: data.message } };
        break;
      case 'closed':
        status = {
          phase: 'closed',
          code: data.code,
          reason: data.reason,
          wasConnected: status.phase === 'connected',
        };
        counters = data.counters;
        break;
      case 'event': {
        const resolve = pendingEvents.get(data.requestId);
        pendingEvents.delete(data.requestId);
        resolve?.(data.details);
        // Nothing in the snapshot changed.
        return;
      }
      default:
        // A message type added to `FromWorkerMessage` without a case here fails to compile.
        assertNever(data);
    }
    schedulePublish();
  }

  /**
   * The replica may no longer match the worker's buffer (`problem` says why, in lower case):
   * restart with a new session, or give up once {@link MAX_AUTO_RESTARTS} are used up.
   */
  function recover(problem: string): void {
    if (autoRestarts >= MAX_AUTO_RESTARTS) {
      worker?.postMessage({ type: 'stop', session });
      // Whatever the worker still sends belongs to a session that is over.
      session++;
      settleEventRequests();
      status = {
        phase: 'closed',
        code: SOCKET_FAILURE_CODES.protocolError,
        reason: `${problem}; gave up after ${String(MAX_AUTO_RESTARTS)} automatic restarts`,
        wasConnected: status.phase === 'connected',
      };
    } else {
      autoRestarts++;
      error = `Restarted the stream: ${problem}.`;
      openSession();
    }
    schedulePublish();
  }

  /** The worker could not load (e.g. blocked by CSP) or crashed: nothing more will arrive. */
  function fail(event: ErrorEvent): void {
    const detail = event instanceof ErrorEvent && event.message !== '' ? `: ${event.message}` : '';
    status = {
      phase: 'closed',
      code: SOCKET_FAILURE_CODES.abnormalClosure,
      reason: `The stream worker failed${detail}`,
      wasConnected: status.phase === 'connected',
    };
    terminateWorker();
    schedulePublish();
  }

  function terminateWorker(): void {
    settleEventRequests();
    if (worker === undefined) return;
    worker.onmessage = null;
    worker.onmessageerror = null;
    worker.onerror = null;
    worker.terminate();
    worker = undefined;
  }

  /** Starts a new session: fresh buffers on both threads, counters and status from scratch. */
  function openSession(): void {
    session++;
    settleEventRequests();
    // A replica that never received a row equals a new one; skip reallocating its columns.
    if (buffer.end !== 0) {
      buffer = createEventStore({ capacity, keepPayload: false });
      view = readOnlyView(buffer);
    }
    status = CONNECTING;
    counters = NO_COUNTERS;
    settings = NO_SETTINGS_REQUESTS;
    paused = undefined;
    if (worker === undefined) {
      worker = spawnWorker();
      worker.onmessage = receive;
      // Not tied to a session: the message could not be read, so neither could its session.
      worker.onmessageerror = () => {
        recover('a message from the stream worker could not be deserialized');
      };
      worker.onerror = fail;
    }
    worker.postMessage({ type: 'start', session, endpoint, request, capacity });
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    start() {
      cancelPending();
      error = undefined;
      autoRestarts = 0;
      openSession();
      publish();
    },
    stop() {
      // Lets the worker close the socket cleanly if it gets to it before the termination; a
      // terminated worker's socket is closed by the browser either way.
      worker?.postMessage({ type: 'stop', session });
      terminateWorker();
      // Anything still queued from the worker belongs to a session that is over.
      session++;
      cancelPending();
    },
    configure({ rate, scenario }) {
      if (worker === undefined || status.phase !== 'connected') return undefined;
      configureRequests++;
      const requestId = `cfg-${String(configureRequests)}`;
      worker.postMessage({ type: 'configure', session, requestId, rate, scenario });
      // Keep what earlier unanswered requests changed: a rate after a scenario must not hide the
      // pending scenario, or the controls would show the old one while the server applies the new.
      const previous = settings.pending;
      settings = {
        pending: {
          requestId,
          rate: rate ?? previous?.rate,
          scenario: scenario ?? previous?.scenario,
        },
        error: undefined,
      };
      // Publish now rather than on the next frame: the control that asked shows the pending
      // value at once instead of flashing back to the effective one for a frame.
      publishNow();
      return requestId;
    },
    pause() {
      if (paused !== undefined) return;
      // Freeze what the user sees: the published range, not the replica, which may already hold
      // rows of batches that arrived after the last frame. Right after a restart the snapshot may
      // still show the old session's buffer; then the new (empty) replica is the view.
      paused =
        snapshot.buffer === view
          ? { start: snapshot.start, end: snapshot.end }
          : { start: buffer.start, end: buffer.end };
      publishNow();
    },
    resume() {
      if (paused === undefined) return;
      paused = undefined;
      publishNow();
    },
    getEventDetails(position) {
      // The worker's buffer is never behind the replica: what the replica evicted, it evicted too.
      if (worker === undefined || !buffer.has(position)) return Promise.resolve(undefined);
      if (pendingEvents.size >= MAX_PENDING_EVENT_REQUESTS) {
        // Maps iterate in insertion order: the first entry is the oldest request.
        for (const [oldest, resolve] of pendingEvents) {
          pendingEvents.delete(oldest);
          resolve(undefined);
          break;
        }
      }
      eventRequests++;
      const requestId = eventRequests;
      const answer = new Promise<LogEventDetails | undefined>((resolve) => {
        pendingEvents.set(requestId, resolve);
      });
      worker.postMessage({ type: 'get-event', session, requestId, position });
      return answer;
    },
  };
}
