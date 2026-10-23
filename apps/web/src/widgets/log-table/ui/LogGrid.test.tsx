import { createEventStore, type EventStore } from '@lsv/core';
import type { LogEvent } from '@lsv/protocol';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LogEventDetails } from '@/entities/log-stream';
import { testLogEvent } from '@/shared/lib/testing';
import { TooltipProvider } from '@/shared/ui/tooltip';

import { truncatedNote } from '../lib/payload-note';
import { HEADER_HEIGHT, ROW_HEIGHT } from '../lib/table-scroll';
import { EVICTED_TEXT, type GetEventDetails, NO_PAYLOAD_TEXT } from './EventDetails';
import { LogGrid } from './LogGrid';

/** Height of the grid's scroll viewport in the fake layout, header included. */
const VIEWPORT_HEIGHT = 312;
/** Rows below the sticky header: (312 - 32) / 28. */
const ROWS_IN_VIEW = 10;

/** The current viewport height of the fake layout; a test may resize it. */
let viewportHeight = VIEWPORT_HEIGHT;
/** Height of an open row's details in the fake layout. */
const DETAILS_HEIGHT = 200;

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
 * jsdom has no layout. Gives the grid (the scroll element) a viewport, a content height of the
 * header plus the height the grid gives its rows' container, and a `scrollTop` that the browser
 * would clamp; an open row's details are {@link DETAILS_HEIGHT} tall. Every other element keeps
 * jsdom's zeros.
 */
function installGridLayout(): void {
  const scrollTops = new WeakMap<Element, number>();
  const isGrid = (element: Element): boolean => element.getAttribute('role') === 'treegrid';
  const contentHeight = (element: Element): number => {
    // The container of the data rows' rowgroup (the first rowgroup is the sticky header).
    const rows = element.querySelectorAll('[role="rowgroup"]')[1]?.parentElement;
    return HEADER_HEIGHT + Number.parseFloat(rows?.style.height ?? '0');
  };
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
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.hasAttribute('data-details') ? DETAILS_HEIGHT : 0;
  });
  vi.spyOn(Element.prototype, 'scrollTop', 'set').mockImplementation(function (
    this: Element,
    value: number,
  ) {
    scrollTops.set(this, isGrid(this) ? Math.min(Math.max(0, value), maxScrollTop(this)) : 0);
  });
}

/** The event with `seq`, as the stream would send it: with a small payload and a trace id. */
function streamEvent(seq: number): LogEvent {
  return testLogEvent(seq, {
    traceId: `trace-${String(seq)}`,
    payload: { orderId: `o-${String(seq)}` },
  });
}

/**
 * A buffer of `capacity` events whose `seq` (and message, "event <seq>") starts at 1, so the
 * event at position `p` has `seq` `p + 1`.
 */
function createBuffer(capacity: number) {
  const buffer = createEventStore({ capacity, keepPayload: false });
  let seq = 0;
  return {
    buffer,
    /** Appends `count` events, evicting the oldest ones past the capacity. */
    append: (count: number): void => {
      buffer.appendEvents(Array.from({ length: count }, () => streamEvent(++seq)));
    },
  };
}

/** What the worker answers for `event`: its fields, and its payload pretty-printed. */
function detailsOf(event: LogEvent): LogEventDetails {
  const { payload, ...fields } = event;
  if (payload === undefined) return { event: fields, payload: undefined };
  const text = JSON.stringify(payload, null, 2);
  return { event: fields, payload: { text, truncated: false, length: text.length } };
}

/** Answers like the worker's buffer that holds every event appended (position `p`, `seq` `p + 1`). */
const fetchEvent: GetEventDetails = (position) =>
  Promise.resolve(detailsOf(streamEvent(position + 1)));

function withTooltips(ui: ReactElement): ReactElement {
  return <TooltipProvider delayDuration={0}>{ui}</TooltipProvider>;
}

function renderGrid(buffer: EventStore, getEventDetails: GetEventDetails = fetchEvent) {
  const grid = (): ReactElement =>
    withTooltips(
      <LogGrid
        buffer={buffer}
        start={buffer.start}
        end={buffer.end}
        getEventDetails={getEventDetails}
      />,
    );
  const view = render(grid());
  return {
    ...view,
    grid: screen.getByRole('treegrid', { name: 'Events' }),
    /** Renders the grid again with the buffer's current range, as a new snapshot would. */
    update: (): void => {
      view.rerender(grid());
    },
  };
}

/** The event rows in the DOM, oldest first: level 1 (not the header, not a details row). */
function dataRows(grid: HTMLElement): HTMLElement[] {
  return within(grid)
    .getAllByRole('row')
    .filter((row) => row.getAttribute('aria-level') === '1');
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
    ).toEqual(['Details', 'Time', 'Level', 'Service', 'Message']);
  });

  it('renders only the rows in view of a 100,000-event buffer, at the newest event', () => {
    const { buffer, append } = createBuffer(100_000);
    append(100_000);

    const { grid } = renderGrid(buffer);

    expect(grid).toHaveAttribute('aria-rowcount', '100001');
    expect(grid).toHaveAttribute('aria-colcount', '5');
    const rows = dataRows(grid);
    expect(rows.length).toBeGreaterThanOrEqual(ROWS_IN_VIEW);
    expect(rows.length).toBeLessThan(40);
    const newest = rows.at(-1);
    expect(newest).toHaveAttribute('aria-rowindex', '100001');
    expect(newest).toHaveTextContent('event 100000');
    expect(within(newest ?? grid).getAllByRole('gridcell')).toHaveLength(5);
    expect(grid.scrollTop).toBe(maxScrollTop(grid));
    expect(screen.queryByText('Waiting for events…')).not.toBeInTheDocument();
  });

  it('shows the time, level, service and message of each event', () => {
    const { buffer } = createBuffer(100);
    buffer.appendEvents([testLogEvent(1, { level: 'error', service: 'payments' })]);

    const { grid } = renderGrid(buffer);

    const [, time, level, service, message] = within(grid).getAllByRole('gridcell');
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
      withTooltips(
        <LogGrid
          buffer={second.buffer}
          start={second.buffer.start}
          end={second.buffer.end}
          getEventDetails={fetchEvent}
        />,
      ),
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
      const view = render(
        withTooltips(<LogGrid {...props(undefined)} getEventDetails={fetchEvent} />),
      );
      return {
        grid: screen.getByRole('treegrid', { name: 'Events' }),
        /** A new snapshot: paused at `pausedEnd`, or following the stream without it. */
        update: (pausedEnd?: number): void => {
          view.rerender(
            withTooltips(<LogGrid {...props(pausedEnd)} getEventDetails={fetchEvent} />),
          );
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

    it('does not track the tail while paused, even after a click on the last row or End', async () => {
      const user = userEvent.setup();
      const { buffer, append } = createBuffer(1000);
      append(1000);
      const { grid, update } = renderPausable(buffer);
      update(1000);

      await user.click(within(grid).getByText('event 1000'));
      append(100);
      update(1000);
      const newest = within(grid).getByText('event 1000');
      expect(activeRow(grid)).toHaveTextContent('event 1000');

      await user.keyboard('{End}');
      scrollTo(grid, maxScrollTop(grid));
      append(100);
      update(1000);

      // Keyed by position and anchored: the newest row keeps its element as `start` grows.
      expect(within(grid).getByText('event 1000')).toBe(newest);
      expect(dataRows(grid).at(-1)).toHaveTextContent('event 1000');
      expect(grid.scrollTop).toBe(maxScrollTop(grid));
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

    it('keeps open details in place, with their DOM node, while paused and evicting', async () => {
      const user = userEvent.setup();
      const { buffer, append } = createBuffer(1000);
      append(1000);
      const { grid, update } = renderPausable(buffer);
      update(1000);
      // Event 501 (position 500) at the top of the view; open event 505 in view.
      scrollTo(grid, 500 * ROW_HEIGHT);
      const toggle = within(grid)
        .getAllByText('event 505')[0]
        ?.closest('[role="row"]')
        ?.querySelector('[data-details-toggle]');
      if (!(toggle instanceof HTMLElement)) throw new Error('No disclosure button for event 505');
      await user.click(toggle);
      const details = await screen.findByRole('region', { name: 'Details of event #505' });
      /** Offset of the open row's line from the top of the view (its screen position). */
      const openRowOnScreen = (): number => (504 - buffer.start) * ROW_HEIGHT - grid.scrollTop;
      expect(openRowOnScreen()).toBe(4 * ROW_HEIGHT);

      // Rows evicted above an open row in view: it stays where it is on screen.
      append(100);
      update(1000);
      expect(screen.getByRole('region', { name: 'Details of event #505' })).toBe(details);
      expect(openRowOnScreen()).toBe(4 * ROW_HEIGHT);
      expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();

      // Scrolled past the open row: its details sit above the view, and the rows in view (event 511
      // at the top) stay put as more rows are evicted.
      scrollTo(grid, 410 * ROW_HEIGHT + DETAILS_HEIGHT);
      const message = within(grid).getByText('event 511');
      append(50);
      update(1000);
      expect(grid.scrollTop).toBe(360 * ROW_HEIGHT + DETAILS_HEIGHT);
      expect(within(grid).getByText('event 511')).toBe(message);
      expect(screen.getByRole('region', { name: 'Details of event #505' })).toBe(details);
      // Still paused: the view ends at the pause point (plus the header and the details row).
      expect(grid).toHaveAttribute('aria-rowcount', String(1000 - 150 + 2));
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

  describe('event details', () => {
    /** The data row that shows the event with `seq`. */
    function rowOf(grid: HTMLElement, seq: number): HTMLElement {
      // The message cell comes first; open details repeat the message.
      const [cell] = within(grid).getAllByText(`event ${String(seq)}`);
      const row = cell?.closest<HTMLElement>('[role="row"]') ?? null;
      if (row === null) throw new Error(`No row for event ${String(seq)}`);
      return row;
    }

    function rowsContainerHeight(grid: HTMLElement): number {
      return grid.scrollHeight - HEADER_HEIGHT;
    }

    it('opens the details of the active row with Enter and shows the fetched payload', async () => {
      const user = userEvent.setup();
      const { buffer, append } = createBuffer(1000);
      append(300);
      const getEvent = vi.fn(fetchEvent);
      const { grid } = renderGrid(buffer, getEvent);
      await user.tab();
      await user.keyboard('{ArrowUp}{ArrowUp}');
      expect(rowOf(grid, 299)).toHaveAttribute('aria-expanded', 'false');

      await user.keyboard('{Enter}');

      expect(rowOf(grid, 299)).toHaveAttribute('aria-expanded', 'true');
      const details = await screen.findByRole('region', { name: 'Details of event #299' });
      expect(getEvent).toHaveBeenCalledExactlyOnceWith(298);
      expect(within(details).getByText(/"orderId": "o-299"/)).toBeInTheDocument();
      expect(within(details).getByText('orders-1a6e-1')).toBeInTheDocument();
      expect(within(details).getByText('trace-299')).toBeInTheDocument();
      expect(within(details).getByText('event 299')).toBeInTheDocument();
      expect(
        within(details).getByText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/),
      ).toBeInTheDocument();
      expect(grid).toHaveFocus();
    });

    it('shows a loading state until the payload arrives', async () => {
      const user = userEvent.setup();
      const { buffer, append } = createBuffer(1000);
      append(30);
      let answer: (details: LogEventDetails | undefined) => void = () => undefined;
      const getEvent: GetEventDetails = () =>
        new Promise((resolve) => {
          answer = resolve;
        });
      const { grid } = renderGrid(buffer, getEvent);

      await user.click(within(rowOf(grid, 25)).getByRole('button', { name: 'Event details' }));

      const details = screen.getByRole('region', { name: 'Details of event #25' });
      expect(within(details).getByRole('status')).toHaveTextContent('Loading payload…');
      await act(async () => {
        answer(detailsOf(streamEvent(25)));
        await Promise.resolve();
      });
      expect(within(details).queryByRole('status')).not.toBeInTheDocument();
      expect(within(details).getByText(/"orderId": "o-25"/)).toBeInTheDocument();
    });

    it('opens and closes the details with the disclosure button, one row at a time', async () => {
      const user = userEvent.setup();
      const { buffer, append } = createBuffer(1000);
      append(30);
      const { grid } = renderGrid(buffer);
      const toggle = (seq: number): HTMLElement =>
        within(rowOf(grid, seq)).getByRole('button', { name: 'Event details' });

      await user.click(toggle(20));
      expect(toggle(20)).toHaveAttribute('aria-expanded', 'true');
      expect(toggle(20)).toHaveAttribute(
        'aria-controls',
        screen.getByRole('region', { name: 'Details of event #20' }).id,
      );
      expect(activeRow(grid)).toBe(rowOf(grid, 20));
      expect(grid).toHaveFocus();

      await user.click(toggle(22));
      expect(rowOf(grid, 20)).toHaveAttribute('aria-expanded', 'false');
      expect(rowOf(grid, 22)).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getAllByRole('region', { name: /^Details of event/ })).toHaveLength(1);

      await user.click(toggle(22));
      expect(rowOf(grid, 22)).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByRole('region', { name: /^Details of event/ })).not.toBeInTheDocument();
    });

    it('says when the payload is no longer available', async () => {
      const user = userEvent.setup();
      const { buffer, append } = createBuffer(1000);
      append(30);
      const { grid } = renderGrid(buffer, () => Promise.resolve(undefined));

      await user.click(within(rowOf(grid, 10)).getByRole('button', { name: 'Event details' }));

      const details = screen.getByRole('region', { name: 'Details of event #10' });
      expect(await within(details).findByText(EVICTED_TEXT)).toBeInTheDocument();
      // The fields come from the table's own buffer and stay.
      expect(within(details).getByText('trace-10')).toBeInTheDocument();
    });

    it('says when an event has no payload, without asking the worker', async () => {
      const user = userEvent.setup();
      const { buffer } = createBuffer(1000);
      buffer.appendEvents([testLogEvent(1)]);
      const getEvent = vi.fn(fetchEvent);
      const { grid } = renderGrid(buffer, getEvent);

      await user.click(within(rowOf(grid, 1)).getByRole('button', { name: 'Event details' }));

      const details = screen.getByRole('region', { name: 'Details of event #1' });
      expect(within(details).getByText(NO_PAYLOAD_TEXT)).toBeInTheDocument();
      expect(within(details).getByText('—')).toBeInTheDocument();
      expect(getEvent).not.toHaveBeenCalled();
    });

    it('closes the details with Escape, also from inside them', async () => {
      const user = userEvent.setup();
      const { buffer, append } = createBuffer(1000);
      append(30);
      const { grid } = renderGrid(buffer);
      await user.click(within(grid).getByText('event 12'));

      await user.keyboard('{Enter}');
      expect(screen.getByRole('region', { name: 'Details of event #12' })).toBeInTheDocument();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('region', { name: /^Details of event/ })).not.toBeInTheDocument();
      expect(rowOf(grid, 12)).toHaveAttribute('aria-expanded', 'false');

      // Tab moves into the open details (they scroll); Escape there closes them and refocuses the grid.
      await user.keyboard('{Enter}');
      await user.tab();
      expect(screen.getByRole('region', { name: 'Details of event #12' })).toHaveFocus();
      await user.keyboard('{ArrowDown}');
      expect(activeRow(grid)).toBe(rowOf(grid, 12));
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('region', { name: /^Details of event/ })).not.toBeInTheDocument();
      expect(grid).toHaveFocus();
    });

    it('stops following when a row opens, and closing it does not resume', async () => {
      const user = userEvent.setup();
      const { buffer, append } = createBuffer(1000);
      append(200);
      const { grid, update } = renderGrid(buffer);

      // The newest row: a click there would keep following, opening it does not.
      await user.click(within(rowOf(grid, 200)).getByRole('button', { name: 'Event details' }));
      expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
      append(50);
      update();
      expect(rowOf(grid, 200)).toHaveAttribute('aria-expanded', 'true');
      expect(grid.scrollTop).toBeLessThan(maxScrollTop(grid));

      await user.keyboard('{Escape}');
      expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
    });

    it('keeps open details (and does not fetch again) while following through eviction', async () => {
      const user = userEvent.setup();
      const { buffer, append } = createBuffer(1000);
      append(1000);
      const getEvent = vi.fn(fetchEvent);
      const { grid, update } = renderGrid(buffer, getEvent);
      await user.click(within(rowOf(grid, 998)).getByRole('button', { name: 'Event details' }));
      const details = await screen.findByRole('region', { name: 'Details of event #998' });

      // End follows the tail again with the row still open; a few rows are evicted per batch.
      await user.keyboard('{End}');
      append(3);
      update();
      append(3);
      update();

      expect(screen.getByRole('region', { name: 'Details of event #998' })).toBe(details);
      expect(getEvent).toHaveBeenCalledOnce();
      expect(grid.scrollTop).toBe(maxScrollTop(grid));
    });

    it('makes the content taller by the details and moves the rows below them down', async () => {
      const user = userEvent.setup();
      const { buffer, append } = createBuffer(1000);
      append(1000);
      const { grid } = renderGrid(buffer);
      scrollTo(grid, 100 * ROW_HEIGHT);

      await user.click(within(rowOf(grid, 105)).getByRole('button', { name: 'Event details' }));

      expect(rowsContainerHeight(grid)).toBe(1000 * ROW_HEIGHT + DETAILS_HEIGHT);
      // Far below the open row: the rows rendered there sit lower by the details' height.
      scrollTo(grid, 500 * ROW_HEIGHT + DETAILS_HEIGHT);
      expect(within(grid).getByText('event 501')).toBeInTheDocument();
      const [first] = dataRows(grid);
      const firstIndex = Number(first?.getAttribute('data-index'));
      expect(firstIndex).toBeGreaterThan(104);
      expect(first?.parentElement?.style.transform).toBe(
        `translateY(${String(firstIndex * ROW_HEIGHT + DETAILS_HEIGHT)}px)`,
      );

      await user.keyboard('{Escape}');
      expect(rowsContainerHeight(grid)).toBe(1000 * ROW_HEIGHT);
      // Closed above the view: the rows in view stay put.
      expect(grid.scrollTop).toBe(500 * ROW_HEIGHT);
      expect(within(grid).getByText('event 501')).toBeInTheDocument();
    });

    it('keeps the rows in view in place when an open row above them is evicted', async () => {
      const user = userEvent.setup();
      const { buffer, append } = createBuffer(1000);
      append(1000);
      const { grid, update } = renderGrid(buffer);
      scrollTo(grid, 100 * ROW_HEIGHT);
      await user.click(within(rowOf(grid, 101)).getByRole('button', { name: 'Event details' }));
      // Event 501 (position 500) at the top of the view, below the open row 101.
      scrollTo(grid, 500 * ROW_HEIGHT + DETAILS_HEIGHT);
      const message = within(grid).getByText('event 501');

      // 50 rows evicted: the open row stays above the view, with its details.
      append(50);
      update();
      expect(grid.scrollTop).toBe(450 * ROW_HEIGHT + DETAILS_HEIGHT);
      expect(within(grid).getByText('event 501')).toBe(message);

      // 100 more: the open row is evicted, and its details' height leaves the offset with it.
      append(100);
      update();
      expect(buffer.start).toBe(150);
      expect(grid.scrollTop).toBe(350 * ROW_HEIGHT);
      expect(rowsContainerHeight(grid)).toBe(1000 * ROW_HEIGHT);
      expect(within(grid).getByText('event 501')).toBe(message);
      expect(screen.queryByRole('region', { name: /^Details of event/ })).not.toBeInTheDocument();
    });

    it('puts the details in a level-2 row after their row, counted in the row indexes', async () => {
      const user = userEvent.setup();
      const { buffer, append } = createBuffer(1000);
      append(30);
      const { grid } = renderGrid(buffer);
      expect(grid).toHaveAttribute('aria-rowcount', '31');

      await user.click(within(rowOf(grid, 20)).getByRole('button', { name: 'Event details' }));

      const region = screen.getByRole('region', { name: 'Details of event #20' });
      const detailsRow = region.closest('[role="row"]');
      expect(detailsRow).toHaveAttribute('aria-level', '2');
      expect(detailsRow).toHaveAttribute('aria-rowindex', '22');
      expect(detailsRow?.previousElementSibling).toBe(rowOf(grid, 20));
      const cells = within(detailsRow instanceof HTMLElement ? detailsRow : grid).getAllByRole(
        'gridcell',
      );
      expect(cells).toHaveLength(1);
      expect(cells[0]).toHaveAttribute('aria-colspan', '5');
      expect(rowOf(grid, 20)).toHaveAttribute('aria-level', '1');
      expect(rowOf(grid, 20)).toHaveAttribute('aria-rowindex', '21');
      expect(rowOf(grid, 21)).toHaveAttribute('aria-rowindex', '23');
      expect(grid).toHaveAttribute('aria-rowcount', '32');
    });

    it('marks a payload the worker cut, with its whole size', async () => {
      const user = userEvent.setup();
      const { buffer, append } = createBuffer(1000);
      append(30);
      const cut: GetEventDetails = (position) =>
        Promise.resolve({
          event: detailsOf(streamEvent(position + 1)).event,
          payload: { text: '{\n  "blob": "xxxx', truncated: true, length: 200_000 },
        });
      const { grid } = renderGrid(buffer, cut);

      await user.click(within(rowOf(grid, 25)).getByRole('button', { name: 'Event details' }));

      const details = screen.getByRole('region', { name: 'Details of event #25' });
      expect(await within(details).findByText(/"blob": "xxxx/)).toBeInTheDocument();
      expect(within(details).getByText(truncatedNote(200_000))).toBeInTheDocument();
    });

    it('gives the focus back to the grid when the focused details are evicted', async () => {
      const user = userEvent.setup();
      const { buffer, append } = createBuffer(1000);
      append(1000);
      const { grid, update } = renderGrid(buffer);
      scrollTo(grid, 10 * ROW_HEIGHT);
      await user.click(within(rowOf(grid, 15)).getByRole('button', { name: 'Event details' }));
      await user.tab();
      expect(screen.getByRole('region', { name: 'Details of event #15' })).toHaveFocus();

      append(100);
      update();

      expect(screen.queryByRole('region', { name: /^Details of event/ })).not.toBeInTheDocument();
      expect(grid).toHaveFocus();
    });

    it('keeps the view inside open details whose row line is scrolled away as batches arrive', async () => {
      const user = userEvent.setup();
      const { buffer, append } = createBuffer(2000);
      append(1000);
      const { grid, update } = renderGrid(buffer);
      scrollTo(grid, 100 * ROW_HEIGHT);
      await user.click(within(rowOf(grid, 101)).getByRole('button', { name: 'Event details' }));
      // The row's line (position 100) is under the header; the view starts 90 px into its details.
      const inside = 101 * ROW_HEIGHT + 90;
      scrollTo(grid, inside);
      const details = screen.getByRole('region', { name: 'Details of event #101' });

      append(20);
      update();
      append(20);
      update();

      expect(grid.scrollTop).toBe(inside);
      expect(screen.getByRole('region', { name: 'Details of event #101' })).toBe(details);
    });
  });
});
