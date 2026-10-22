import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';

const NUMBER_FORMAT = new Intl.NumberFormat('en-US');

/** The number shown by the counter named `name` (`1,234` → 1234). */
async function counter(page: Page, name: string): Promise<number> {
  const value = page.getByRole('group', { name }).getByText(/^[\d,]+$/);
  const text = (await value.textContent()) ?? '';
  return Number(text.replaceAll(',', ''));
}

test.describe('stream settings', () => {
  test('changes rate and scenario on the live stream, clamped to the server limits', async ({
    page,
    expectNoA11yViolations,
  }) => {
    await page.goto('/?rate=200&seed=42');
    const status = page.getByRole('status');
    const settings = page.getByRole('region', { name: 'Stream settings' });
    const rate = settings.getByRole('spinbutton', { name: 'Exact rate, events per second' });
    const slider = settings.getByRole('slider', { name: 'Rate' });
    const scenario = settings.getByRole('combobox', { name: 'Scenario' });

    await expect(status).toHaveText('Connected');
    await expect(page.getByText('Scenario steady at 200 events/s, seed 42.')).toBeVisible();
    await expect.poll(() => counter(page, 'Events received')).toBeGreaterThan(0);

    // The bounds come from the server's hello: 20,000 locally, 5,000 in production.
    const minRate = Number(await rate.getAttribute('min'));
    const maxRate = Number(await rate.getAttribute('max'));
    expect(minRate).toBeLessThan(200);
    expect(maxRate).toBeGreaterThan(200);
    const min = NUMBER_FORMAT.format(minRate);
    const max = NUMBER_FORMAT.format(maxRate);

    // A typed rate above the limit is clamped and the server confirms the effective rate.
    await rate.fill(String(maxRate * 100));
    await rate.press('Enter');
    await expect(rate).toHaveValue(String(maxRate));
    await expect(settings.getByText(`Effective rate: ${max} events/s`)).toBeVisible();
    await expect(page.getByText(`Scenario steady at ${max} events/s, seed 42.`)).toBeVisible();
    await expect.poll(() => counter(page, 'Events per second')).toBeGreaterThan(1000);

    // The slider is keyboard-operable: Home goes to the lower bound, sent once it rests.
    await slider.press('Home');
    await expect(rate).toHaveValue(String(minRate));
    await expect(page.getByText(`Scenario steady at ${min} events/s, seed 42.`)).toBeVisible();

    // A new scenario takes effect on the same connection: the counters keep counting.
    const received = await counter(page, 'Events received');
    await scenario.selectOption({ label: 'Error burst' });
    await expect(page.getByText(`Scenario error-burst at ${min} events/s, seed 42.`)).toBeVisible();
    await expect(status).toHaveText('Connected');
    expect(await counter(page, 'Events received')).toBeGreaterThanOrEqual(received);

    await expectNoA11yViolations();
  });
});
