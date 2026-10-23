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

/** The events table: a treegrid, whose element is also the scroll container. */
function eventsTable(page: Page): Locator {
  return page.getByRole('treegrid', { name: 'Events' });
}

/**
 * Event rows in the table: its `aria-rowcount` less the header row. No row is opened here, so
 * there is no details row to subtract.
 */
async function rowCount(table: Locator): Promise<number> {
  return Number(await table.getAttribute('aria-rowcount')) - 1;
}

/** Pixels between the bottom of the table's viewport and the end of its content. */
function distanceFromBottom(table: Locator): Promise<number> {
  return table.evaluate(
    (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
  );
}

/**
 * Rows the table lists minus events received, read from one commit: 0 when every received event
 * is in the table.
 */
function rowsMinusReceived(table: Locator): Promise<number> {
  return table.evaluate((element) => {
    const rows = Number(element.getAttribute('aria-rowcount')) - 1;
    const label = [...document.querySelectorAll('[role="group"]')].find((group) =>
      group.textContent.startsWith('Events received'),
    );
    const received = Number((label?.lastElementChild?.textContent ?? '').replaceAll(',', ''));
    return rows - received;
  });
}

test.describe('stream scenarios', () => {
  // Product spec §2, scenarios 1, 2 and 5 as one visit; scenario 4 (an event's details) is
  // event-details.spec.ts.
  test('follows the live tail, keeps up with a higher rate and loses nothing across a pause', async ({
    page,
    expectNoA11yViolations,
  }) => {
    await page.goto('/?rate=100&seed=7');
    const table = eventsTable(page);
    const settings = page.getByRole('region', { name: 'Stream settings' });
    const rate = settings.getByRole('spinbutton', { name: 'Exact rate, events per second' });
    const pause = page.getByRole('button', { name: 'Pause stream' });
    const jump = page.getByRole('button', { name: 'Jump to latest' });
    const newEvents = page.getByText(/^[\d,]+ new events?$/);

    // 1. The stream runs on open and the table follows the tail.
    await expect(page.getByRole('status')).toHaveText('Connected');
    await expect.poll(() => rowCount(table)).toBeGreaterThan(50);
    await expect.poll(() => distanceFromBottom(table)).toBeLessThanOrEqual(2);
    await expect(jump).toBeHidden();

    // 5. A higher rate through the settings: the server confirms it, the counters and the table
    // keep up, and the table still follows. 1,000 events/s keeps the default 100K buffer from
    // filling (and evicting) for well over a minute, even on a slow runner.
    await rate.fill('1000');
    await rate.press('Enter');
    await expect(settings.getByText('Effective rate: 1,000 events/s')).toBeVisible();
    await expect
      .poll(() => counter(page, 'Events per second'), { timeout: 10_000 })
      .toBeGreaterThan(500);
    const beforeRise = await rowCount(table);
    await expect.poll(() => rowCount(table)).toBeGreaterThan(beforeRise + 1000);
    await expect.poll(() => distanceFromBottom(table)).toBeLessThanOrEqual(2);
    await expect(jump).toBeHidden();

    // 2. Pause, then scroll back through history while events keep arriving.
    await pause.click();
    await expect(pause).toHaveAttribute('aria-pressed', 'true');
    const frozenRows = await rowCount(table);
    const received = await counter(page, 'Events received');

    await table.hover();
    await page.mouse.wheel(0, -3000);
    await expect.poll(() => distanceFromBottom(table)).toBeGreaterThan(1000);
    await expect
      .poll(() => counter(page, 'Events received'), { timeout: 10_000 })
      .toBeGreaterThan(received + 1000);
    await expect.poll(async () => parseCount(await newEvents.textContent())).toBeGreaterThan(1000);
    expect(await rowCount(table)).toBe(frozenRows);

    await expectNoA11yViolations();

    // Resume: back at the tail, following it, with every event received meanwhile in the table.
    await page.getByRole('button', { name: 'Resume' }).click();
    await expect(pause).toHaveAttribute('aria-pressed', 'false');
    await expect(newEvents).toBeHidden();
    await expect.poll(() => distanceFromBottom(table)).toBeLessThanOrEqual(2);
    await expect(jump).toBeHidden();
    expect(await counter(page, 'Missed events')).toBe(0);
    await expect.poll(() => rowsMinusReceived(table)).toBe(0);
    expect(await rowCount(table)).toBeGreaterThan(frozenRows + 1000);

    await expectNoA11yViolations();
  });
});
