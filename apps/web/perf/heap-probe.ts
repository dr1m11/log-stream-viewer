import type { CDPSession, Page } from '@playwright/test';

/** One isolate's heap after a full GC, in bytes. */
export interface HeapUsage {
  /** Live objects on the V8 heap (strings, arrays, closures…). */
  jsHeap: number;
  /** ArrayBuffer backing stores outside the V8 heap: the typed-array columns of `EventStore`. */
  arrayBuffers: number;
  total: number;
}

export interface HeapProbe {
  /** Collects garbage, then reads the heap of the page and of its dedicated worker. */
  measure(): Promise<{ main: HeapUsage; worker: HeapUsage | undefined }>;
}

interface HeapUsageResult {
  usedSize: number;
  backingStorageSize?: number;
}

interface TargetResponse {
  id: number;
  result?: unknown;
  error?: { message: string };
}

function toUsage({ usedSize, backingStorageSize = 0 }: HeapUsageResult): HeapUsage {
  return {
    jsHeap: usedSize,
    arrayBuffers: backingStorageSize,
    total: usedSize + backingStorageSize,
  };
}

function isHeapUsageResult(value: unknown): value is HeapUsageResult {
  return typeof value === 'object' && value !== null && 'usedSize' in value;
}

/**
 * Attaches to the page over CDP before navigation, so the stream worker is attached as soon as it
 * starts. `performance.measureUserAgentSpecificMemory()` would report both threads from inside the
 * page, but it needs cross-origin isolation, which the app does not enable (ADR-0006).
 *
 * Playwright's CDP sessions cannot address a child session directly, so the worker is attached
 * in non-flat mode: its commands and replies travel inside `Target.sendMessageToTarget` and
 * `Target.receivedMessageFromTarget` of the page session.
 */
export async function attachHeapProbe(page: Page): Promise<HeapProbe> {
  const session: CDPSession = await page.context().newCDPSession(page);
  let workerSession: string | undefined;
  let nextId = 1;
  const pending = new Map<number, (response: TargetResponse) => void>();

  session.on('Target.attachedToTarget', ({ sessionId, targetInfo }) => {
    if (targetInfo.type === 'worker') workerSession = sessionId;
  });
  session.on('Target.detachedFromTarget', ({ sessionId }) => {
    if (sessionId === workerSession) workerSession = undefined;
  });
  session.on('Target.receivedMessageFromTarget', ({ message }) => {
    // CDP's own JSON: the one validated boundary of this file.
    const response = JSON.parse(message) as TargetResponse;
    pending.get(response.id)?.(response);
    pending.delete(response.id);
  });
  await session.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: false,
  });

  async function sendToWorker(sessionId: string, method: string): Promise<unknown> {
    const id = nextId++;
    const reply = new Promise<TargetResponse>((resolve) => pending.set(id, resolve));
    await session.send('Target.sendMessageToTarget', {
      sessionId,
      message: JSON.stringify({ id, method, params: {} }),
    });
    const response = await reply;
    if (response.error !== undefined) throw new Error(`${method}: ${response.error.message}`);
    return response.result;
  }

  return {
    async measure() {
      await session.send('HeapProfiler.collectGarbage');
      const main = toUsage(await session.send('Runtime.getHeapUsage'));
      if (workerSession === undefined) return { main, worker: undefined };
      await sendToWorker(workerSession, 'HeapProfiler.collectGarbage');
      const result = await sendToWorker(workerSession, 'Runtime.getHeapUsage');
      if (!isHeapUsageResult(result)) throw new Error('Runtime.getHeapUsage: unexpected reply');
      return { main, worker: toUsage(result) };
    },
  };
}
