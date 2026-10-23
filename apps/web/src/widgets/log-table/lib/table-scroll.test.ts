import { describe, expect, it } from 'vitest';

import {
  anchorScrollTop,
  BOTTOM_THRESHOLD,
  type ExpandedRow,
  firstRenderedIndex,
  firstRowInView,
  followAfterUserScroll,
  type GridCursor,
  nextActivePosition,
  rowsHeight,
  rowTop,
  scrollTopToReveal,
} from './table-scroll';

/** Row 40 is open, with details 200 px tall. */
const OPEN: ExpandedRow = { index: 40, extra: 200 };

describe('rowTop and rowsHeight', () => {
  it('places rows below an open row lower by the height of its details', () => {
    expect(rowTop(40, 28, OPEN)).toBe(40 * 28);
    expect(rowTop(41, 28, OPEN)).toBe(41 * 28 + 200);
    expect(rowTop(41, 28)).toBe(41 * 28);
  });

  it('adds the details to the height of the rows only while their row is among them', () => {
    expect(rowsHeight(100, 28, OPEN)).toBe(100 * 28 + 200);
    expect(rowsHeight(40, 28, OPEN)).toBe(40 * 28);
    expect(rowsHeight(100, 28)).toBe(100 * 28);
  });
});

describe('anchorScrollTop', () => {
  it('moves the offset up by the height of the evicted rows', () => {
    expect(anchorScrollTop(5000, 30, 28)).toBe(5000 - 30 * 28);
  });

  it('keeps the offset when nothing was evicted', () => {
    expect(anchorScrollTop(5000, 0, 28)).toBe(5000);
  });

  it('stops at the top when the rows in view were evicted themselves', () => {
    expect(anchorScrollTop(280, 50, 28)).toBe(0);
  });

  it('keeps the offset for open details that stay above the view while rows are evicted', () => {
    // Row 40 (now 30) and its details end at 41 × 28 + 200 = 1348, above the view at 5000.
    expect(anchorScrollTop(5000, 10, 28, OPEN, { index: 30, extra: 200 })).toBe(5000 - 10 * 28);
  });

  it('takes the height of open details above the view out when their row is evicted', () => {
    expect(anchorScrollTop(5000, 50, 28, OPEN, undefined)).toBe(5000 - 50 * 28 - 200);
  });

  it('takes the height of open details above the view out when they are closed', () => {
    expect(anchorScrollTop(5000, 0, 28, OPEN, undefined)).toBe(5000 - 200);
  });

  it('follows a change of height of open details above the view', () => {
    expect(anchorScrollTop(5000, 0, 28, OPEN, { index: 40, extra: 320 })).toBe(5000 + 120);
  });

  it('adds the height of details opened above the view', () => {
    expect(anchorScrollTop(5000, 0, 28, undefined, OPEN)).toBe(5000 + 200);
  });

  it('leaves the offset alone for open details in or below the view', () => {
    // The view starts on row 40's own line: its details are in view.
    expect(anchorScrollTop(40 * 28, 0, 28, undefined, OPEN)).toBe(40 * 28);
    expect(anchorScrollTop(40 * 28 + 10, 0, 28, OPEN, OPEN)).toBe(40 * 28 + 10);
    expect(anchorScrollTop(280, 5, 28, OPEN, { index: 35, extra: 200 })).toBe(280 - 5 * 28);
  });

  describe('with the top of the view inside the open details', () => {
    // Row 10's line ends at 308; its details span 308..508; the view starts 92 px into them.
    const ROW_10: ExpandedRow = { index: 10, extra: 200 };

    it('keeps the offset while nothing changes, also from exactly where the details start', () => {
      expect(anchorScrollTop(400, 0, 28, ROW_10, ROW_10)).toBe(400);
      expect(anchorScrollTop(308, 0, 28, ROW_10, ROW_10)).toBe(308);
    });

    it('keeps the distance into the details when they grow, and stops at their end when they shrink', () => {
      expect(anchorScrollTop(400, 0, 28, ROW_10, { index: 10, extra: 320 })).toBe(400);
      expect(anchorScrollTop(400, 0, 28, ROW_10, { index: 10, extra: 50 })).toBe(308 + 50);
    });

    it('moves with rows evicted above the open row', () => {
      expect(anchorScrollTop(400, 3, 28, ROW_10, { index: 7, extra: 200 })).toBe(400 - 3 * 28);
    });

    it('lands just below the row line when the details close or their row is evicted', () => {
      expect(anchorScrollTop(400, 0, 28, ROW_10, undefined)).toBe(308);
      expect(anchorScrollTop(400, 4, 28, { index: 10, extra: 200 }, undefined)).toBe(308 - 4 * 28);
      expect(anchorScrollTop(400, 11, 28, ROW_10, undefined)).toBe(0);
    });
  });
});

describe('firstRenderedIndex', () => {
  it("starts the virtualizer's window earlier when an open row is above it", () => {
    // 200 px of details are up to ceil(200 / 28) = 8 rows.
    expect(firstRenderedIndex(100, 10, 28, OPEN)).toBe(92);
    expect(firstRenderedIndex(5, 10, 28, { index: 2, extra: 200 })).toBe(0);
  });

  it("keeps the virtualizer's window when no open row is above the view", () => {
    expect(firstRenderedIndex(100, 10, 28)).toBe(100);
    expect(firstRenderedIndex(30, 10, 28, OPEN)).toBe(30);
  });
});

describe('firstRowInView', () => {
  it('counts the rows above the view, with open details above it', () => {
    expect(firstRowInView(280, 28)).toBe(10);
    expect(firstRowInView(290, 28)).toBe(11);
    expect(firstRowInView(280, 28, OPEN)).toBe(10);
    // Inside the details of row 40, the next row is the first whose top is in view.
    expect(firstRowInView(41 * 28 + 50, 28, OPEN)).toBe(41);
    expect(firstRowInView(60 * 28 + 200, 28, OPEN)).toBe(60);
  });
});

describe('scrollTopToReveal', () => {
  // A viewport of 10 rows of 28 px.
  const viewport = 280;

  it('keeps the offset for a row that is fully in view', () => {
    expect(scrollTopToReveal(12, 280, viewport, 28)).toBe(280);
  });

  it('aligns a row above the viewport with its top', () => {
    expect(scrollTopToReveal(3, 280, viewport, 28)).toBe(84);
  });

  it('aligns a row below the viewport with its bottom', () => {
    expect(scrollTopToReveal(25, 280, viewport, 28)).toBe(26 * 28 - viewport);
  });

  it('reveals a partly hidden row at the bottom edge', () => {
    expect(scrollTopToReveal(19, 270, viewport, 28)).toBe(20 * 28 - viewport);
  });

  it('accounts for open details above the row', () => {
    expect(scrollTopToReveal(60, 0, viewport, 28, OPEN)).toBe(61 * 28 + 200 - viewport);
    expect(scrollTopToReveal(41, 5000, viewport, 28, OPEN)).toBe(41 * 28 + 200);
  });
});

describe('followAfterUserScroll', () => {
  it('stops following when the user scrolls away from the bottom', () => {
    expect(followAfterUserScroll({ following: true, distanceFromBottom: 300, movedBy: -300 })).toBe(
      false,
    );
  });

  it('resumes following when the user scrolls down to the bottom', () => {
    expect(followAfterUserScroll({ following: false, distanceFromBottom: 0, movedBy: 120 })).toBe(
      true,
    );
  });

  it('treats a stop within the threshold as the bottom', () => {
    expect(
      followAfterUserScroll({
        following: false,
        distanceFromBottom: BOTTOM_THRESHOLD,
        movedBy: 40,
      }),
    ).toBe(true);
  });

  it('does not resume following for a scroll at the bottom that did not move down', () => {
    expect(followAfterUserScroll({ following: false, distanceFromBottom: 0, movedBy: -1 })).toBe(
      false,
    );
    expect(followAfterUserScroll({ following: true, distanceFromBottom: 0, movedBy: 0 })).toBe(
      true,
    );
  });
});

describe('nextActivePosition', () => {
  const cursor: GridCursor = {
    active: 150,
    start: 100,
    end: 200,
    pageRows: 8,
    following: false,
    firstVisible: 140,
  };

  it('moves by one row with the arrow keys and by a page with Page Up and Page Down', () => {
    expect(nextActivePosition('ArrowDown', cursor)).toBe(151);
    expect(nextActivePosition('ArrowUp', cursor)).toBe(149);
    expect(nextActivePosition('PageDown', cursor)).toBe(158);
    expect(nextActivePosition('PageUp', cursor)).toBe(142);
  });

  it('goes to the oldest and the newest row with Home and End', () => {
    expect(nextActivePosition('Home', cursor)).toBe(100);
    expect(nextActivePosition('End', cursor)).toBe(199);
  });

  it('stops at the first and the last row', () => {
    expect(nextActivePosition('PageUp', { ...cursor, active: 103 })).toBe(100);
    expect(nextActivePosition('ArrowUp', { ...cursor, active: 100 })).toBe(100);
    expect(nextActivePosition('PageDown', { ...cursor, active: 195 })).toBe(199);
  });

  it('first activates the row in view when there is no active row', () => {
    expect(nextActivePosition('ArrowDown', { ...cursor, active: undefined })).toBe(140);
    // The active row was evicted.
    expect(nextActivePosition('PageUp', { ...cursor, active: 42 })).toBe(140);
  });

  it('starts from the newest row while following the tail', () => {
    const following = { ...cursor, following: true };
    expect(nextActivePosition('ArrowUp', { ...following, active: undefined })).toBe(199);
    expect(nextActivePosition('ArrowUp', following)).toBe(198);
    expect(nextActivePosition('PageUp', following)).toBe(191);
  });

  it('ignores other keys and an empty table', () => {
    expect(nextActivePosition('Enter', cursor)).toBeUndefined();
    expect(nextActivePosition('ArrowDown', { ...cursor, start: 0, end: 0 })).toBeUndefined();
  });
});
