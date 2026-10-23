---
name: perf-bench
description: Measure the stream view's performance baseline with `pnpm perf` (frame times following and scrolling, long tasks, interaction latency, main and worker heap for 10K / 100K / 1M rows) and record the numbers in docs/performance.md and the PR. Use before and after a change to the stream pipeline, the table, the worker or the rendering path, or when asked for performance numbers.
argument-hint: '[sizes, e.g. 10000,100000 — default 10K, 100K and 1M]'
allowed-tools: Read, Edit, Bash(pnpm perf*), Bash(pnpm ports:free*)
---

# Measure the performance baseline

Arguments: `$ARGUMENTS` — optional comma-separated buffer sizes (`PERF_SIZES`). Method and the published numbers: `docs/performance.md`. Harness: `apps/web/perf/` with `apps/web/playwright.perf.config.ts`.

1. **When.** Measure before and after any change that touches the stream worker, `@lsv/core` buffers, the store's snapshot, the table or anything that renders per frame. A claim without numbers from both sides is not a claim (CLAUDE.md, performance rules). Measure the baseline first, on `main` or before your change, in the same session.
2. **Quiet machine.** Close heavy apps and other browsers' busy tabs; plug in a laptop; do not run e2e, builds or another `pnpm perf` at the same time — every run shares the CPU with the mock server and Chromium. Keep the display that Chromium paces frames to the same between runs (the refresh rate is in the report).
3. **Free ports.** `pnpm perf` starts its own mock server and `vite preview` and refuses to reuse running ones. On the default ports run `pnpm ports:free` first. If other checkouts or agents use 8787/4173, pick free ports instead and leave their servers alone:
   `MOCK_PORT=<port> PREVIEW_PORT=<port> pnpm perf` (the config builds the bundle for that mock port itself).
4. **Run** with `run_in_background: true` (a full run takes about 3 minutes; 1M rows take about a minute to fill): `PERF_SIZES=$ARGUMENTS pnpm perf`, or without `PERF_SIZES` for all three sizes. For a quick check while iterating, `PERF_SIZES=100000` is enough; publish only full runs.
5. **Read the output.** The test prints a Markdown table and the path of the JSON report (`apps/web/perf/results/<date>.json`, git-ignored; `PERF_OUT=<file>` writes elsewhere). Check validity first: the run fails if `Missed events` is not 0, and `scrolling.scrolledPx` in the JSON must be well above 0. Then compare:
   - FPS following / scrolling against the refresh rate (`refreshHz`): equal means no dropped frames; frame p95 against the frame budget (1000 / refresh rate);
   - frames over 20 ms and long tasks: any growth is a regression even when the FPS average hides it;
   - max interaction: a lab proxy for INP from Event Timing (`< 16 ms` means under the API's threshold), not field INP;
   - main and worker heap after a forced GC, against the per-event estimates in ADR-0006.
     Run twice when a difference is under ~10 %: single runs vary by a few frames and a few MB.
6. **Record.**
   - In the PR description: a before/after table from the two runs (same machine, same sizes) and one sentence on the cause.
   - In `docs/performance.md`: update the results table and the method (Chromium version, machine, refresh rate) when the change is meant to move the numbers or a stage closes; keep the date of the run. If a known limit there is fixed or a new one appears, update that section and the matching ADR follow-up.
7. **Clean up.** Playwright stops both servers; on Windows a child can survive — check the ports you used and run `pnpm ports:free <ports>` for leftovers of this repository only.
