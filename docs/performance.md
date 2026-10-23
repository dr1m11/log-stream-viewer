# Performance

The product spec's target (§4): a steady 60 FPS while scrolling 100K rows with a stream of 1,000+ events per second, and published FPS, INP and memory for 10K / 100K / 1M events. This page holds the lab baseline measured at the end of stage B2, how it was measured and how to reproduce it. Stage B6 extends it to other browsers and publishes the final table in the README.

## Results (B2 baseline)

Run of 2026-10-23, Chromium 156 (new headless), 144 Hz display, no CPU throttling, stream at 1,000 events/s on a full buffer:

| Rows | FPS following | FPS scrolling | Frame p95 follow / scroll | Frames > 20 ms follow / scroll | Long tasks follow / scroll | Max interaction | Main heap | Worker heap |
| ---- | ------------- | ------------- | ------------------------- | ------------------------------ | -------------------------- | --------------- | --------- | ----------- |
| 10K  | 143           | 144           | 7.0 / 7.0 ms              | 0 / 1                          | 0 / 0                      | 40 ms           | 6 MB      | 2 MB        |
| 100K | 144           | 144           | 7.0 / 7.0 ms              | 0 / 0                          | 0 / 0                      | 32 ms           | 19 MB     | 19 MB       |
| 1M   | 143           | 144           | 7.1 / 7.0 ms              | 1 / 0                          | 0 / 0                      | 48 ms           | 144 MB    | 180 MB      |

A second run, same machine, with the page's main thread slowed down 4× (`PERF_CPU_THROTTLE=4`, after the fill), roughly a slower laptop:

| Rows | FPS following | FPS scrolling | Frame p95 follow / scroll | Frames > 20 ms follow / scroll | Long tasks follow / scroll | Max interaction | Main heap | Worker heap |
| ---- | ------------- | ------------- | ------------------------- | ------------------------------ | -------------------------- | --------------- | --------- | ----------- |
| 10K  | 117           | 49            | 20.8 / 34.8 ms            | 49 / 162                       | 0 / 0                      | 192 ms          | 6 MB      | 2 MB        |
| 100K | 120           | 57            | 14.1 / 34.7 ms            | 30 / 145                       | 0 / 1                      | 184 ms          | 19 MB     | 19 MB       |
| 1M   | 116           | 58            | 20.8 / 27.8 ms            | 37 / 157                       | 0 / 1                      | 168 ms          | 145 MB    | 180 MB      |

What the numbers say:

- **Frames.** The table renders every frame of a 144 Hz display at every size, while following the tail and while scrolling through history; the p95 frame (7.0–7.1 ms) is the display's own interval of about 6.94 ms, as timestamps rounded to 0.1 ms show it. No long task (> 50 ms) occurred in any window. Over all six windows (about 4,300 frames) two frames took just over 20 ms, at most one per window, not tied to the buffer size.
- **Interactions.** The slowest scripted interaction took 48 ms (resume on a full 1M buffer, which jumps to the tail), well under the 200 ms that counts as a good INP. Typing a rate and pressing Enter, pausing, resuming and pressing End in the table stay within 16–48 ms.
- **Memory.** After a forced GC, 1M rows cost 144 MB on the main thread and 180 MB in the worker, about 325 MB for the tab, below ADR-0006's estimate of 385–400 MB made in Node; the worker comes in about 65 MB under its estimate of 245 MB. At 10K most of the main heap is the app itself (about 5 MB).
- **Headroom.** With the main thread 4× slower, following the tail still runs at about 117 FPS, but a fast sustained scroll drops to 49–58 FPS, just under the 60 FPS target, and the slowest interaction (resume) to 168–192 ms, just under 200 ms. Both are the same at 10K as at 1M rows: the cost is rendering the rows that enter the view, not the size of the buffer. That is where to optimize first when the target is a slower device.

## Method

`pnpm perf` runs [`apps/web/perf/stream-baseline.perf.ts`](../apps/web/perf/stream-baseline.perf.ts) with Playwright ([`playwright.perf.config.ts`](../apps/web/playwright.perf.config.ts)):

- **Build and servers.** The config builds the production bundle (`pnpm build:local`, pointed at the mock server's port) and serves it with `vite preview` and its production CSP, next to the local mock server (`pnpm --filter @lsv/mock-server start`). One test at a time, one connection.
- **Browser.** Playwright's Chromium in the new headless mode (`channel: 'chromium'`: the full browser, which paces animation frames to the display like headed Chrome), viewport 1280 × 720, default device scale factor.
- **Machine** (this run): AMD Ryzen 7 5800H (8 cores, 16 threads), 16 GB RAM, Windows 11, on mains power; display at 144 Hz. The refresh rate sets the ceiling of every FPS figure: on a 60 Hz display the same run shows 60.
- **Stream.** For each size the page opens with `?rate=20000&seed=42&buffer=<rows>` — the local server's rate ceiling (`MAX_RATE`) fills 1M rows in about 50 s — and waits until the table lists `<rows>` rows. It then sets the rate to 1,000 events/s through the stream settings (spinbutton and Enter, like a user) and waits for the server's confirmation and for the events-per-second counter to settle. Every measurement below runs on a full buffer that evicts as fast as events arrive.
- **Frames.** An in-page `requestAnimationFrame` loop records 5 s of frame intervals in a preallocated array: FPS is frames per second, plus the median, p95 and maximum interval and the number of frames over 20 ms. "Following" leaves the table at the tail; "scrolling" moves the table's `scrollTop` towards older rows at 6,000 px/s (about 210 rows per second, a fast and sustained wheel scroll), one step per frame, driven inside the page so its pace does not depend on the test process. Long tasks come from a `PerformanceObserver` (`longtask`) installed before the app loads.
- **Interactions (INP proxy).** Event Timing (`PerformanceObserver`, type `event`, `durationThreshold: 16`, the lowest allowed) records the duration of each scripted interaction: the rate input's Enter, End in the table (back to the tail), the pause click and the resume click. The table reports the longest one. This is a lab proxy for INP — a handful of scripted interactions on a fast machine — not field INP from real users and devices. Durations are rounded to 8 ms by the browser; `< 16 ms` means under the API's threshold.
- **Memory.** CDP `HeapProfiler.collectGarbage` and then `Runtime.getHeapUsage`, separately for the page and for the stream worker (attached through `Target.setAutoAttach`). A heap is the live V8 heap plus the ArrayBuffer backing stores (the typed-array columns of `EventStore`); the JSON report keeps both parts. MB here is 2^20 bytes. `performance.measureUserAgentSpecificMemory()` would need cross-origin isolation, which the app does not enable (ADR-0006, alternatives).
- **Validity.** A run fails if any event went missing (`Missed events` ≠ 0), if the scrolling window covered less than 80 % of the scripted distance (6,000 px/s × 5 s), or if the worker's heap could not be read. The report records the measured commit (`git rev-parse HEAD`, and whether the tree had uncommitted changes) and an approximate refresh rate: 1000 / the mean frame interval within ±25 % of the median, since single timestamps are rounded to 0.1 ms.
- **CPU throttling** (`PERF_CPU_THROTTLE=4`) slows down the page's main thread through DevTools after the buffer is full; it approximates a slower laptop, not a phone. Throttled numbers are always published next to unthrottled ones.

The run writes a JSON report (`apps/web/perf/results/<date>.json`, git-ignored, or `PERF_OUT=<file>`) and prints the Markdown table above.

## Known limits

- **Chromium only so far.** In Firefox the tail of a full 1M buffer is out of reach: 1M rows × 28 px exceed Firefox's maximum element height of about 17.9M px (Chrome allows about 33.5M px). The fix is offset scaling in the table, planned for B6 ([ADR-0006](./adr/0006-client-stream-pipeline.md), follow-ups); 100K rows (2.8M px) work in both.
- **Strings are held twice.** Messages and trace ids are cloned into every batch and kept by both stores, so both heaps grow with the buffer. At 1M rows the main thread's JS heap is 108 MB of its 144 MB (the typed-array columns are the rest), most of it those strings. The planned remedy, a UTF-8 string arena, waits until GC pauses or heap limits call for it ([ADR-0006](./adr/0006-client-stream-pipeline.md), follow-ups); the baseline shows no long tasks at 1M rows.
- **No main → worker backpressure.** The worker posts batches as soon as it has them. A stalled main thread catches up batch by batch (each at most 8,192 rows); the baseline never stalls on this machine, so a throttled or mobile measurement is where to look first ([ADR-0006](./adr/0006-client-stream-pipeline.md), follow-ups).
- **Lab conditions.** One fast desktop, a local server and a deterministic stream; network jitter, a remote server and slower devices are not in these numbers. The frame collector sees main-thread frames; compositor-only effects (checkerboarding during scroll) need a trace (`/dev-stack`, step 6).

## Reproduce

```bash
pnpm install
pnpm ports:free          # or pick free ports, see below
pnpm perf                # 10K, 100K and 1M rows, about 2 minutes
```

- `PERF_SIZES=100000 pnpm perf` measures selected sizes; `PERF_CPU_THROTTLE=4` throttles the main thread.
- `MOCK_PORT=8917 PREVIEW_PORT=4303 pnpm perf` runs next to another checkout; the config builds the bundle for that mock server port itself.
- Keep the machine quiet (no builds, tests or busy tabs) and compare runs only from the same machine and display. The Claude Code skill [`perf-bench`](../.claude/skills/perf-bench/SKILL.md) describes the before/after routine for pull requests.
