import type { FromWorkerMessage, MessageEndpoint, ToWorkerMessage } from './worker-protocol';

/** The main thread's handle on the stream worker: a `Worker`, or a test double. */
export interface StreamWorker extends MessageEndpoint<FromWorkerMessage, ToWorkerMessage> {
  /** A message from the worker could not be deserialized. */
  onmessageerror: ((event: MessageEvent) => void) | null;
  /** The worker failed to load (e.g. blocked by CSP) or threw an uncaught error. */
  onerror: ((event: ErrorEvent) => void) | null;
  terminate(): void;
}

/**
 * Starts the stream worker as a module worker. Vite bundles `stream.worker.ts` because the
 * `new URL(…, import.meta.url)` stands directly inside `new Worker(…)`; the CSP allows it with
 * `worker-src 'self'`.
 */
export function spawnStreamWorker(): StreamWorker {
  return new Worker(new URL('./stream.worker.ts', import.meta.url), {
    type: 'module',
    name: 'stream',
  });
}
