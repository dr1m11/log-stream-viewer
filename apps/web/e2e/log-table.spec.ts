import type { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures';

/** The number shown by the counter named `name` (`1,234` → 1234). */
async function counter(page: Page, name: string): Promise<number> {
  const text = await page
    .getByRole('group', { name })
    .getByText(/^[\d,]+$/)
    .textContent();
  return Number((text ?? '').replaceAll(',', ''));
}

/** Data rows in the table (its `aria-rowcount` less the header row). */
async function rowCount(grid: Locator): Promise<number> {
  return Number(await grid.getAttribute('aria-rowcount')) - 1;
}

/** Pixels between the bottom of the grid's viewport and the end of its content. */
function distanceFromBottom(grid: Locator): Promise<number> {
  return grid.evaluate(
    (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
  );
}

/** The text of the row at the vertical middle of the grid's viewport. */
function rowInTheMiddle(grid: Locator): Promise<string> {
  return grid.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return hit?.closest('[role="row"]')?.textContent ?? '';
  });
}

test.describe('log table', () => {
  test('follows the tail, holds the view when scrolled up and jumps back to the latest event', async ({
    page,
    expectNoA11yViolations,
  }) => {
    await page.goto('/?rate=1000&seed=42');
    const grid = page.getByRole('treegrid', { name: 'Events' });
    const jump = page.getByRole('button', { name: 'Jump to latest' });
    await expect(page.getByRole('status')).toHaveText('Connected');

    // Following: the grid stays scrolled to the bottom while thousands of rows arrive.
    await expect.poll(() => rowCount(grid)).toBeGreaterThan(2000);
    expect(await distanceFromBottom(grid)).toBeLessThanOrEqual(2);
    await expect(jump).toBeHidden();

    // Virtualized: the DOM holds the rows in view, not every event received.
    const rowsInDom = await grid.getByRole('row').count();
    expect(rowsInDom).toBeLessThan(100);
    expect(await rowCount(grid)).toBeGreaterThan(rowsInDom * 20);

    // Scrolling up stops following: the view stays where the user left it as rows arrive below.
    await grid.hover();
    await page.mouse.wheel(0, -3000);
    await expect(jump).toBeVisible();
    const held = await rowInTheMiddle(grid);
    const received = await counter(page, 'Events received');
    await expect.poll(() => counter(page, 'Events received')).toBeGreaterThan(received + 1000);
    expect(await rowInTheMiddle(grid)).toBe(held);
    expect(await distanceFromBottom(grid)).toBeGreaterThan(10_000);

    await expectNoA11yViolations();

    // "Jump to latest" resumes following.
    await jump.click();
    await expect(jump).toBeHidden();
    await expect.poll(() => distanceFromBottom(grid)).toBeLessThanOrEqual(2);
    const before = await rowCount(grid);
    await expect.poll(() => rowCount(grid)).toBeGreaterThan(before);
    expect(await distanceFromBottom(grid)).toBeLessThanOrEqual(2);
  });

  test('keeps the rows in view in place while the full buffer evicts old rows', async ({
    page,
  }) => {
    await page.goto('/?rate=1000&seed=42&buffer=5000');
    const grid = page.getByRole('treegrid', { name: 'Events' });
    // Five seconds of events fill the buffer.
    await expect.poll(() => rowCount(grid), { timeout: 15_000 }).toBe(5000);

    // As if the user dragged the scrollbar to the middle of the buffer.
    await grid.evaluate((element) => {
      element.scrollTop = (element.scrollHeight - element.clientHeight) / 2;
    });
    await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
    const held = await rowInTheMiddle(grid);
    const received = await counter(page, 'Events received');

    // About a second of events: a fifth of the buffer is evicted at the top meanwhile.
    await expect.poll(() => counter(page, 'Events received')).toBeGreaterThan(received + 1000);

    expect(await rowCount(grid)).toBe(5000);
    expect(await rowInTheMiddle(grid)).toBe(held);
  });

  test('moves through the rows with the keyboard', async ({ page, expectNoA11yViolations }) => {
    await page.goto('/?rate=200&seed=42');
    const grid = page.getByRole('treegrid', { name: 'Events' });
    const jump = page.getByRole('button', { name: 'Jump to latest' });
    await expect.poll(() => rowCount(grid)).toBeGreaterThan(100);

    await grid.focus();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');

    const active = page.locator(
      `[id="${(await grid.getAttribute('aria-activedescendant')) ?? ''}"]`,
    );
    await expect(active).toHaveAttribute('role', 'row');
    await expect(active).toBeInViewport();
    await expect(jump).toBeVisible();

    await page.keyboard.press('Home');
    await expect(grid).toHaveAttribute('aria-activedescendant', /row-0$/);
    expect(await grid.evaluate((element) => element.scrollTop)).toBe(0);

    await expectNoA11yViolations();

    await page.keyboard.press('End');
    await expect(jump).toBeHidden();
    await expect.poll(() => distanceFromBottom(grid)).toBeLessThanOrEqual(2);
  });
});
