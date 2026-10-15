import {
  type BatchMessage,
  buildConnectionUrl,
  CLOSE_CODES,
  HEARTBEAT_INTERVAL_MS,
  type HeartbeatMessage,
  type HelloMessage,
  parseServerMessage,
  PROTOCOL_VERSION,
  type ProtocolError,
  type Scenario,
} from '@lsv/protocol';

/** Stream settings the client asks for; the server applies defaults and clamps (see `hello.stream`). */
export interface StreamRequest {
  /** Events per second. */
  readonly rate?: number;
  readonly scenario?: Scenario;
  /** PRNG seed: the same seed and scenario reproduce the stream. */
  readonly seed?: number;
}

/**
 * Standard close codes `onClose` reports for failures the browser or this client detects itself;
 * the mock server never sends them (its codes are in the protocol's `CLOSE_CODES`).
 */
export const SOCKET_FAILURE_CODES = {
  /** The server broke the protocol: no valid `hello` in time. The reason says what happened. */
  protocolError: 1002,
  /**
   * The connection dropped or never opened. Browsers give no reason; a non-empty reason comes from
   * this client and explains why the socket could not be created (malformed URL, mixed content).
   */
  abnormalClosure: 1006,
} as const;

/** How long the server may take to send `hello` once the socket is open. */
export const HELLO_TIMEOUT_MS = 2 * HEARTBEAT_INTERVAL_MS;

/** Callbacks of a {@link StreamSocket}; none of them runs after `close()`. */
export interface StreamSocketHandlers {
  /** The server accepted the connection and describes the stream (first message). */
  readonly onHello?: (message: HelloMessage) => void;
  readonly onBatch?: (message: BatchMessage) => void;
  readonly onHeartbeat?: (message: HeartbeatMessage) => void;
  /** A frame was dropped because it is not a valid message (`invalid-json` / `invalid-message`). */
  readonly onInvalidFrame?: (error: ProtocolError) => void;
  /**
   * The connection ended: the server's close code and reason; 4001 when the server speaks another
   * protocol version; or one of {@link SOCKET_FAILURE_CODES}. Called at most once, asynchronously.
   */
  readonly onClose?: (code: number, reason: string) => void;
}

/** One connection to the mock server's stream (protocol v1, `docs/protocol.md`). */
export interface StreamSocket {
  /** Connection URL, including the query (`…/ws?v=1&rate=200`). */
  readonly url: string;
  /** Frames dropped so far because they were not valid messages. */
  readonly invalidFrames: number;
  /** Closes the connection; no handler runs afterwards. Safe to call more than once. */
  close(): void;
}

/**
 * Opens a WebSocket to `endpoint` (e.g. `ws://localhost:8787/ws`), asking for protocol v1 and the
 * given stream settings, and reports parsed messages. Frames of an unknown type (a newer server)
 * are ignored; malformed frames are counted and dropped — lost events show up as a `seq` gap.
 * There is no reconnect: the owner decides what to do after `onClose`.
 */
export function openStreamSocket(
  endpoint: string,
  request: StreamRequest,
  handlers: StreamSocketHandlers,
): StreamSocket {
  const url = buildConnectionUrl(endpoint, { version: PROTOCOL_VERSION, ...request });
  let socket: WebSocket;
  try {
    socket = new WebSocket(url);
  } catch (error) {
    // SyntaxError for a malformed URL, SecurityError for ws: from an https page.
    return unopenedSocket(url, error, handlers);
  }
  let invalidFrames = 0;
  let done = false;
  let helloTimer: ReturnType<typeof setTimeout> | undefined;

  function detach(): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    clearTimeout(helloTimer);
  }

  function end(code: number, reason: string): void {
    if (done) return;
    done = true;
    detach();
    handlers.onClose?.(code, reason);
  }

  /** Closes the socket because of something the server sent (or did not send). */
  function abandon(code: number, reason: string): void {
    socket.close(CLOSE_CODES.normal);
    end(code, reason);
  }

  function invalid(error: ProtocolError): void {
    invalidFrames++;
    handlers.onInvalidFrame?.(error);
  }

  socket.onopen = () => {
    helloTimer = setTimeout(() => {
      abandon(
        SOCKET_FAILURE_CODES.protocolError,
        `server did not complete the handshake within ${String(HELLO_TIMEOUT_MS / 1000)} s`,
      );
    }, HELLO_TIMEOUT_MS);
  };
  socket.onmessage = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (typeof data !== 'string') {
      invalid({ kind: 'invalid-message', message: 'Binary frames are not part of protocol v1' });
      return;
    }
    const parsed = parseServerMessage(data);
    if (!parsed.ok) {
      if (parsed.error.kind !== 'unknown-type') invalid(parsed.error);
      return;
    }
    const message = parsed.value;
    switch (message.type) {
      case 'hello':
        clearTimeout(helloTimer);
        if (message.protocolVersion !== PROTOCOL_VERSION) {
          // A server that answers in another version cannot be read; like 4001, only a reload helps.
          abandon(
            CLOSE_CODES.unsupportedVersion,
            `server speaks protocol v${String(message.protocolVersion)}`,
          );
          return;
        }
        handlers.onHello?.(message);
        return;
      case 'batch':
        handlers.onBatch?.(message);
        return;
      case 'heartbeat':
        handlers.onHeartbeat?.(message);
        return;
      case 'config':
      case 'error':
        // Answers to `configure`, which this client does not send yet.
        return;
    }
  };
  // `error` carries no details and is always followed by `close` (1006), which reports it.
  socket.onclose = (event: CloseEvent) => {
    end(event.code, event.reason);
  };

  return {
    url,
    get invalidFrames() {
      return invalidFrames;
    },
    close() {
      if (done) return;
      done = true;
      detach();
      if (socket.readyState === WebSocket.CONNECTING) {
        // Closing during the handshake makes the browser log an error; close right after it instead.
        socket.onopen = () => {
          socket.close(CLOSE_CODES.normal);
        };
      } else if (socket.readyState === WebSocket.OPEN) {
        socket.close(CLOSE_CODES.normal);
      }
    },
  };
}

/**
 * Stands in for a socket the browser refused to create: reports the error like a connection that
 * never opened, from a microtask, so the caller holds the `StreamSocket` before `onClose` runs.
 */
function unopenedSocket(url: string, error: unknown, handlers: StreamSocketHandlers): StreamSocket {
  let closed = false;
  const reason = error instanceof Error ? error.message : String(error);
  queueMicrotask(() => {
    if (!closed) handlers.onClose?.(SOCKET_FAILURE_CODES.abnormalClosure, reason);
  });
  return {
    url,
    invalidFrames: 0,
    close() {
      closed = true;
    },
  };
}
