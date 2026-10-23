import { type ColumnBatch, createEventStore, type StreamCounters } from '@lsv/core';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FromWorkerMessage } from '@/entities/log-stream';
import { FakeWorker, testBatch, testHello } from '@/shared/lib/testing';
import { TooltipProvider } from '@/shared/ui/tooltip';

import { StreamPage } from './StreamPage';

function counters(overrides: Partial<StreamCounters> = {}): StreamCounters {
  return { received: 0, eventsPerSecond: 0, missed: 0, dropped: 0, invalidFrames: 0, ...overrides };
}

/** Renders the page inside the tooltip provider that `App` mounts. */
function renderPage() {
  return render(
    <TooltipProvider delayDuration={0}>
      <StreamPage />
    </TooltipProvider>,
  );
}

/** Encodes `testBatch(seqs)` as the stream worker posts it, positions continuing per source. */
function createSource() {
  const store = createEventStore({ capacity: 1000, keepPayload: true });
  return (seqs: readonly number[]): ColumnBatch => {
    store.appendEvents(testBatch(seqs).events);
    const batch = store.takeColumnBatch();
    if (batch === undefined) throw new Error('No rows to encode');
    return batch;
  };
}

function workerAt(index: number): FakeWorker {
  const worker = FakeWorker.instances[index];
  if (worker === undefined) throw new Error(`No Worker #${String(index)} was created`);
  return worker;
}

/** The session the page last started in `worker`. */
function sessionOf(worker: FakeWorker): number {
  const start = worker
    .messages()
    .findLast(
      (message): message is { type: 'start'; session: number } =>
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'start',
    );
  if (start === undefined) throw new Error('The page has not started a stream');
  return start.session;
}

/** Answers for the stream worker; the session of `message` is replaced by the one the page started. */
function post(worker: FakeWorker, message: FromWorkerMessage): void {
  act(() => {
    worker.receive({ ...message, session: sessionOf(worker) });
  });
}

function hello(worker: FakeWorker): void {
  const { stream, limits, expiresAt } = testHello();
  post(worker, { type: 'hello', session: 0, stream, limits, expiresAt });
}

/** Renders the page and lets its (fake) worker report the server's `hello`. */
async function renderConnected() {
  const view = renderPage();
  const worker = FakeWorker.latest();
  hello(worker);
  await screen.findByText('Connected');
  return { ...view, worker };
}

/** The number shown by the counter named `name`. */
function counter(name: string): string | null {
  return within(screen.getByRole('group', { name })).getByText(/^[\d,]+$/).textContent;
}

describe('StreamPage', () => {
  beforeEach(() => {
    FakeWorker.reset();
    vi.stubGlobal('Worker', FakeWorker);
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts the stream worker with the settings and buffer size from the page URL', () => {
    window.history.replaceState(
      null,
      '',
      '/?rate=500&scenario=error-burst&seed=7&buffer=250000&utm_source=x',
    );

    renderPage();

    const worker = FakeWorker.latest();
    expect(worker.url).toMatch(/stream\.worker\.ts/);
    expect(worker.options).toMatchObject({ type: 'module' });
    expect(worker.messages()).toEqual([
      {
        type: 'start',
        session: 1,
        endpoint: 'ws://localhost:8787/ws',
        request: { rate: 500, scenario: 'error-burst', seed: 7 },
        capacity: 250_000,
      },
    ]);
  });

  it('announces the connection status from connecting to connected', async () => {
    renderPage();
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Connecting…');

    hello(FakeWorker.latest());

    expect(await within(status).findByText('Connected')).toBeInTheDocument();
    expect(
      screen.getByText(/Scenario steady at 200 events\/s, seed 42/, { exact: false }),
    ).toBeInTheDocument();
  });

  it('explains why the stream closed', async () => {
    const { worker } = await renderConnected();

    post(worker, {
      type: 'closed',
      session: 0,
      code: 4029,
      reason: 'busy; retry-after=30',
      counters: counters(),
    });

    const status = screen.getByRole('status');
    expect(await within(status).findByText('Closed: Server busy')).toBeInTheDocument();
    expect(status).toHaveTextContent('Reload the page to retry after 30 s.');
  });

  it('shows a stream worker that failed in the status, not as a crash', async () => {
    renderPage();

    act(() => {
      FakeWorker.latest().fail('Script error');
    });

    const status = screen.getByRole('status');
    expect(await within(status).findByText('Closed: Cannot open the connection')).toBeVisible();
    expect(status).toHaveTextContent('The stream worker failed: Script error');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps one live worker through the StrictMode double mount', async () => {
    // StrictMode outermost, as in main.tsx: nested inside the provider, the effects ran only once here.
    const { unmount } = render(
      <StrictMode>
        <TooltipProvider delayDuration={0}>
          <StreamPage />
        </TooltipProvider>
      </StrictMode>,
    );
    expect(FakeWorker.instances).toHaveLength(2);
    const [first, second] = [workerAt(0), workerAt(1)];

    // The first effect's cleanup stopped and terminated its worker: it delivers nothing more.
    expect(first.messages().at(-1)).toMatchObject({ type: 'stop' });
    expect(first.terminated).toBe(true);

    const encode = createSource();
    hello(second);
    post(second, {
      type: 'batch',
      session: 0,
      columns: encode([1, 2]),
      counters: counters({ received: 2 }),
    });
    await waitFor(() => {
      expect(counter('Events received')).toBe('2');
    });
    expect(screen.getByRole('status')).toHaveTextContent('Connected');
    expect(second.terminated).toBe(false);

    unmount();
    expect(second.terminated).toBe(true);
  });

  it('shows the counters and lists the events in the table', async () => {
    const { worker } = await renderConnected();
    const encode = createSource();

    post(worker, {
      type: 'batch',
      session: 0,
      columns: encode([1, 2, 3]),
      counters: counters({ received: 3, eventsPerSecond: 60 }),
    });
    post(worker, {
      type: 'batch',
      session: 0,
      columns: encode([6, 7]),
      counters: counters({ received: 5, eventsPerSecond: 100, missed: 2, dropped: 1 }),
    });

    await waitFor(() => {
      expect(counter('Events received')).toBe('5');
    });
    expect(counter('Missed events')).toBe('2');
    expect(counter('Dropped by server')).toBe('1');
    expect(counter('Invalid frames')).toBe('0');
    expect(counter('Events per second')).toBe('100');
    // jsdom has no layout, so the grid renders no rows; its row count still covers every event.
    expect(screen.getByRole('grid', { name: 'Events' })).toHaveAttribute('aria-rowcount', '6');
  });

  it('counts invalid frames without dropping the connection', async () => {
    const { worker } = await renderConnected();

    post(worker, { type: 'counters', session: 0, counters: counters({ invalidFrames: 1 }) });

    await waitFor(() => {
      expect(counter('Invalid frames')).toBe('1');
    });
    expect(screen.getByRole('status')).toHaveTextContent('Connected');
  });

  it('terminates the stream worker when the page unmounts', async () => {
    const { worker, unmount } = await renderConnected();

    unmount();

    expect(worker.terminated).toBe(true);
  });

  it('switches the colour theme from the header', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('radio', { name: 'Dark' }));

    expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('freezes the table while paused and shows every event received meanwhile on resume', async () => {
    const user = userEvent.setup();
    const { worker } = await renderConnected();
    const encode = createSource();
    const grid = screen.getByRole('grid', { name: 'Events' });
    post(worker, {
      type: 'batch',
      session: 0,
      columns: encode([1, 2, 3]),
      counters: counters({ received: 3 }),
    });
    await waitFor(() => {
      expect(grid).toHaveAttribute('aria-rowcount', '4');
    });

    await user.click(screen.getByRole('button', { name: 'Pause stream' }));
    post(worker, {
      type: 'batch',
      session: 0,
      columns: encode([4, 5]),
      counters: counters({ received: 5 }),
    });
    await waitFor(() => {
      expect(counter('Events received')).toBe('5');
    });
    expect(screen.getByText('2 new events')).toBeVisible();
    // jsdom has no layout, so the grid renders no rows; its row count shows what it lists.
    expect(grid).toHaveAttribute('aria-rowcount', '4');

    post(worker, {
      type: 'batch',
      session: 0,
      columns: encode([6, 7, 8, 9]),
      counters: counters({ received: 9 }),
    });
    expect(await screen.findByText('6 new events')).toBeVisible();
    expect(grid).toHaveAttribute('aria-rowcount', '4');

    await user.click(screen.getByRole('button', { name: 'Resume' }));

    expect(grid).toHaveAttribute('aria-rowcount', '10');
    expect(screen.queryByText(/new events$/)).not.toBeInTheDocument();
  });

  it('pauses with the P key, but not while typing a rate', async () => {
    const user = userEvent.setup();
    await renderConnected();
    const pause = screen.getByRole('button', { name: 'Pause stream' });
    const rate = screen.getByRole('spinbutton', { name: 'Exact rate, events per second' });

    await user.type(rate, 'p');
    expect(pause).toHaveAttribute('aria-pressed', 'false');

    await user.click(screen.getByRole('heading', { name: 'Log Stream Viewer' }));
    await user.keyboard('p');
    expect(pause).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('0 new events')).toBeVisible();
  });
});
