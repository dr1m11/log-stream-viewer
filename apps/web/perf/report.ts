import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';

import type { HeapUsage } from './heap-probe';
import type { FrameStats, InteractionStats } from './page-probes';

export interface SizeResult {
  rows: number;
  fillSeconds: number;
  following: FrameStats;
  scrolling: FrameStats;
  interactions: InteractionStats[];
  heap: { main: HeapUsage; worker: HeapUsage | undefined };
  /** Counters at the end: anything but 0 missed events means the run is not valid. */
  missedEvents: number;
}

export interface PerfReport {
  date: string;
  machine: { cpu: string; cores: number; memoryGb: number; os: string };
  browser: string;
  /** DevTools CPU throttling of the page's main thread during the measurements (1: none). */
  cpuThrottle: number;
  /** Display refresh rate as Chromium paces animation frames: 1000 / median frame interval. */
  refreshHz: number;
  fillRate: number;
  measuredRate: number;
  results: SizeResult[];
}

export function machineInfo(): PerfReport['machine'] {
  const cpu = cpus();
  return {
    cpu: cpu[0]?.model.trim() ?? 'unknown',
    cores: cpu.length,
    memoryGb: Math.round(totalmem() / 2 ** 30),
    os: `${platform()} ${release()}`,
  };
}

const MB = 2 ** 20;
const fixed = (value: number, digits = 1) => value.toFixed(digits);
const mb = (usage: HeapUsage | undefined) =>
  usage === undefined ? 'n/a' : `${fixed(usage.total / MB, 0)} MB`;
const rowsLabel = (rows: number) =>
  rows >= 1_000_000 ? `${String(rows / 1_000_000)}M` : `${String(rows / 1000)}K`;

function maxInteraction(interactions: InteractionStats[]): string {
  const durations = interactions.flatMap(({ maxMs }) => (maxMs === null ? [] : [maxMs]));
  return durations.length === 0 ? '< 16 ms' : `${String(Math.max(...durations))} ms`;
}

/** The results as the Markdown table of docs/performance.md. */
export function markdownTable(report: PerfReport): string {
  const header = [
    '| Rows | FPS following | FPS scrolling | Frame p95 follow / scroll | Frames > 20 ms follow / scroll | Long tasks follow / scroll | Max interaction | Main heap | Worker heap |',
    '| ---- | ------------- | ------------- | ------------------------- | ------------------------------ | -------------------------- | --------------- | --------- | ----------- |',
  ];
  const rows = report.results.map(({ rows, following, scrolling, interactions, heap }) =>
    [
      rowsLabel(rows),
      fixed(following.fps, 0),
      fixed(scrolling.fps, 0),
      `${fixed(following.p95Ms)} / ${fixed(scrolling.p95Ms)} ms`,
      `${String(following.over20Ms)} / ${String(scrolling.over20Ms)}`,
      `${String(following.longTasks.count)} / ${String(scrolling.longTasks.count)}`,
      maxInteraction(interactions),
      mb(heap.main),
      mb(heap.worker),
    ].join(' | '),
  );
  return [...header, ...rows.map((row) => `| ${row} |`)].join('\n');
}

/** Writes the report as JSON to `PERF_OUT` or `perf/results/<date>.json`; returns the path. */
export function writeReport(report: PerfReport): string {
  const fallback = resolve(
    import.meta.dirname,
    'results',
    `${report.date.replaceAll(':', '-')}.json`,
  );
  const out = process.env.PERF_OUT?.trim() ?? '';
  // Relative to where `pnpm perf` was typed (pnpm's INIT_CWD), not to apps/web.
  const path = out === '' ? fallback : resolve(process.env.INIT_CWD ?? process.cwd(), out);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}
