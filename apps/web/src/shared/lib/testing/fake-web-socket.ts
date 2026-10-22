/** Arguments of a client's `close()` call. */
export interface CloseRequest {
  readonly code: number | undefined;
  readonly reason: string | undefined;
}

/**
 * Stand-in for the browser `WebSocket` in unit tests. Install it with
 * `vi.stubGlobal('WebSocket', FakeWebSocket)`, drive the connection from the test (`open()`,
 * `receive()`, `closeFromServer()`) and inspect what the code under test did (`url`, `sent`, `closedWith`).
 * Handlers run synchronously, so wrap the controls in `act()` when React state depends on them.
 */
export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  /** Every socket created since the last `reset()`, oldest first. */
  static readonly instances: FakeWebSocket[] = [];

  /** Forgets the sockets of the previous test. */
  static reset(): void {
    FakeWebSocket.instances.length = 0;
  }

  /** The most recently created socket. */
  static latest(): FakeWebSocket {
    const socket = FakeWebSocket.instances.at(-1);
    if (socket === undefined) throw new Error('No WebSocket has been created');
    return socket;
  }

  readonly url: string;
  readyState: number = FakeWebSocket.CONNECTING;
  binaryType: BinaryType = 'blob';
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  /** Set when the code under test called `close()`. */
  closedWith: CloseRequest | undefined;
  /** Frames the code under test sent, oldest first. */
  readonly sent: unknown[] = [];

  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  send(data: unknown): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new DOMException('WebSocket is not open', 'InvalidStateError');
    }
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    if (this.readyState !== FakeWebSocket.CLOSED) this.readyState = FakeWebSocket.CLOSING;
  }

  // --- Test controls -----------------------------------------------------------------------------

  /** The handshake succeeded. */
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  /** A frame arrived: a string for text frames, a `Blob` or `ArrayBuffer` for binary ones. */
  receive(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  /** The connection ended: the server closed it with `code`, or it dropped (1006, after `error`). */
  closeFromServer(code: number, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    const abnormal = code === 1006;
    if (abnormal) this.onerror?.(new Event('error'));
    this.onclose?.(new CloseEvent('close', { code, reason, wasClean: !abnormal }));
  }
}
