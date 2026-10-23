import type { Locator, Page } from '@playwright/test';

/** What the init script records in the page, read back by the functions below. */
interface ProbeState {
  longTasks: { start: number; duration: number }[];
  /** Event Timing entries that belong to an interaction (`interactionId > 0`). */
  interactions: { name: string; start: number; duration: number; id: number }[];
  /** Labels of the scripted interactions, in order, with the time each one began. */
  marks: { label: string; time: number }[];
}

declare global {
  interface Window {
    __lsvPerf?: ProbeState;
  }
}

/** The lowest threshold Event Timing allows; shorter interactions are not reported at all. */
export const EVENT_TIMING_THRESHOLD_MS = 16;

/**
 * Init script (`page.addInitScript`): observes long tasks and Event Timing from the first script
 * on, before the app starts. Runs in the page, so it must not reference anything outside itself.
 */
export function installPageProbes(thresholdMs: number): void {
  const state: ProbeState = { longTasks: [], interactions: [], marks: [] };
  window.__lsvPerf = state;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      state.longTasks.push({ start: entry.startTime, duration: entry.duration });
    }
  }).observe({ type: 'longtask', buffered: true });
  // `durationThreshold` is missing from TypeScript's DOM types; a variable skips the excess
  // property check of an inline literal.
  const eventInit = { type: 'event', buffered: true, durationThreshold: thresholdMs };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry instanceof PerformanceEventTiming && entry.interactionId > 0) {
        state.interactions.push({
          name: entry.name,
          start: entry.startTime,
          duration: entry.duration,
          id: entry.interactionId,
        });
      }
    }
  }).observe(eventInit);
}

export interface FrameStats {
  durationMs: number;
  frames: number;
  fps: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  /**
   * The display's frame interval: the mean of the intervals within ±25% of the median. Frame
   * timestamps are rounded to 0.1 ms, so a single interval (or the median) of a 144 Hz display
   * reads 6.9 or 7.0 ms; the mean of the regular frames does not.
   */
  vsyncMs: number;
  /** Frames longer than 20 ms: below 50 FPS, a visible hitch at any refresh rate. */
  over20Ms: number;
  /** Distance the table actually scrolled, to tell a scroll run from one stuck at an edge. */
  scrolledPx: number;
  longTasks: { count: number; totalMs: number; maxMs: number };
}

export interface FrameOptions {
  durationMs: number;
  /**
   * Scrolls the table by this many pixels per second, one step per animation frame (negative is
   * up, towards older rows), reversing at either end. 0 leaves the scroll position alone.
   */
  scrollPxPerSecond: number;
}

/**
 * Collects animation-frame intervals for `durationMs` in the page, optionally scrolling the table
 * on every frame, and the long tasks that started meanwhile. The scroll is driven from inside the
 * page so its pace does not depend on round trips to the test process.
 */
export function measureFrames(table: Locator, options: FrameOptions): Promise<FrameStats> {
  return table.evaluate(
    (element, { durationMs, scrollPxPerSecond }) =>
      new Promise<FrameStats>((resolve) => {
        // Room for a 500 Hz display, so the loop never allocates.
        const intervals = new Float64Array(Math.ceil((durationMs / 1000) * 500));
        let count = 0;
        let speed = scrollPxPerSecond;
        let scrolledPx = 0;
        let begin = 0;
        let previous = 0;

        const frame = (now: number) => {
          if (count < intervals.length) intervals[count++] = now - previous;
          if (speed !== 0) {
            const top = element.scrollTop;
            element.scrollTop += (speed * (now - previous)) / 1000;
            scrolledPx += Math.abs(element.scrollTop - top);
            const bottom = element.scrollHeight - element.clientHeight;
            if (
              (speed < 0 && element.scrollTop <= 0) ||
              (speed > 0 && element.scrollTop >= bottom)
            ) {
              speed = -speed;
            }
          }
          previous = now;
          if (now - begin < durationMs) {
            requestAnimationFrame(frame);
            return;
          }
          const sorted = intervals.slice(0, count).sort();
          const at = (quantile: number) =>
            sorted[Math.min(count - 1, Math.floor(quantile * count))] ?? 0;
          const median = at(0.5);
          let over20Ms = 0;
          let regularSum = 0;
          let regularCount = 0;
          for (const interval of sorted) {
            if (interval > 20) over20Ms += 1;
            if (Math.abs(interval - median) <= median * 0.25) {
              regularSum += interval;
              regularCount += 1;
            }
          }
          const tasks = (window.__lsvPerf?.longTasks ?? []).filter(
            (task) => task.start >= begin && task.start < now,
          );
          resolve({
            durationMs: now - begin,
            frames: count,
            fps: (count * 1000) / (now - begin),
            p50Ms: median,
            p95Ms: at(0.95),
            maxMs: sorted[count - 1] ?? 0,
            vsyncMs: regularCount === 0 ? median : regularSum / regularCount,
            over20Ms,
            scrolledPx,
            longTasks: {
              count: tasks.length,
              totalMs: tasks.reduce((sum, task) => sum + task.duration, 0),
              maxMs: Math.max(0, ...tasks.map((task) => task.duration)),
            },
          });
        };
        requestAnimationFrame((now) => {
          begin = now;
          previous = now;
          requestAnimationFrame(frame);
        });
      }),
    options,
  );
}

/** Labels the interactions that follow, until the next mark, for `readInteractions`. */
export function markInteraction(page: Page, label: string): Promise<void> {
  return page.evaluate((name) => {
    window.__lsvPerf?.marks.push({ label: name, time: performance.now() });
  }, label);
}

export interface InteractionStats {
  label: string;
  /** Longest Event Timing duration of the interaction, or `null` if under the threshold. */
  maxMs: number | null;
}

/**
 * The longest event of each marked interaction. Event Timing reports an entry only after the
 * next paint, so this waits for two animation frames and a short task first.
 */
export function readInteractions(page: Page): Promise<InteractionStats[]> {
  return page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await new Promise((resolve) => setTimeout(resolve, 250));
    const state = window.__lsvPerf;
    if (state === undefined) return [];
    return state.marks.map((mark, index) => {
      const end = state.marks[index + 1]?.time ?? Number.POSITIVE_INFINITY;
      const durations = state.interactions
        .filter((entry) => entry.start >= mark.time && entry.start < end)
        .map((entry) => entry.duration);
      return { label: mark.label, maxMs: durations.length === 0 ? null : Math.max(...durations) };
    });
  });
}
