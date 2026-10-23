import { expect, type Locator, type Page, test } from '@playwright/test';

import { attachHeapProbe } from './heap-probe';
import {
  EVENT_TIMING_THRESHOLD_MS,
  installPageProbes,
  markInteraction,
  measureFrames,
  readInteractions,
} from './page-probes';
import {
  machineInfo,
  markdownTable,
  type PerfReport,
  type SizeResult,
  writeReport,
} from './report';

/**
 * Performance baseline of the stream view (`pnpm perf`, method in docs/performance.md). For each
 * buffer size: fill the buffer at the server's rate ceiling, drop to the measured rate, then
 * record frames while following the tail and while scrolling, the heap of both threads, and the
 * latency of a few scripted interactions.
 */

/** Buffer sizes to measure; `PERF_SIZES=10000,100000` narrows a run (blank: all three). */
const SIZES = (process.env.PERF_SIZES ?? '')
  .split(',')
  .filter((size) => size.trim() !== '')
  .map(Number);
if (SIZES.length === 0) SIZES.push(10_000, 100_000, 1_000_000);
if (!SIZES.every(Number.isSafeInteger)) throw new Error('PERF_SIZES must list whole numbers');
/** The local mock server's rate ceiling (`MAX_RATE`): fills 1M rows in under a minute. */
const FILL_RATE = 20_000;
/** The stream rate of the product spec's target (§4: 60 FPS at 1,000+ events/s). */
const MEASURED_RATE = 1000;
const WINDOW_MS = 5000;
/** About 210 rows per second: a fast flick of the wheel, held for the whole window. */
const SCROLL_PX_PER_SECOND = -6000;
/** `PERF_CPU_THROTTLE=4` slows the page's main thread down 4× (DevTools CPU throttling). */
const CPU_THROTTLE = Number(process.env.PERF_CPU_THROTTLE?.trim() ?? '1') || 1;
if (CPU_THROTTLE < 1) throw new Error('PERF_CPU_THROTTLE must be 1 or more');

const NUMBER_FORMAT = new Intl.NumberFormat('en-US');
const results: SizeResult[] = [];
let browserVersion = 'unknown';

/** The events table, whether it is a grid or (with expandable rows) a treegrid. */
function eventsTable(page: Page): Locator {
  return page
    .getByRole('grid', { name: 'Events' })
    .or(page.getByRole('treegrid', { name: 'Events' }));
}

/** Data rows in the table (its `aria-rowcount` less the header row). */
async function rowCount(table: Locator): Promise<number> {
  return Number(await table.getAttribute('aria-rowcount')) - 1;
}

async function counter(page: Page, name: string): Promise<number> {
  const text = await page
    .getByRole('group', { name })
    .getByText(/^[\d,]+$/)
    .textContent();
  return Number((text ?? '').replaceAll(',', ''));
}

test.describe.configure({ mode: 'serial' });

test.afterAll(() => {
  if (results.length === 0) return;
  const report: PerfReport = {
    date: new Date().toISOString(),
    machine: machineInfo(),
    browser: `Chromium ${browserVersion} (new headless)`,
    cpuThrottle: CPU_THROTTLE,
    refreshHz: Math.round(1000 / (results[0]?.following.p50Ms ?? 1000)),
    fillRate: FILL_RATE,
    measuredRate: MEASURED_RATE,
    results,
  };
  const path = writeReport(report);
  const conditions = `${report.browser}, ${String(report.refreshHz)} Hz, CPU throttle ${String(CPU_THROTTLE)}×`;
  console.log(`\n${conditions}\n\n${markdownTable(report)}\n\nJSON: ${path}\n`);
});

for (const rows of SIZES) {
  test(`${NUMBER_FORMAT.format(rows)} rows at ${String(MEASURED_RATE)} events/s`, async ({
    page,
    browser,
  }) => {
    browserVersion = browser.version();
    await page.addInitScript(installPageProbes, EVENT_TIMING_THRESHOLD_MS);
    const heap = await attachHeapProbe(page);
    const table = eventsTable(page);
    const settings = page.getByRole('region', { name: 'Stream settings' });
    const rate = settings.getByRole('spinbutton', { name: 'Exact rate, events per second' });
    const pause = page.getByRole('button', { name: 'Pause stream' });

    const fillStart = Date.now();
    await page.goto(`/?rate=${String(FILL_RATE)}&seed=42&buffer=${String(rows)}`);
    await expect(page.getByRole('status')).toHaveText('Connected');
    await expect
      .poll(() => rowCount(table), { timeout: (rows / FILL_RATE) * 3000 + 30_000 })
      .toBe(rows);
    const fillSeconds = (Date.now() - fillStart) / 1000;
    // Throttles the page's main thread for the measurements, not for the fill.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });

    // Down to the measured rate through the settings, like a user: the first interaction.
    await markInteraction(page, 'rate input (Enter)');
    await rate.fill(String(MEASURED_RATE));
    await rate.press('Enter');
    await expect(
      settings.getByText(`Effective rate: ${NUMBER_FORMAT.format(MEASURED_RATE)} events/s`),
    ).toBeVisible();
    // The rate window spans a second: wait until it no longer remembers the fill.
    await expect
      .poll(() => counter(page, 'Events per second'), { timeout: 10_000 })
      .toBeLessThan(MEASURED_RATE * 1.5);

    const following = await measureFrames(table, { durationMs: WINDOW_MS, scrollPxPerSecond: 0 });
    const memory = await heap.measure();
    const scrolling = await measureFrames(table, {
      durationMs: WINDOW_MS,
      scrollPxPerSecond: SCROLL_PX_PER_SECOND,
    });

    await markInteraction(page, 'End key in the table');
    await table.press('End');
    await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeHidden();
    await markInteraction(page, 'pause click');
    await pause.click();
    await expect(pause).toHaveAttribute('aria-pressed', 'true');
    await markInteraction(page, 'resume click');
    await page.getByRole('button', { name: 'Resume' }).click();
    await expect(pause).toHaveAttribute('aria-pressed', 'false');
    const interactions = await readInteractions(page);

    const missedEvents = await counter(page, 'Missed events');
    expect(missedEvents, 'events lost on the way: the numbers would not be valid').toBe(0);
    expect(following.frames).toBeGreaterThan(0);
    results.push({
      rows,
      fillSeconds,
      following,
      scrolling,
      interactions,
      heap: memory,
      missedEvents,
    });
  });
}
