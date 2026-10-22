/** A message the code under test posted, after the structured clone a real port would make. */
export interface PostedMessage<Message> {
  readonly message: Message;
  /** What the sender listed as transferables; they are detached in the sender afterwards. */
  readonly transfer: readonly Transferable[];
}

function transferList(options: StructuredSerializeOptions | Transferable[] | undefined) {
  if (options === undefined) return [];
  return Array.isArray(options) ? options : (options.transfer ?? []);
}

/**
 * Stand-in for one end of a message channel (a worker's global scope, a `MessagePort`) in unit
 * tests: the code under test sets `onmessage` and posts; the test delivers messages with
 * `receive()` and reads what was posted from `posted`. Posting clones the message with
 * `structuredClone` and its transfer list, as a real port does, so transferred buffers are
 * detached in the sender. Delivery is synchronous.
 */
export class FakeMessagePort<Receive = unknown, Send = unknown> {
  onmessage: ((event: MessageEvent<Receive>) => void) | null = null;
  /** Everything posted so far, oldest first. */
  readonly posted: PostedMessage<Send>[] = [];

  postMessage(message: Send, options?: StructuredSerializeOptions | Transferable[]): void {
    const transfer = transferList(options);
    this.posted.push({ message: structuredClone(message, { transfer: [...transfer] }), transfer });
  }

  // --- Test controls -----------------------------------------------------------------------------

  /** Delivers `data` to `onmessage`. */
  receive(data: Receive): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  /** The posted messages without their transfer lists. */
  messages(): Send[] {
    return this.posted.map(({ message }) => message);
  }
}

/**
 * Stand-in for the browser `Worker` in unit tests: a {@link FakeMessagePort} as seen from the main
 * thread, plus `onerror` and `terminate()`. Install it with `vi.stubGlobal('Worker', FakeWorker)`
 * or pass `() => new FakeWorker()` where the code takes a worker factory. Nothing runs inside: the
 * test answers for the worker with `receive()` and fails it with `receiveUnreadable()` or `fail()`. Messages are `unknown`:
 * the fake fits any message protocol. A terminated worker neither records posts nor delivers
 * messages.
 */
export class FakeWorker extends FakeMessagePort {
  /** Every worker created since the last `reset()`, oldest first. */
  static readonly instances: FakeWorker[] = [];

  /** Forgets the workers of the previous test. */
  static reset(): void {
    FakeWorker.instances.length = 0;
  }

  /** The most recently created worker. */
  static latest(): FakeWorker {
    const worker = FakeWorker.instances.at(-1);
    if (worker === undefined) throw new Error('No Worker has been created');
    return worker;
  }

  /** Script URL, when constructed like a real `Worker`. */
  readonly url: string | undefined;
  readonly options: WorkerOptions | undefined;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;

  constructor(url?: string | URL, options?: WorkerOptions) {
    super();
    this.url = url === undefined ? undefined : String(url);
    this.options = options;
    FakeWorker.instances.push(this);
  }

  override postMessage(
    message: unknown,
    options?: StructuredSerializeOptions | Transferable[],
  ): void {
    if (!this.terminated) super.postMessage(message, options);
  }

  terminate(): void {
    this.terminated = true;
  }

  // --- Test controls -----------------------------------------------------------------------------

  override receive(data: unknown): void {
    if (!this.terminated) super.receive(data);
  }

  /** A message from the worker arrived but could not be deserialized (`messageerror`). */
  receiveUnreadable(): void {
    if (!this.terminated) this.onmessageerror?.(new MessageEvent('messageerror'));
  }

  /** The worker failed: an uncaught error, or a script that did not load. */
  fail(message = ''): void {
    if (!this.terminated) this.onerror?.(new ErrorEvent('error', { message }));
  }
}
