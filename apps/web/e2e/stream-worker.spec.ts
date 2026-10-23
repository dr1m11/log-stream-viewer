import { expect, test } from './fixtures';

/**
 * Init scripts run in the page's frames, not in its workers: with this one a socket opened on the
 * main thread fails ("Closed: Cannot open the connection"), while the stream worker's socket works.
 */
const FORBID_MAIN_THREAD_SOCKETS = `
  window.WebSocket = function WebSocket() {
    throw new Error('WebSocket opened on the main thread');
  };
`;

test.describe('stream worker', () => {
  test('streams through a socket in the worker, none on the main thread', async ({ page }) => {
    await page.addInitScript({ content: FORBID_MAIN_THREAD_SOCKETS });

    await page.goto('/?rate=200&seed=42');

    await expect(page.getByRole('status')).toHaveText('Connected');
    await expect(
      page.getByRole('treegrid', { name: 'Events' }).getByRole('row').nth(1),
    ).toBeVisible();
    expect(page.workers().length).toBeGreaterThan(0);
  });
});
