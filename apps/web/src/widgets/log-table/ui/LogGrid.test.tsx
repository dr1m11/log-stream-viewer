import { createEventStore, type EventStore } from '@lsv/core';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { testLogEvent } from '@/shared/lib/testing';

import { HEADER_HEIGHT, ROW_HEIGHT } from '../lib/table-scroll';
import { LogGrid } from './LogGrid';

/** Height of the grid's scroll viewport in the fake layout, header included. */
const VIEWPORT_HEIGHT = 312;
/** Rows below the sticky header: (312 - 32) / 28. */
const ROWS_IN_VIEW = 10;

/** The current viewport height of the fake layout; a test may resize it. */
let viewportHeight = VIEWPORT_HEIGHT;

/**
 * Resize observers created by the code under test (the virtualizer watches the grid). jsdom has
 * none; `resizeObservers()` reports a new size to all of them, as the browser would.
 */
const resizeCallbacks = new Set<() => void>();

class FakeResizeObserver implements ResizeObserver {
  readonly #notify: () => void;

  constructor(callback: ResizeObserverCallback) {
    this.#notify = () => {
      callback([], this);
    };
  }
  observe(): void {
    resizeCallbacks.add(this.#notify);
  }
  unobserve(): void {
    resizeCallbacks.delete(this.#notify);
  }
  disconnect(): void {
    resizeCallbacks.delete(this.#notify);
  }
}

function resizeViewport(height: number): void {
  viewportHeight = height;
  act(() => {
    for (const notify of resizeCallbacks) notify();
  });
}

/**
 * jsdom has no layout. Gives the grid (the scroll element) a viewport, a content height derived
 * from its `aria-rowcount` and a `scrollTop` that the browser would clamp; every other element
 * keeps jsdom's zeros.
 */
function installGridLayout(): void {
  const scrollTops = new WeakMap<Element, number>();
  const isGrid = (element: Element): boolean => element.getAttribute('role') === 'grid';
  const contentHeight = (element: Element): number =>
    HEADER_HEIGHT + (Number(element.getAttribute('aria-rowcount')) - 1) * ROW_HEIGHT;
  const maxScrollTop = (element: Element): number =>
    Math.max(0, contentHeight(element) - viewportHeight);

  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
    return isGrid(this) ? viewportHeight : 0;
  });
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
    return isGrid(this) ? 800 : 0;
  });
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) {
    return isGrid(this) ? Math.max(viewportHeight, contentHeight(this)) : 0;
  });
  vi.spyOn(Element.prototype, 'scrollTop', 'get').mockImplementation(function (this: Element) {
    return scrollTops.get(this) ?? 0;
  });
  vi.spyOn(Element.prototype, 'scrollTop', 'set').mockImplementation(function (
    this: Element,
    value: number,
  ) {
    scrollTops.set(this, isGrid(this) ? Math.min(Math.max(0, value), maxScrollTop(this)) : 0);
  });
}

/** A buffer of `capacity` events whose `seq` (and message, "event <seq>") starts at 1. */
function createBuffer(capacity: number) {
  const buffer = createEventStore({ capacity, keepPayload: false });
  let seq = 0;
  return {
    buffer,
    /** Appends `count` events, evicting the oldest ones past the capacity. */
    append: (count: number): void => {
      buffer.appendEvents(Array.from({ length: count }, () => testLogEvent(++seq)));
    },
  };
}

function renderGrid(buffer: EventStore) {
  const view = render(<LogGrid buffer={buffer} start={buffer.start} end={buffer.end} />);
  return {
    ...view,
    grid: screen.getByRole('grid', { name: 'Events' }),
    /** Renders the grid again with the buffer's current range, as a new snapshot would. */
    update: (): void => {
      view.rerender(<LogGrid buffer={buffer} start={buffer.start} end={buffer.end} />);
    },
  };
}

/** The data rows in the DOM, oldest first (the header row is the first row). */
function dataRows(grid: HTMLElement): HTMLElement[] {
  return within(grid).getAllByRole('row').slice(1);
}

function maxScrollTop(grid: HTMLElement): number {
  return grid.scrollHeight - grid.clientHeight;
}

/** The user scrolls the grid to `top` (user-event cannot scroll). */
function scrollTo(grid: HTMLElement, top: number): void {
  act(() => {
    grid.scrollTop = top;
    fireEvent.scroll(grid);
  });
}

function activeRow(grid: HTMLElement): HTMLElement | null {
  const id = grid.getAttribute('aria-activedescendant');
  return id === null ? null : document.getElementById(id);
}

describe('LogGrid', () => {
  beforeEach(() => {
    viewportHeight = VIEWPORT_HEIGHT;
    resizeCallbacks.clear();
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    installGridLayout();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows a waiting message until the first event arrives', () => {
    const { buffer } = createBuffer(100);

    const { grid } = renderGrid(buffer);

    expect(screen.getByText('Waiting for events…')).toBeVisible();
    expect(grid).toHaveAttribute('aria-rowcount', '1');
    expect(
      within(grid)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Time', 'Level', 'Service', 'Message']);
  });

  it('renders only the rows in view of a 100,000-event buffer, at the newest event', () => {
    const { buffer, append } = createBuffer(100_000);
    append(100_000);

    const { grid } = renderGrid(buffer);

    expect(grid).toHaveAttribute('aria-rowcount', '100001');
    expect(grid).toHaveAttribute('aria-colcount', '4');
    const rows = dataRows(grid);
    expect(rows.length).toBeGreaterThanOrEqual(ROWS_IN_VIEW);
    expect(rows.length).toBeLessThan(40);
    const newest = rows.at(-1);
    expect(newest).toHaveAttribute('aria-rowindex', '100001');
    expect(newest).toHaveTextContent('event 100000');
    expect(within(newest ?? grid).getAllByRole('gridcell')).toHaveLength(4);
    expect(grid.scrollTop).toBe(maxScrollTop(grid));
    expect(screen.queryByText('Waiting for events…')).not.toBeInTheDocument();
  });

  it('shows the time, level, service and message of each event', () => {
    const { buffer } = createBuffer(100);
    buffer.appendEvents([testLogEvent(1, { level: 'error', service: 'payments' })]);

    const { grid } = renderGrid(buffer);

    const [time, level, service, message] = within(grid).getAllByRole('gridcell');
    expect(time?.querySelector('time')).toHaveAttribute(
      'dateTime',
      new Date(testLogEvent(1).ts).toISOString(),
    );
    expect(time).toHaveTextContent(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
    expect(level).toHaveTextContent('error');
    expect(service).toHaveTextContent('payments');
    expect(message).toHaveTextContent('event 1');
    expect(message).toHaveAttribute('title', 'event 1');
  });

  it('follows the tail as events arrive', () => {
    const { buffer, append } = createBuffer(1000);
    append(50);
    const { grid, update } = renderGrid(buffer);

    append(70);
    update();

    expect(dataRows(grid).at(-1)).toHaveTextContent('event 120');
    expect(grid.scrollTop).toBe(maxScrollTop(grid));
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();

    // Once the buffer is full every batch evicts as many rows as it adds; the tail stays in view.
    append(2000);
    update();
    expect(dataRows(grid).at(-1)).toHaveTextContent('event 2120');
    expect(grid.scrollTop).toBe(maxScrollTop(grid));
  });

  it('stops following when the user scrolls up, and Jump to latest resumes it', async () => {
    const user = userEvent.setup();
    const { buffer, append } = createBuffer(1000);
    append(200);
    const { grid, update } = renderGrid(buffer);

    scrollTo(grid, 0);
    append(50);
    update();

    expect(grid.scrollTop).toBe(0);
    expect(dataRows(grid)[0]).toHaveTextContent('event 1');
    const jump = screen.getByRole('button', { name: 'Jump to latest' });

    await user.click(jump);

    expect(grid.scrollTop).toBe(maxScrollTop(grid));
    expect(dataRows(grid).at(-1)).toHaveTextContent('event 250');
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();
    expect(grid).toHaveFocus();
  });

  it('stops following on a wheel step up, even before the grid moves', () => {
    const { buffer, append } = createBuffer(1000);
    append(200);
    const { grid } = renderGrid(buffer);

    fireEvent.wheel(grid, { deltaY: -40 });

    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
  });

  it('resumes following when the user scrolls back down to the bottom', () => {
    const { buffer, append } = createBuffer(1000);
    append(200);
    const { grid, update } = renderGrid(buffer);
    scrollTo(grid, 1000);
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeVisible();

    scrollTo(grid, maxScrollTop(grid));
    append(10);
    update();

    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();
    expect(dataRows(grid).at(-1)).toHaveTextContent('event 210');
  });

  it('keeps the rows in view in place while old rows are evicted', () => {
    const { buffer, append } = createBuffer(1000);
    append(1000);
    const { grid, update } = renderGrid(buffer);
    // Position 500 ("event 501") at the top of the viewport.
    scrollTo(grid, 500 * ROW_HEIGHT);

    append(120);
    update();

    expect(buffer.start).toBe(120);
    expect(grid.scrollTop).toBe((500 - 120) * ROW_HEIGHT);
    expect(within(grid).getByText('event 501')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
  });

  it('keeps the DOM nodes and a text selection of the rows in view while old rows are evicted', () => {
    const { buffer, append } = createBuffer(1000);
    append(1000);
    const { grid, update } = renderGrid(buffer);
    scrollTo(grid, 500 * ROW_HEIGHT);
    const message = within(grid).getByText('event 501');
    const row = message.closest('[role="row"]');
    const selection = window.getSelection();
    selection?.selectAllChildren(message);
    expect(selection?.toString()).toBe('event 501');

    append(120);
    update();

    expect(within(grid).getByText('event 501')).toBe(message);
    expect(message.closest('[role="row"]')).toBe(row);
    expect(message).toBeInTheDocument();
    expect(selection?.toString()).toBe('event 501');
  });

  it('stops at the oldest row when the rows in view were evicted', () => {
    const { buffer, append } = createBuffer(1000);
    append(1000);
    const { grid, update } = renderGrid(buffer);
    scrollTo(grid, 50 * ROW_HEIGHT);

    append(300);
    update();

    expect(grid.scrollTop).toBe(0);
    expect(dataRows(grid)[0]).toHaveTextContent('event 301');
  });

  it('moves the active row with the keyboard and keeps it in view', async () => {
    const user = userEvent.setup();
    const { buffer, append } = createBuffer(1000);
    append(300);
    const { grid } = renderGrid(buffer);
    await user.tab();
    expect(grid).toHaveFocus();
    expect(grid).not.toHaveAttribute('aria-activedescendant');

    // While following, the first arrow key activates the newest row.
    await user.keyboard('{ArrowUp}');
    expect(activeRow(grid)).toHaveTextContent('event 300');

    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(activeRow(grid)).toHaveTextContent('event 298');
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeVisible();

    // A page is the rows in view minus one.
    await user.keyboard('{PageUp}');
    expect(activeRow(grid)).toHaveTextContent(`event ${String(298 - (ROWS_IN_VIEW - 1))}`);

    await user.keyboard('{Home}');
    expect(activeRow(grid)).toHaveTextContent('event 1');
    expect(activeRow(grid)).toHaveAttribute('aria-rowindex', '2');
    expect(grid.scrollTop).toBe(0);

    await user.keyboard('{PageDown}{ArrowDown}');
    expect(activeRow(grid)).toHaveTextContent(`event ${String(1 + ROWS_IN_VIEW)}`);
    expect(grid.scrollTop).toBe(ROW_HEIGHT);

    await user.keyboard('{End}');
    expect(activeRow(grid)).toHaveTextContent('event 300');
    expect(grid.scrollTop).toBe(maxScrollTop(grid));
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();
  });

  it('ignores sideways wheel pans and Ctrl+wheel zoom', () => {
    const { buffer, append } = createBuffer(1000);
    append(200);
    const { grid } = renderGrid(buffer);

    fireEvent.wheel(grid, { deltaX: -80, deltaY: -10 });
    fireEvent.wheel(grid, { deltaY: -40, ctrlKey: true });

    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();
  });

  it('keeps the newest row in view when the viewport resizes while following', () => {
    const { buffer, append } = createBuffer(1000);
    append(200);
    const { grid } = renderGrid(buffer);

    resizeViewport(200);

    expect(grid.scrollTop).toBe(maxScrollTop(grid));
    expect(dataRows(grid).at(-1)).toHaveTextContent('event 200');
  });

  it('holds the view on a row the user clicks while following', async () => {
    const user = userEvent.setup();
    const { buffer, append } = createBuffer(1000);
    append(200);
    const { grid, update } = renderGrid(buffer);

    await user.click(within(grid).getByText('event 195'));
    append(50);
    update();

    expect(activeRow(grid)).toHaveTextContent('event 195');
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
    expect(grid.scrollTop).toBeLessThan(maxScrollTop(grid));
  });

  it('activates the row the user clicks', async () => {
    const user = userEvent.setup();
    const { buffer, append } = createBuffer(1000);
    append(30);
    const { grid } = renderGrid(buffer);

    await user.click(within(grid).getByText('event 25'));

    expect(grid).toHaveFocus();
    expect(activeRow(grid)).toHaveTextContent('event 25');
  });

  it('drops the active descendant while the active row is scrolled out of the DOM', async () => {
    const user = userEvent.setup();
    const { buffer, append } = createBuffer(1000);
    append(300);
    const { grid } = renderGrid(buffer);
    await user.tab();
    await user.keyboard('{Home}');

    scrollTo(grid, maxScrollTop(grid));

    expect(grid).not.toHaveAttribute('aria-activedescendant');
  });

  it('starts over at the tail with a new buffer', async () => {
    const user = userEvent.setup();
    const first = createBuffer(1000);
    first.append(300);
    const view = renderGrid(first.buffer);
    await user.tab();
    await user.keyboard('{Home}');
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeVisible();

    const second = createBuffer(1000);
    second.append(40);
    view.rerender(
      <LogGrid buffer={second.buffer} start={second.buffer.start} end={second.buffer.end} />,
    );

    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();
    expect(view.grid).not.toHaveAttribute('aria-activedescendant');
    expect(dataRows(view.grid).at(-1)).toHaveTextContent('event 40');
  });

  describe('paused', () => {
    /** Renders the grid like `LogTable`: while paused, `end` holds at `pausedEnd`. */
    function renderPausable(buffer: EventStore) {
      const props = (pausedEnd: number | undefined) => ({
        buffer,
        start: buffer.start,
        end: pausedEnd === undefined ? buffer.end : Math.max(buffer.start, pausedEnd),
        paused: pausedEnd !== undefined,
      });
      const view = render(<LogGrid {...props(undefined)} />);
      return {
        grid: screen.getByRole('grid', { name: 'Events' }),
        /** A new snapshot: paused at `pausedEnd`, or following the stream without it. */
        update: (pausedEnd?: number): void => {
          view.rerender(<LogGrid {...props(pausedEnd)} />);
        },
      };
    }

    it('holds the rows in view while events arrive and old ones are evicted', () => {
      const { buffer, append } = createBuffer(1000);
      append(1000);
      const { grid, update } = renderPausable(buffer);
      update(1000);
      const newest = within(grid).getByText('event 1000');

      append(120);
      update(1000);

      expect(grid).toHaveAttribute('aria-rowcount', String(1000 - 120 + 1));
      expect(dataRows(grid).at(-1)).toHaveTextContent('event 1000');
      expect(within(grid).getByText('event 1000')).toBe(newest);
      expect(grid.scrollTop).toBe(maxScrollTop(grid));
      expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();
    });

    it('keeps a position the user scrolled to while paused', () => {
      const { buffer, append } = createBuffer(1000);
      append(1000);
      const { grid, update } = renderPausable(buffer);
      update(1000);
      scrollTo(grid, 500 * ROW_HEIGHT);

      append(100);
      update(1000);

      expect(grid.scrollTop).toBe(400 * ROW_HEIGHT);
      expect(dataRows(grid).some((row) => row.textContent.includes('event 501'))).toBe(true);
    });

    it('jumps to the newest row and follows again on resume', () => {
      const { buffer, append } = createBuffer(1000);
      append(500);
      const { grid, update } = renderPausable(buffer);
      update(500);
      scrollTo(grid, 0);
      append(200);
      update(500);
      expect(dataRows(grid)[0]).toHaveTextContent('event 1');

      update();

      expect(grid).toHaveAttribute('aria-rowcount', '701');
      expect(dataRows(grid).at(-1)).toHaveTextContent('event 700');
      expect(grid.scrollTop).toBe(maxScrollTop(grid));

      append(30);
      update();
      expect(dataRows(grid).at(-1)).toHaveTextContent('event 730');
      expect(grid.scrollTop).toBe(maxScrollTop(grid));
    });

    it('says why the paused view is empty once eviction passed the pause point', () => {
      const { buffer, append } = createBuffer(1000);
      append(1000);
      const { grid, update } = renderPausable(buffer);
      update(1000);

      append(1200);
      update(1000);

      expect(grid).toHaveAttribute('aria-rowcount', '1');
      expect(
        screen.getByText('Paused: no events to show. Resume to see the newest.'),
      ).toBeVisible();
      expect(screen.queryByText('Waiting for events…')).not.toBeInTheDocument();
    });
  });
});
