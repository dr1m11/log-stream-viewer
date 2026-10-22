import { describe, expect, it } from 'vitest';

import {
  anchorScrollTop,
  BOTTOM_THRESHOLD,
  followAfterUserScroll,
  type GridCursor,
  nextActivePosition,
  scrollTopToReveal,
} from './table-scroll';

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
