import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';

/** The number shown by the counter named `name` (`1,234` → 1234). */
async function counter(page: Page, name: string): Promise<number> {
  const value = page.getByRole('group', { name }).getByText(/^[\d,]+$/);
  const text = (await value.textContent()) ?? '';
  return Number(text.replaceAll(',', ''));
}

test.describe('smoke', () => {
  test('connects to the mock server and counts the live stream', async ({
    page,
    expectNoA11yViolations,
  }) => {
    await page.goto('/?rate=200&seed=42');

    await expect(page).toHaveTitle('Log Stream Viewer');
    await expect(page.getByRole('heading', { level: 1, name: 'Log Stream Viewer' })).toBeVisible();
    await expect(page.getByRole('status')).toHaveText('Connected');
    await expect(page.getByText('Scenario steady at 200 events/s, seed 42.')).toBeVisible();

    await expect.poll(() => counter(page, 'Events received')).toBeGreaterThan(0);
    const before = await counter(page, 'Events received');
    await expect.poll(() => counter(page, 'Events received')).toBeGreaterThan(before);
    await expect.poll(() => counter(page, 'Events per second')).toBeGreaterThan(0);
    await expect(page.getByRole('region', { name: 'Latest event' })).not.toContainText(
      'No events yet.',
    );

    await expectNoA11yViolations();
  });

  test('keeps the chosen dark theme after a reload', async ({ page, expectNoA11yViolations }) => {
    await page.goto('/');
    const html = page.locator('html');

    await page.getByRole('group', { name: 'Colour theme' }).getByText('Dark').click();
    await expect(html).toHaveAttribute('data-theme', 'dark');

    // theme-init.js applies the stored preference before React mounts.
    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByRole('radio', { name: 'Dark' })).toBeChecked();
    await expect(page.getByRole('status')).toHaveText('Connected');

    await expectNoA11yViolations();
  });
});
