/**
 * Scroll and keyboard arithmetic of the log table, free of React and the DOM. Rows have one fixed
 * height and virtual index `i` shows buffer position `start + i`, so offsets are plain products.
 */

/** Height of one row in pixels. Rows never wrap: the message is truncated instead. */
export const ROW_HEIGHT = 28;

/** Height of the sticky header row in pixels; it covers the top of the scroll viewport. */
export const HEADER_HEIGHT = 32;

/**
 * How close to the bottom (in pixels) a user scroll must end to count as "at the newest row".
 * Not 0: at fractional zoom levels the browser may stop a pixel short of the maximum.
 */
export const BOTTOM_THRESHOLD = 2;

/**
 * Where the scroll position must move when `evictedRows` rows left the top of the buffer while the
 * table does not follow the tail: every index shifted down by that many rows, so the same rows
 * stay on screen only if the offset shrinks by as many row heights. If the rows on screen were
 * evicted themselves, the table stops at the top, at the oldest row still retained.
 */
export function anchorScrollTop(scrollTop: number, evictedRows: number, rowHeight: number): number {
  return Math.max(0, scrollTop - evictedRows * rowHeight);
}

/**
 * The scroll offset that brings the row at `index` fully into a viewport of `viewportHeight`
 * pixels (below the sticky header), moving as little as possible; `scrollTop` if it is visible.
 */
export function scrollTopToReveal(
  index: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
): number {
  const top = index * rowHeight;
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
