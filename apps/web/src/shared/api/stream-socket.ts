import {
  type BatchMessage,
  buildConnectionUrl,
  CLOSE_CODES,
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

/** Callbacks of a {@link StreamSocket}; none of them runs after `close()`. */
export interface StreamSocketHandlers {
  /** The server accepted the connection and describes the stream (first message). */
  readonly onHello?: (message: HelloMessage) => void;
  readonly onBatch?: (message: BatchMessage) => void;
  readonly onHeartbeat?: (message: HeartbeatMessage) => void;
  /** A frame was dropped because it is not a valid message (`invalid-json` / `invalid-message`). */
  readonly onInvalidFrame?: (error: ProtocolError) => void;
  /**
   * The connection ended: the server's close code and reason, 1006 when it dropped, or 4001 when
   * the server speaks another protocol version. Called at most once.
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
  const socket = new WebSocket(url);
  let invalidFrames = 0;
  let done = false;

  function detach(): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
  }

  function end(code: number, reason: string): void {
    if (done) return;
    done = true;
    detach();
    handlers.onClose?.(code, reason);
  }

  function invalid(error: ProtocolError): void {
    invalidFrames++;
    handlers.onInvalidFrame?.(error);
  }

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
        if (message.protocolVersion !== PROTOCOL_VERSION) {
          // A server that answers in another version cannot be read; like 4001, only a reload helps.
          socket.close(CLOSE_CODES.normal);
          end(
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
