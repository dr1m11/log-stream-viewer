import { observeElementOffset, useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';
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
 * offset in the same frame instead of waiting for the browser's scroll event.
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

  const writeScrollTop = useCallback((element: HTMLElement, top: number) => {
    const before = element.scrollTop;
    if (Math.abs(before - top) < 0.5) return;
    element.scrollTop = top;
    // The browser rounds and clamps: remember what it actually took.
    const written = element.scrollTop;
    if (written === before) return;
    ownScrollTopRef.current = written;
    lastScrollTopRef.current = written;
    offsetListenerRef.current?.(written, false);
  }, []);

  const count = end - start;
  // eslint-disable-next-line react-hooks/incompatible-library -- no React Compiler in this build; the grid re-renders on every range change anyway
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: estimateRowSize,
    overscan: OVERSCAN,
    // The sticky header sits above the rows inside the scroll element.
    scrollMargin: HEADER_HEIGHT,
    scrollPaddingStart: HEADER_HEIGHT,
    observeElementOffset: observeOffset,
  });

  // Before paint: keep the newest row in view, or the rows in view in place.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    const previous = laidOutRef.current;
    laidOutRef.current = { buffer, start };
    if (element === null) return;
    if (following) {
      writeScrollTop(element, element.scrollHeight - element.clientHeight);
    } else if (previous.buffer === buffer && start > previous.start) {
      writeScrollTop(
        element,
        anchorScrollTop(element.scrollTop, start - previous.start, ROW_HEIGHT),
      );
    }
  }, [buffer, start, end, following, writeScrollTop]);

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
    // Arrives before the scroll it causes, and even when the grid cannot move up at all.
    if (event.deltaY < 0 && following) setFollowing(false);
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
    if (Number.isInteger(index)) setActive(start + index);
  }

  function jumpToLatest(): void {
    setFollowing(true);
    // The button disappears: keep the keyboard focus in the table instead of losing it.
    scrollRef.current?.focus({ preventScroll: true });
  }

  const items = virtualizer.getVirtualItems();
  const firstItem = items[0];
  const rowId = (position: number): string => `${rowBaseId}row-${String(position)}`;
  // Only a row in the DOM can be the active descendant; the cursor may be scrolled out of view.
  const activeId =
    active !== undefined && items.some((item) => start + item.index === active)
      ? rowId(active)
      : undefined;

  return (
    <section
      aria-labelledby={headingId}
      className="flex min-h-48 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-surface-raised"
    >
      <h2 id={headingId} className="border-b border-border px-4 py-2.5 text-sm font-semibold">
        Events
      </h2>
      <div className="relative min-h-0 flex-1">
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
          className="group absolute inset-0 overflow-auto font-mono text-sm [overflow-anchor:none]"
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
            <div style={{ height: virtualizer.getTotalSize() }}>
              <div
                role="rowgroup"
                style={{
                  transform: `translateY(${String((firstItem?.start ?? HEADER_HEIGHT) - HEADER_HEIGHT)}px)`,
                }}
              >
                {items.map((item) => {
                  const position = start + item.index;
                  return (
                    <LogRow
                      key={position}
                      buffer={buffer}
                      position={position}
                      index={item.index}
                      id={rowId(position)}
                      active={position === active}
                    />
                  );
                })}
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
