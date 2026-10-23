import type { Locator } from '@playwright/test';

import { expect, test } from './fixtures';

/** Data rows in the table (its `aria-rowcount` less the header row). */
async function rowCount(grid: Locator): Promise<number> {
  return Number(await grid.getAttribute('aria-rowcount')) - 1;
}

test.describe('event details', () => {
  test('opens an event with Enter to show its JSON payload and closes it with Escape', async ({
    page,
    expectNoA11yViolations,
  }) => {
    // With seed 42 the first event is an api-gateway request with an HTTP payload.
    await page.goto('/?rate=200&seed=42');
    const grid = page.getByRole('treegrid', { name: 'Events' });
    await expect(page.getByRole('status')).toHaveText('Connected');
    await expect.poll(() => rowCount(grid)).toBeGreaterThan(20);

    await grid.focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');

    const details = page.getByRole('region', { name: 'Details of event #1' });
    await expect(details).toBeVisible();
    // Pretty-printed by the worker's copy of the event: the table's own buffer has no payloads.
    await expect(details.getByText('"path": "/api/users/me"')).toBeVisible();
    await expect(details.getByText('api-gateway', { exact: true })).toBeVisible();
    await expect(grid.getByRole('row', { expanded: true })).toHaveCount(1);
    // Opening a row stops following, so it stays in view while events keep arriving.
    await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
    const received = await rowCount(grid);
    await expect.poll(() => rowCount(grid)).toBeGreaterThan(received + 50);
    await expect(details).toBeInViewport();

    await expectNoA11yViolations();

    await page.keyboard.press('Escape');
    await expect(details).toBeHidden();
    await expect(grid.getByRole('row', { expanded: true })).toHaveCount(0);
    await expect(grid).toBeFocused();
  });
});
