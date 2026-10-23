/**
 * Scroll and keyboard arithmetic of the log table, free of React and the DOM. Rows have one fixed
 * height and virtual index `i` shows buffer position `start + i`, so offsets are plain products —
 * plus the height of the one row's details that may be open ({@link ExpandedRow}), which every row
 * below it sits lower by.
 */

/** Height of one row in pixels. Rows never wrap: the message is truncated instead. */
export const ROW_HEIGHT = 28;

/** Height of the sticky header row in pixels; it covers the top of the scroll viewport. */
export const HEADER_HEIGHT = 32;

/**
 * Maximum height of an expanded row's details in pixels (12 rows); longer details scroll inside.
 * Keeps an open row from pushing the rows around it far out of the virtualizer's window.
 */
export const DETAILS_MAX_HEIGHT = 12 * ROW_HEIGHT;

/**
 * How close to the bottom (in pixels) a user scroll must end to count as "at the newest row".
 * Not 0: at fractional zoom levels the browser may stop a pixel short of the maximum.
 */
export const BOTTOM_THRESHOLD = 2;

/**
 * The row whose details are open: its virtual index and the measured height of the details, which
 * sit below the row's own line and push every later row down by `extra` pixels. The virtualizer
 * knows nothing of it (it counts fixed-height rows), so the table adds it to its own offsets.
 */
export interface ExpandedRow {
  readonly index: number;
  readonly extra: number;
}

/** Offset of the top of the row at `index` from the top of the rows (below the header). */
export function rowTop(index: number, rowHeight: number, expanded?: ExpandedRow): number {
  const below = expanded !== undefined && index > expanded.index;
  return index * rowHeight + (below ? expanded.extra : 0);
}

/** Height of `count` rows, with the open details if their row is one of them. */
export function rowsHeight(count: number, rowHeight: number, expanded?: ExpandedRow): number {
  const inside = expanded !== undefined && expanded.index < count;
  return count * rowHeight + (inside ? expanded.extra : 0);
}

/**
 * Where the scroll position must move when the layout changed while the table does not follow the
 * tail, so the rows on screen stay put:
 *
 * - `evictedRows` rows left the top of the buffer: every index shifted down by that many rows, so
 *   the offset shrinks by as many row heights;
 * - the open details changed: `before` is the expanded row of the previous layout (in its indexes)
 *   and `after` the one of the new layout (`undefined` once collapsed or evicted with its row).
 *   Details that end above the viewport (`scrollTop`) count fully, details below the row line in
 *   view do not move the rows on screen. So details that were evicted, collapsed or resized above
 *   the view take their height out of (or into) the offset, and details opened above the view add
 *   theirs. When the view's top edge is inside the details (their row's line scrolled under the
 *   header), the offset keeps the same distance into them — as far as they still reach, if they
 *   shrank — and lands just below the row's line once they are gone.
 *
 * If the rows on screen were evicted themselves, the table stops at the top, at the oldest row
 * still retained.
 */
export function anchorScrollTop(
  scrollTop: number,
  evictedRows: number,
  rowHeight: number,
  before?: ExpandedRow,
  after?: ExpandedRow,
): number {
  // The offset in the previous layout without its details, and how far into them the view starts.
  let top = scrollTop;
  let inside: number | undefined;
  if (before !== undefined) {
    const lineBottom = (before.index + 1) * rowHeight;
    if (scrollTop >= lineBottom + before.extra) {
      top -= before.extra;
    } else if (scrollTop >= lineBottom) {
      inside = scrollTop - lineBottom;
      top = lineBottom;
    }
  }
  top -= evictedRows * rowHeight;
  // `top` is now in the new indexes without any details: add back what of the new ones is above it.
  if (after !== undefined) {
    const sameRow = before !== undefined && after.index === before.index - evictedRows;
    if (sameRow && inside !== undefined) {
      top += Math.min(inside, after.extra);
    } else if ((after.index + 1) * rowHeight <= top) {
      top += after.extra;
    }
  }
  return Math.max(0, top);
}

/**
 * The first virtual index to render, from the first index of the virtualizer's window. The
 * virtualizer places row `i` at `i × rowHeight`; below an open row the rows sit `extra` lower, so
 * when the open row is above the window's top the rows in view have lower indexes than the
 * virtualizer thinks — up to `extra / rowHeight` rows. The window then starts that much earlier.
 */
export function firstRenderedIndex(
  virtualFirst: number,
  overscan: number,
  rowHeight: number,
  expanded?: ExpandedRow,
): number {
  if (expanded === undefined || expanded.index >= virtualFirst + overscan) return virtualFirst;
  return Math.max(0, virtualFirst - Math.ceil(expanded.extra / rowHeight));
}

/** The index of the first row whose top edge is in view at `scrollTop`. */
export function firstRowInView(
  scrollTop: number,
  rowHeight: number,
  expanded?: ExpandedRow,
): number {
  const index = Math.ceil(scrollTop / rowHeight);
  if (expanded === undefined || index <= expanded.index) return index;
  return Math.max(expanded.index + 1, Math.ceil((scrollTop - expanded.extra) / rowHeight));
}

/**
 * The scroll offset that brings the line of the row at `index` fully into a viewport of
 * `viewportHeight` pixels (below the sticky header), moving as little as possible; `scrollTop` if
 * it is visible. An open row's details are not part of its line.
 */
export function scrollTopToReveal(
  index: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  expanded?: ExpandedRow,
): number {
  const top = rowTop(index, rowHeight, expanded);
  const bottom = top + rowHeight;
  if (top < scrollTop) return top;
  if (bottom > scrollTop + viewportHeight) return Math.max(0, bottom - viewportHeight);
  return scrollTop;
}

export interface UserScroll {
  /** Whether the table followed the tail before this scroll. */
  readonly following: boolean;
  /** Pixels between the bottom of the viewport and the end of the content after the scroll. */
  readonly distanceFromBottom: number;
  /** How far the scroll moved since the previous scroll event; positive is towards newer rows. */
  readonly movedBy: number;
}

/**
 * Whether the table follows the tail after a scroll by the user (not one the table made itself).
 * Moving away from the bottom stops following; scrolling down until the bottom resumes it. A scroll
 * that ends at the bottom without moving down (the content shrank under it, a tiny wheel step up)
 * changes nothing, so a step up that the browser cannot express never re-enables following.
 */
export function followAfterUserScroll({
  following,
  distanceFromBottom,
  movedBy,
}: UserScroll): boolean {
  if (distanceFromBottom > BOTTOM_THRESHOLD) return false;
  return movedBy > 0 ? true : following;
}

export interface GridCursor {
  /** Position of the active row, if any; it may have been evicted (`< start`). */
  readonly active: number | undefined;
  /** First retained position, inclusive. */
  readonly start: number;
  /** Position after the newest row. */
  readonly end: number;
  /** Rows that Page Up / Page Down move by. */
  readonly pageRows: number;
  /** Whether the table follows the tail: arrow keys then start from the newest row. */
  readonly following: boolean;
  /** Position of the first row in view, where navigation starts without an active row. */
  readonly firstVisible: number;
}

const STEPS: Readonly<Record<string, (pageRows: number) => number>> = {
  ArrowDown: () => 1,
  ArrowUp: () => -1,
  PageDown: (pageRows) => pageRows,
  PageUp: (pageRows) => -pageRows,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * The position that becomes active when `key` is pressed in the grid, or `undefined` if the key
 * does not navigate (or there are no rows). Home and End go to the oldest and the newest row.
 * Without an active row (none yet, or it was evicted) the first arrow or page key only activates
 * a row: the newest one while following the tail, otherwise the first one in view. While following,
 * moves start from the newest row, which is where the user's eyes are.
 */
export function nextActivePosition(key: string, cursor: GridCursor): number | undefined {
  const { active, start, end, pageRows, following, firstVisible } = cursor;
  if (end <= start) return undefined;
  const last = end - 1;
  if (key === 'Home') return start;
  if (key === 'End') return last;
  const step = STEPS[key];
  if (step === undefined) return undefined;
  if (active === undefined || active < start || active > last) {
    return following ? last : clamp(firstVisible, start, last);
  }
  return clamp((following ? last : active) + step(pageRows), start, last);
}
