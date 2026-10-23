import {
  observeElementOffset,
  observeElementRect,
  useVirtualizer,
  type Virtualizer,
} from '@tanstack/react-virtual';
import { ArrowDownToLine } from 'lucide-react';
import {
  type KeyboardEvent,
  type MouseEvent,
  type UIEvent,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type WheelEvent,
} from 'react';

import type { LogBufferView } from '@/entities/log-stream';
import { cn } from '@/shared/lib/cn';
import { Button } from '@/shared/ui/button';

import {
  anchorScrollTop,
  type ExpandedRow,
  firstRenderedIndex,
  firstRowInView,
  followAfterUserScroll,
  HEADER_HEIGHT,
  nextActivePosition,
  ROW_HEIGHT,
  rowsHeight,
  rowTop,
  scrollTopToReveal,
} from '../lib/table-scroll';
import type { GetEvent } from './EventDetails';
import {
  COLUMN_COUNT,
  DETAILS_CELL_SELECTOR,
  DETAILS_TOGGLE_SELECTOR,
  LogRow,
  ROW_COLUMNS,
} from './LogRow';

/** Rows rendered beyond each edge of the viewport, so a fast scroll does not show blank rows. */
const OVERSCAN = 10;

type OffsetListener = Parameters<typeof observeElementOffset>[1];
type RectListener = Parameters<typeof observeElementRect>[1];

function estimateRowSize(): number {
  return ROW_HEIGHT;
}

/** What the rows were laid out for in a commit. */
interface Layout {
  readonly buffer: LogBufferView;
  readonly start: number;
  /** The open row, in the indexes of this layout's `start`; `undefined` if none is retained. */
  readonly expanded: ExpandedRow | undefined;
}

/** The open row at `position` as an {@link ExpandedRow}, if it is among the rows `[start, end)`. */
function expandedRowAt(
  position: number | undefined,
  start: number,
  end: number,
  extra: number,
): ExpandedRow | undefined {
  if (position === undefined || position < start || position >= end) return undefined;
  return { index: position - start, extra };
}

export interface LogGridProps {
  /** The buffer replica the rows read from, by position. */
  readonly buffer: LogBufferView;
  /** First position to show (inclusive): virtual index `i` shows position `start + i`. */
  readonly start: number;
  /** Position after the last row to show. */
  readonly end: number;
  /**
   * The stream view is paused: the caller holds `end` still, and the grid stops following (rows
   * keyed by position, anchored while `start` grows) and hides "Jump to latest". When it turns
   * false again the grid jumps to the newest row and follows.
   */
  readonly paused?: boolean;
  /** Fetches the full event of an expanded row, payload included (`LogStreamStore.getEvent`). */
  readonly getEvent: GetEvent;
}

/**
 * The virtualized event grid for the rows `[start, end)` of `buffer`: only the rows in view (plus
 * {@link OVERSCAN}) are in the DOM.
 *
 * **Follow tail.** On by default: whenever the range changes the grid scrolls to the newest row.
 * A user scroll away from the bottom (wheel, scrollbar, touch, keys) turns it off and shows "Jump
 * to latest"; scrolling back to the bottom, End, or the button turns it on again. The grid tells
 * its own scroll writes from the user's by the offset it wrote (see `writeScrollTop`).
 *
 * **Anchoring.** Without follow, rows evicted at the top (`start` grows) would shift every index
 * and make the rows in view jump; the grid moves the scroll offset up by as many rows instead.
 *
 * Every scroll write is reported to the virtualizer at once, so it renders the rows of the new
 * offset in the same frame instead of waiting for the browser's scroll event. Scroll targets are
 * computed from known numbers (row count, row height, the viewport height the virtualizer's
 * resize observer reports, the last offset written or seen), so following the tail reads no
 * layout per frame.
 *
 * **Fixed virtualizer count.** The virtualizer always counts `buffer.capacity` rows and the grid
 * renders only the indexes below `end - start`, with its own content height. TanStack Virtual
 * rebuilds its measurements in O(count) whenever the count changes (11 ms per batch near 1M rows);
 * with a fixed count that happens once per buffer.
 *
 * **Details.** Enter on the active row, or its disclosure button, opens the row's details (one
 * row at a time); Escape or the same again closes them. Opening stops following, so the row does
 * not scroll away; closing does not resume it. The open row is kept by position, and only its
 * details are measured, by a `ResizeObserver` of the grid's own: the virtualizer's
 * `measureElement` would key the size by virtual index, which moves with every eviction, and
 * each new size would rebuild its measurements in O(count). The grid adds the measured height to
 * its content height, to the offset of the rows below the open row and to the anchoring.
 */
export function LogGrid({ buffer, start, end, paused = false, getEvent }: LogGridProps) {
  const headingId = useId();
  const rowBaseId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(!paused);
  /** Position of the keyboard cursor; may fall out of `[start, end)` through eviction. */
  const [active, setActive] = useState<number | undefined>(undefined);
  /** Position of the row whose details are open; may fall out of `[start, end)` through eviction. */
  const [expanded, setExpanded] = useState<number | undefined>(undefined);
  /** Measured height of the open details in pixels; 0 until measured. */
  const [detailsHeight, setDetailsHeight] = useState(0);

  // A new buffer is a new session whose positions restart at 0: start over at the tail.
  const [shownBuffer, setShownBuffer] = useState(buffer);
  if (buffer !== shownBuffer) {
    setShownBuffer(buffer);
    setFollowing(true);
    setActive(undefined);
    setExpanded(undefined);
  }

  // Pausing holds the rows in view where they are; resuming returns to the tail.
  const [shownPaused, setShownPaused] = useState(paused);
  if (paused !== shownPaused) {
    setShownPaused(paused);
    setFollowing(!paused);
  }
  // Whether the grid tracks the tail: never while paused. A scroll to the bottom, End or a click on
  // the last row still sets `following` then, but pinning and index keys would make every row in
  // view change its element each frame as `start` grows, collapsing a selection.
  const tracking = following && !paused;

  /** The virtualizer's scroll listener, to report the grid's own writes without delay. */
  const offsetListenerRef = useRef<OffsetListener | undefined>(undefined);
  /** The offset of the grid's last scroll write until its scroll event arrives. */
  const ownScrollTopRef = useRef<number | undefined>(undefined);
  /** The offset seen by the last scroll event or write, to tell the direction of a scroll. */
  const lastScrollTopRef = useRef(0);
  const count = end - start;
  const expandedRow = useMemo(
    () => expandedRowAt(expanded, start, end, detailsHeight),
    [expanded, start, end, detailsHeight],
  );

  /** What the rows were laid out for in the last commit, to measure eviction and open details. */
  const laidOutRef = useRef<Layout>({ buffer, start, expanded: expandedRow });
  /** Height of the scroll viewport (header included), from the virtualizer's resize observer. */
  const viewportHeightRef = useRef(0);
  /** `tracking` and the height of the rows in the last commit, for the resize observer. */
  const followingRef = useRef(tracking);
  const rowsHeightRef = useRef(rowsHeight(count, ROW_HEIGHT, expandedRow));

  const observeOffset = useCallback(
    (instance: Virtualizer<HTMLDivElement, Element>, listener: OffsetListener) => {
      offsetListenerRef.current = listener;
      const stop = observeElementOffset(instance, listener);
      return () => {
        offsetListenerRef.current = undefined;
        stop?.();
      };
    },
    [],
  );

  /**
   * Scrolls to `top`, which must lie within the scroll range. Reads nothing back (a read after
   * the commit would force a layout every frame); the browser may round the offset, which the
   * scroll handler tolerates.
   */
  const writeScrollTop = useCallback((element: HTMLElement, top: number) => {
    if (Math.abs(lastScrollTopRef.current - top) < 0.5) return;
    element.scrollTop = top;
    ownScrollTopRef.current = top;
    lastScrollTopRef.current = top;
    offsetListenerRef.current?.(top, false);
  }, []);

  const pinToBottom = useCallback(
    (element: HTMLElement) => {
      const contentHeight = HEADER_HEIGHT + rowsHeightRef.current;
      writeScrollTop(element, Math.max(0, contentHeight - viewportHeightRef.current));
    },
    [writeScrollTop],
  );

  const observeRect = useCallback(
    (instance: Virtualizer<HTMLDivElement, Element>, listener: RectListener) =>
      observeElementRect(instance, (rect) => {
        const previous = viewportHeightRef.current;
        viewportHeightRef.current = rect.height;
        listener(rect);
        // A resize moves no scroll offset and fires no scroll event: pin the tail again. Not on
        // the first measurement, which the layout effect below follows up anyway.
        const element = instance.scrollElement;
        if (previous !== 0 && previous !== rect.height && followingRef.current && element) {
          pinToBottom(element);
        }
      }),
    [pinToBottom],
  );

  /**
   * Measures the open details: once when they mount (the one forced layout of opening a row),
   * then whenever they resize (the payload arrives, the viewport width rewraps the text). A
   * `ResizeObserver` callback runs after layout, so reading the height there forces nothing.
   */
  const measureDetails = useCallback((element: HTMLDivElement | null) => {
    if (element === null) return;
    const measure = (): void => {
      setDetailsHeight(element.offsetHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  // eslint-disable-next-line react-hooks/incompatible-library -- no React Compiler in this build; the grid re-renders on every range change anyway
  const virtualizer = useVirtualizer({
    count: buffer.capacity,
    getScrollElement: () => scrollRef.current,
    estimateSize: estimateRowSize,
    overscan: OVERSCAN,
    // The sticky header sits above the rows inside the scroll element.
    scrollMargin: HEADER_HEIGHT,
    observeElementOffset: observeOffset,
    observeElementRect: observeRect,
  });

  // Before paint: keep the newest row in view, or the rows in view in place.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    const previous = laidOutRef.current;
    laidOutRef.current = { buffer, start, expanded: expandedRow };
    followingRef.current = tracking;
    rowsHeightRef.current = rowsHeight(end - start, ROW_HEIGHT, expandedRow);
    if (element === null) return;
    if (tracking) {
      pinToBottom(element);
    } else if (previous.buffer === buffer) {
      writeScrollTop(
        element,
        anchorScrollTop(
          lastScrollTopRef.current,
          start - previous.start,
          ROW_HEIGHT,
          previous.expanded,
          expandedRow,
        ),
      );
    }
  }, [buffer, start, end, tracking, expandedRow, pinToBottom, writeScrollTop]);

  function handleScroll(event: UIEvent<HTMLDivElement>): void {
    const element = event.currentTarget;
    const top = element.scrollTop;
    const movedBy = top - lastScrollTopRef.current;
    lastScrollTopRef.current = top;
    const own = ownScrollTopRef.current;
    ownScrollTopRef.current = undefined;
    if (own !== undefined && Math.abs(top - own) < 1) return;
    const next = followAfterUserScroll({
      following,
      distanceFromBottom: element.scrollHeight - element.clientHeight - top,
      movedBy,
    });
    if (next !== following) setFollowing(next);
  }

  function handleWheel(event: WheelEvent<HTMLDivElement>): void {
    // Arrives before the scroll it causes, and even when the grid cannot move up at all. A
    // sideways pan or a Ctrl+wheel zoom is not a scroll up.
    const up = event.deltaY < 0 && Math.abs(event.deltaY) > Math.abs(event.deltaX);
    if (up && !event.ctrlKey && following) setFollowing(false);
  }

  /** Opens the details of the row at `position` (closing any other) or closes them. */
  function toggleDetails(position: number): void {
    setActive(position);
    if (expanded === position) {
      setExpanded(undefined);
      return;
    }
    setExpanded(position);
    setDetailsHeight(0);
    // The open row must not scroll away under the incoming rows.
    setFollowing(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const element = event.currentTarget;
    if (event.target !== element) {
      // Keys inside the open details (scrolling them) are theirs. Escape closes the details and
      // brings the focus back to the grid before the focused region unmounts.
      if (event.key === 'Escape' && expanded !== undefined) {
        event.preventDefault();
        element.focus({ preventScroll: true });
        setExpanded(undefined);
      }
      return;
    }
    if (event.key === 'Enter') {
      if (active === undefined || active < start || active >= end) return;
      event.preventDefault();
      toggleDetails(active);
      return;
    }
    if (event.key === 'Escape') {
      if (expanded === undefined) return;
      event.preventDefault();
      setExpanded(undefined);
      return;
    }
    const viewport = Math.max(ROW_HEIGHT, element.clientHeight - HEADER_HEIGHT);
    const next = nextActivePosition(event.key, {
      active,
      start,
      end,
      pageRows: Math.max(1, Math.floor(viewport / ROW_HEIGHT) - 1),
      following: tracking,
      firstVisible: start + firstRowInView(element.scrollTop, ROW_HEIGHT, expandedRow),
    });
    if (next === undefined) return;
    event.preventDefault();
    setActive(next);
    // The cursor on the newest row means following it; anywhere else holds the view.
    const follow = next === end - 1;
    setFollowing(follow);
    if (!follow) {
      writeScrollTop(
        element,
        scrollTopToReveal(next - start, element.scrollTop, viewport, ROW_HEIGHT, expandedRow),
      );
    }
  }

  function handleClick(event: MouseEvent<HTMLDivElement>): void {
    const { target } = event;
    // Clicks inside the open details (selecting text) leave the cursor and follow mode alone.
    if (!(target instanceof Element) || target.closest(DETAILS_CELL_SELECTOR) !== null) return;
    const row = target.closest('[data-index]');
    const index = Number(row?.getAttribute('data-index'));
    if (!Number.isInteger(index)) return;
    const position = start + index;
    if (target.closest(DETAILS_TOGGLE_SELECTOR) !== null) {
      toggleDetails(position);
      // The button does not take the focus (see `LogRow`): give it to the grid, as a row click does.
      event.currentTarget.focus({ preventScroll: true });
      return;
    }
    setActive(position);
    // Like the keyboard: a row other than the newest holds the view, so it does not scroll away.
    setFollowing(position === end - 1);
  }

  function jumpToLatest(): void {
    setFollowing(true);
    // The button disappears: keep the keyboard focus in the table instead of losing it.
    scrollRef.current?.focus({ preventScroll: true });
  }

  // The virtualizer counts the whole capacity; indexes from `count` on are not rows (yet).
  const items = virtualizer.getVirtualItems();
  let firstIndex = items[0]?.index ?? 0;
  const span = (items.at(-1)?.index ?? -1) - firstIndex;
  // The virtualizer's offset still belongs to the `start` of the last commit until the layout
  // effect anchors it. Without follow, render the anchored range right away: the same positions,
  // `start` moved by k rows, so k indexes earlier. Rendering the stale range for one commit would
  // unmount the rows in view (and drop a text selection) before the anchoring brings them back.
  // Reading the ref here is safe: it changes only in the layout effect, and snapshot updates
  // render synchronously.

  // The same goes for open details evicted, closed or resized above the view: render the rows
  // where the anchoring will put the offset.
  const laidOut = laidOutRef.current;
  if (!tracking && laidOut.buffer === buffer) {
    const from = lastScrollTopRef.current;
    const to = anchorScrollTop(
      from,
      start - laidOut.start,
      ROW_HEIGHT,
      laidOut.expanded,
      expandedRow,
    );
    // Rounded down, so that a partly visible row is rendered rather than missed.
    firstIndex = Math.max(0, firstIndex + Math.floor((to - from) / ROW_HEIGHT));
  }
  const lastIndex = Math.min(firstIndex + span, count - 1);
  // Rows below open details sit lower than the virtualizer places them.
  firstIndex = firstRenderedIndex(firstIndex, OVERSCAN, ROW_HEIGHT, expandedRow);
  const rowId = (position: number): string => `${rowBaseId}row-${String(position)}`;
  // Only a row in the DOM can be the active descendant; the cursor may be scrolled out of view.
  const activeId =
    active !== undefined && active - start >= firstIndex && active - start <= lastIndex
      ? rowId(active)
      : undefined;
  // Row keys depend on the mode. While following, rows are keyed by virtual index: on a fast
  // stream every row in view is a new position each frame, and recycling the row elements (only
  // their cells re-render) costs about a fifth to a third less main-thread time at 10K events/s
  // than mounting new ones. Otherwise rows are keyed by position: anchoring keeps the positions in
  // view while eviction shifts their indexes, so each event keeps its DOM node, its cells skip
  // rendering (memo) and a text selection in the view survives incoming batches. Switching modes
  // remounts the rows in view once. The open row is keyed by position in both modes: recycled by
  // index, its details would remount (and fetch again) whenever eviction moves its index.
  const rows = [];
  for (let index = firstIndex; index <= lastIndex; index++) {
    const position = start + index;
    rows.push(
      <LogRow
        key={tracking && position !== expanded ? `i${String(index)}` : `p${String(position)}`}
        buffer={buffer}
        position={position}
        index={index}
        id={rowId(position)}
        active={position === active}
        expanded={position === expanded}
        getEvent={getEvent}
        detailsRef={measureDetails}
      />,
    );
  }

  return (
    <section
      aria-labelledby={headingId}
      className="flex min-h-48 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-surface-raised"
    >
      <h2 id={headingId} className="border-b border-border px-4 py-2.5 text-sm font-semibold">
        Events
      </h2>
      {/*
        The grid's focus ring is drawn by this wrapper, inside the panel and above the sticky
        header: the rounded panel clips an outline outside the grid, and the header covers the
        top edge of one drawn on the grid itself.
      */}
      <div className="relative min-h-0 flex-1 after:pointer-events-none after:absolute after:inset-0 after:z-20 after:rounded-b-md has-[[role=grid]:focus-visible]:after:outline-2 has-[[role=grid]:focus-visible]:after:-outline-offset-2 has-[[role=grid]:focus-visible]:after:outline-focus">
        <div
          ref={scrollRef}
          role="grid"
          aria-labelledby={headingId}
          aria-rowcount={count + 1}
          aria-colcount={COLUMN_COUNT}
          aria-activedescendant={activeId}
          tabIndex={0}
          onScroll={handleScroll}
          onWheel={handleWheel}
          onKeyDown={handleKeyDown}
          onClick={handleClick}
          // The grid anchors rows itself; the browser's scroll anchoring would fight it.
          // The wrapper draws the focus ring (see above).
          className="group absolute inset-0 overflow-auto font-mono text-sm [overflow-anchor:none] focus-visible:outline-none"
        >
          <div className="min-w-xl">
            <div role="rowgroup" className="sticky top-0 z-10 bg-surface-raised">
              <div
                role="row"
                aria-rowindex={1}
                style={{ height: HEADER_HEIGHT }}
                // The row keeps the grid's monospace font, which the `ch` column widths are
                // measured in; only the header cells use the smaller sans-serif text.
                className={cn(
                  ROW_COLUMNS,
                  'border-b border-border text-fg-muted *:font-sans *:text-xs *:font-semibold',
                )}
              >
                <div role="columnheader">
                  <span className="sr-only">Details</span>
                </div>
                <div role="columnheader">Time</div>
                <div role="columnheader">Level</div>
                <div role="columnheader">Service</div>
                <div role="columnheader">Message</div>
              </div>
            </div>
            <div style={{ height: rowsHeight(count, ROW_HEIGHT, expandedRow) }}>
              <div
                role="rowgroup"
                style={{
                  transform: `translateY(${String(rowTop(firstIndex, ROW_HEIGHT, expandedRow))}px)`,
                }}
              >
                {rows}
              </div>
            </div>
          </div>
        </div>
        {count === 0 && (
          <p className="pointer-events-none absolute inset-x-0 top-14 text-center text-sm text-fg-muted">
            {paused
              ? 'Paused: no events to show. Resume to see the newest.'
              : 'Waiting for events…'}
          </p>
        )}
        {!following && !paused && (
          <Button
            variant="primary"
            size="sm"
            onClick={jumpToLatest}
            className="absolute bottom-4 left-1/2 -translate-x-1/2 shadow-md"
          >
            <ArrowDownToLine aria-hidden="true" />
            Jump to latest
          </Button>
        )}
      </div>
    </section>
  );
}
