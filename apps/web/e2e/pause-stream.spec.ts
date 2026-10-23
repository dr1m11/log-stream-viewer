import type { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures';

/** The first number in `text`: `1,234 new events` → 1234. */
function parseCount(text: string | null): number {
  const digits = /[\d,]+/.exec(text ?? '')?.[0] ?? '';
  return Number(digits.replaceAll(',', ''));
}

/** The number shown by the counter named `name`. */
async function counter(page: Page, name: string): Promise<number> {
  return parseCount(
    await page
      .getByRole('group', { name })
      .getByText(/^[\d,]+$/)
      .textContent(),
  );
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

/** The newest row in the DOM: its `aria-rowindex` and text. */
function newestRow(grid: Locator): Promise<{ index: number; text: string }> {
  return grid.evaluate((element) => {
    const row = [...element.querySelectorAll('[role="row"][aria-rowindex]')].at(-1);
    return {
      index: Number(row?.getAttribute('aria-rowindex')),
      text: row?.textContent ?? '',
    };
  });
}

/**
 * Rows the table lists minus events received, read from one commit: 0 when every received event
 * is in the table.
 */
function rowsMinusReceived(grid: Locator): Promise<number> {
  return grid.evaluate((element) => {
    const rows = Number(element.getAttribute('aria-rowcount')) - 1;
    const label = [...document.querySelectorAll('[role="group"]')].find((group) =>
      group.textContent.startsWith('Events received'),
    );
    const received = Number((label?.lastElementChild?.textContent ?? '').replaceAll(',', ''));
    return rows - received;
  });
}

test.describe('pause stream', () => {
  test('freezes the table while events keep arriving, then shows all of them on resume', async ({
    page,
    expectNoA11yViolations,
  }) => {
    await page.goto('/?rate=1000&seed=42');
    const grid = page.getByRole('grid', { name: 'Events' });
    const pause = page.getByRole('button', { name: 'Pause stream' });
    const newEvents = page.getByText(/^[\d,]+ new events?$/);
    await expect(page.getByRole('status')).toHaveText('Connected');
    await expect.poll(() => rowCount(grid)).toBeGreaterThan(500);

    // The tooltip names the shortcut (the first tooltip under the production CSP).
    await pause.hover();
    await expect(page.getByRole('tooltip')).toHaveText('Pause stream P');

    await pause.click();
    await expect(pause).toHaveAttribute('aria-pressed', 'true');
    const frozen = await newestRow(grid);
    const frozenRows = await rowCount(grid);
    const received = await counter(page, 'Events received');

    // A couple of seconds of events: counted, kept in the buffer, not shown.
    await expect.poll(() => counter(page, 'Events received')).toBeGreaterThan(received + 2000);
    expect(parseCount(await newEvents.textContent())).toBeGreaterThan(2000);
    expect(await newestRow(grid)).toEqual(frozen);
    expect(await rowCount(grid)).toBe(frozenRows);
    await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeHidden();

    await expectNoA11yViolations();

    await page.getByRole('button', { name: 'Resume' }).click();
    await expect(pause).toHaveAttribute('aria-pressed', 'false');
    await expect(newEvents).toBeHidden();

    // Back at the tail, following it, with every event received during the pause in the table.
    await expect
      .poll(async () => (await newestRow(grid)).index)
      .toBeGreaterThan(frozen.index + 2000);
    await expect.poll(() => distanceFromBottom(grid)).toBeLessThanOrEqual(2);
    const resumedRows = await rowCount(grid);
    await expect.poll(() => rowCount(grid)).toBeGreaterThan(resumedRows);
    expect(await distanceFromBottom(grid)).toBeLessThanOrEqual(2);
    expect(await counter(page, 'Missed events')).toBe(0);
    await expect.poll(() => rowsMinusReceived(grid)).toBe(0);
  });

  test('warns when the full buffer evicts the paused view', async ({
    page,
    expectNoA11yViolations,
  }) => {
    await page.goto('/?rate=1000&seed=42&buffer=1000');
    const grid = page.getByRole('grid', { name: 'Events' });
    const pause = page.getByRole('button', { name: 'Pause stream' });
    const warning = page.getByText(
      /^[\d,]+ older events evicted while paused — the buffer is full$/,
    );
    await expect.poll(() => rowCount(grid)).toBe(1000);

    await pause.click();
    await expect(warning).toBeVisible();

    // After a second the whole paused view is gone: the table says so instead of waiting.
    await expect(
      page.getByText('Paused: no events to show. Resume to see the newest.'),
    ).toBeVisible();
    expect(await rowCount(grid)).toBe(0);
    // At least the whole paused view (1000 rows); exactly 1000 when eviction stops at its end.
    expect(parseCount(await warning.textContent())).toBeGreaterThanOrEqual(1000);

    await expectNoA11yViolations();

    // The shortcut resumes (the focus is still on the toggle).
    await page.keyboard.press('p');
    await expect(pause).toHaveAttribute('aria-pressed', 'false');
    await expect(warning).toBeHidden();
    await expect.poll(() => rowCount(grid)).toBe(1000);
    await expect.poll(() => distanceFromBottom(grid)).toBeLessThanOrEqual(2);
  });
});
