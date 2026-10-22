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
  useRef,
  useState,
  type WheelEvent,
} from 'react';

import type { LogBufferView } from '@/entities/log-stream';
import { cn } from '@/shared/lib/cn';
import { Button } from '@/shared/ui/button';

import {
  anchorScrollTop,
  followAfterUserScroll,
  HEADER_HEIGHT,
  nextActivePosition,
  ROW_HEIGHT,
  scrollTopToReveal,
} from '../lib/table-scroll';
import { COLUMN_COUNT, LogRow, ROW_COLUMNS } from './LogRow';

/** Rows rendered beyond each edge of the viewport, so a fast scroll does not show blank rows. */
const OVERSCAN = 10;

type OffsetListener = Parameters<typeof observeElementOffset>[1];
type RectListener = Parameters<typeof observeElementRect>[1];

function estimateRowSize(): number {
  return ROW_HEIGHT;
}

export interface LogGridProps {
  /** The buffer replica the rows read from, by position. */
  readonly buffer: LogBufferView;
  /** First position to show (inclusive): virtual index `i` shows position `start + i`. */
  readonly start: number;
  /** Position after the last row to show. */
  readonly end: number;
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
 */
export function LogGrid({ buffer, start, end }: LogGridProps) {
  const headingId = useId();
  const rowBaseId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  /** Position of the keyboard cursor; may fall out of `[start, end)` through eviction. */
  const [active, setActive] = useState<number | undefined>(undefined);

  // A new buffer is a new session whose positions restart at 0: start over at the tail.
  const [shownBuffer, setShownBuffer] = useState(buffer);
  if (buffer !== shownBuffer) {
    setShownBuffer(buffer);
    setFollowing(true);
    setActive(undefined);
  }

  /** The virtualizer's scroll listener, to report the grid's own writes without delay. */
  const offsetListenerRef = useRef<OffsetListener | undefined>(undefined);
  /** The offset of the grid's last scroll write until its scroll event arrives. */
  const ownScrollTopRef = useRef<number | undefined>(undefined);
  /** The offset seen by the last scroll event or write, to tell the direction of a scroll. */
  const lastScrollTopRef = useRef(0);
  /** What the rows were laid out for in the last commit, to measure eviction. */
  const laidOutRef = useRef({ buffer, start });
  /** Height of the scroll viewport (header included), from the virtualizer's resize observer. */
  const viewportHeightRef = useRef(0);
  /** `following` and the row count of the last commit, for the resize observer. */
  const followingRef = useRef(following);
  const countRef = useRef(end - start);

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
      const contentHeight = HEADER_HEIGHT + countRef.current * ROW_HEIGHT;
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

  const count = end - start;
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
    laidOutRef.current = { buffer, start };
    followingRef.current = following;
    countRef.current = end - start;
    if (element === null) return;
    if (following) {
      pinToBottom(element);
    } else if (previous.buffer === buffer && start > previous.start) {
      writeScrollTop(
        element,
        anchorScrollTop(lastScrollTopRef.current, start - previous.start, ROW_HEIGHT),
      );
    }
  }, [buffer, start, end, following, pinToBottom, writeScrollTop]);

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

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const element = event.currentTarget;
    const viewport = Math.max(ROW_HEIGHT, element.clientHeight - HEADER_HEIGHT);
    const next = nextActivePosition(event.key, {
      active,
      start,
      end,
      pageRows: Math.max(1, Math.floor(viewport / ROW_HEIGHT) - 1),
      following,
      firstVisible: start + Math.ceil(element.scrollTop / ROW_HEIGHT),
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
        scrollTopToReveal(next - start, element.scrollTop, viewport, ROW_HEIGHT),
      );
    }
  }

  function handleClick(event: MouseEvent<HTMLDivElement>): void {
    const row = event.target instanceof Element ? event.target.closest('[data-index]') : null;
    const index = Number(row?.getAttribute('data-index'));
    if (!Number.isInteger(index)) return;
    const position = start + index;
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
  const firstIndex = items[0]?.index ?? 0;
  const lastIndex = Math.min(items.at(-1)?.index ?? -1, count - 1);
  const rowId = (position: number): string => `${rowBaseId}row-${String(position)}`;
  // Only a row in the DOM can be the active descendant; the cursor may be scrolled out of view.
  const activeId =
    active !== undefined && active - start >= firstIndex && active - start <= lastIndex
      ? rowId(active)
      : undefined;
  // Keyed by virtual index, not by position: while following a fast stream every row in view is a
  // new position each frame, and recycling the row elements (only their cells re-render) costs
  // about a fifth to a third less main-thread time at 10K events/s than mounting new ones. Where
  // an index keeps its position (scrolling while `start` stands still) the cells' memo skips them.
  const rows = [];
  for (let index = firstIndex; index <= lastIndex; index++) {
    const position = start + index;
    rows.push(
      <LogRow
        key={index}
        buffer={buffer}
        position={position}
        index={index}
        id={rowId(position)}
        active={position === active}
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
                <div role="columnheader">Time</div>
                <div role="columnheader">Level</div>
                <div role="columnheader">Service</div>
                <div role="columnheader">Message</div>
              </div>
            </div>
            <div style={{ height: count * ROW_HEIGHT }}>
              <div
                role="rowgroup"
                style={{ transform: `translateY(${String(firstIndex * ROW_HEIGHT)}px)` }}
              >
                {rows}
              </div>
            </div>
          </div>
        </div>
        {count === 0 && (
          <p className="pointer-events-none absolute inset-x-0 top-14 text-center text-sm text-fg-muted">
            Waiting for events…
          </p>
        )}
        {!following && (
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
