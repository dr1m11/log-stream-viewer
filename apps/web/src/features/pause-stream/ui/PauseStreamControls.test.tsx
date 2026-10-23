import { type ColumnBatch, createEventStore, type StreamCounters } from '@lsv/core';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { type LogStreamStore, useLogStreamStore } from '@/entities/log-stream';
import { FakeWorker, testBatch, testHello } from '@/shared/lib/testing';
import { TooltipProvider } from '@/shared/ui/tooltip';

import { PauseStreamControls } from './PauseStreamControls';

const CAPACITY = 1000;

function counters(received: number): StreamCounters {
  return { received, eventsPerSecond: 0, missed: 0, dropped: 0, invalidFrames: 0 };
}

/** The store the harness created, for assertions on its snapshot. */
let currentStore: LogStreamStore | undefined;

function Harness({ withControls = true }: { withControls?: boolean }) {
  const store = useLogStreamStore(() => ({
    endpoint: 'ws://localhost:8787/ws',
    request: {},
    capacity: CAPACITY,
    spawnWorker: () => new FakeWorker(),
  }));
  useEffect(() => {
    currentStore = store;
  }, [store]);
  return (
    <TooltipProvider delayDuration={0}>
      <label>
        Notes <input type="text" />
      </label>
      {withControls && <PauseStreamControls store={store} />}
    </TooltipProvider>
  );
}

function store(): LogStreamStore {
  if (currentStore === undefined) throw new Error('The harness has not rendered');
  return currentStore;
}

/**
 * Renders the controls on a connected stream; `receive(n)` lets the worker post `n` more events
 * and waits for the animation frame that publishes them.
 */
function renderConnected() {
  const view = render(<Harness />);
  const worker = FakeWorker.latest();
  const source = createEventStore({ capacity: CAPACITY, keepPayload: true });
  let nextSeq = 1;
  const { stream, limits, expiresAt } = testHello();
  act(() => {
    worker.receive({ type: 'hello', session: 1, stream, limits, expiresAt });
  });
  return {
    ...view,
    receive: async (count: number): Promise<void> => {
      const seqs = Array.from({ length: count }, (_, index) => nextSeq + index);
      nextSeq += count;
      source.appendEvents(testBatch(seqs).events);
      const columns: ColumnBatch | undefined = source.takeColumnBatch();
      act(() => {
        worker.receive({ type: 'batch', session: 1, columns, counters: counters(nextSeq - 1) });
      });
      await waitFor(() => {
        expect(store().getSnapshot().end).toBe(nextSeq - 1);
      });
    },
  };
}

function toggle(): HTMLElement {
  return screen.getByRole('button', { name: 'Pause stream' });
}

describe('PauseStreamControls', () => {
  beforeEach(() => {
    FakeWorker.reset();
    currentStore = undefined;
  });

  it('pauses with the toggle and counts the new events until Resume', async () => {
    const user = userEvent.setup();
    const { receive } = renderConnected();
    await receive(20);
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');

    await user.click(toggle());

    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('0 new events')).toBeVisible();
    await receive(1);
    expect(await screen.findByText('1 new event')).toBeVisible();
    await receive(499);
    expect(await screen.findByText('500 new events')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Resume' }));

    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText(/new events?$/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
    // The Resume button is gone; the focus stays on the toggle next to it.
    expect(toggle()).toHaveFocus();
    expect(store().getSnapshot().paused).toBeUndefined();
  });

  it('resumes with the toggle as well', async () => {
    const user = userEvent.setup();
    renderConnected();

    await user.click(toggle());
    await user.click(toggle());

    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    expect(store().getSnapshot().paused).toBeUndefined();
  });

  it('shows the shortcut in the tooltip', async () => {
    const user = userEvent.setup();
    renderConnected();

    await user.hover(toggle());

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Pause stream P');
    expect(within(tooltip).getByText('P').tagName).toBe('KBD');
    expect(toggle()).toHaveAttribute('aria-keyshortcuts', 'P');
  });

  it('toggles with P anywhere on the page, but not while typing in a field', async () => {
    const user = userEvent.setup();
    renderConnected();

    await user.keyboard('p');
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');

    const notes = screen.getByRole('textbox', { name: 'Notes' });
    await user.type(notes, 'pp');
    expect(notes).toHaveValue('pp');
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');

    await user.click(document.body);
    await user.keyboard('P');
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');

    // Ctrl+P is the browser's print command.
    await user.keyboard('{Control>}p{/Control}');
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
  });

  it('stops listening for the shortcut when it unmounts', async () => {
    const user = userEvent.setup();
    const { rerender } = renderConnected();

    rerender(<Harness withControls={false} />);
    await user.keyboard('p');

    expect(store().getSnapshot().paused).toBeUndefined();
  });

  it('warns once the full buffer evicts rows of the paused view, and announces it once', async () => {
    const user = userEvent.setup();
    const { receive } = renderConnected();
    await receive(CAPACITY);
    await user.click(toggle());
    const announcement = screen.getByText('Stream view paused. New events are kept in the buffer.');
    expect(screen.queryByText(/evicted while paused/)).not.toBeInTheDocument();

    await receive(300);

    expect(
      await screen.findByText('300 older events evicted while paused — the buffer is full'),
    ).toBeVisible();
    expect(screen.getByText('300 new events')).toBeVisible();
    expect(announcement).toHaveTextContent(
      'The buffer is full: older events are evicted while the stream view is paused.',
    );
    expect(announcement).toHaveAttribute('aria-live', 'polite');

    await receive(200);
    expect(
      await screen.findByText('500 older events evicted while paused — the buffer is full'),
    ).toBeVisible();
    // The live region keeps its text while the count grows, so it is spoken once.
    expect(announcement).toHaveTextContent(
      'The buffer is full: older events are evicted while the stream view is paused.',
    );

    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(screen.queryByText(/evicted while paused/)).not.toBeInTheDocument();
    expect(announcement).toHaveTextContent('Stream view resumed.');
  });
});
