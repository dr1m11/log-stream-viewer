# Roadmap

<!-- current-stage: B3 -->

Each stage is a GitHub milestone; each task is an issue closed by a pull request.

| #   | Stage                 | Outcome                                               | Status  |
| --- | --------------------- | ----------------------------------------------------- | ------- |
| B1  | Foundation            | Monorepo, CI, mock server, deploy                     | Done    |
| B2  | Stream and table      | WebSocket, buffer, virtualization, follow tail, pause | Done    |
| B3  | Search and filters    | Web Worker, regex, URL state                          | Next    |
| B4  | Resilience            | Reconnection, lag indicator, SSE mode                 | Planned |
| B5  | Charts                | uPlot, chart-to-table linking                         | Planned |
| B6  | Measurements and docs | Performance table, tests, README, ADRs                | Planned |

Stretch goal after B6: loading a log file in addition to the live stream.

## B2 notes

Done: the stream worker, the columnar ring buffer in `@lsv/core`, the virtualized table with follow tail, pause, event details and stream settings ([ADR-0006](./adr/0006-client-stream-pipeline.md)), with e2e scenarios and a first performance baseline ([docs/performance.md](./performance.md)). Still open from it:

- **Pipeline follow-ups.** No main → worker backpressure and strings held by both threads; the baseline shows neither as a problem up to 1M rows on a desktop CPU, so they wait for a measurement that does ([ADR-0006](./adr/0006-client-stream-pipeline.md), follow-ups).

## B3 notes

- **Column visibility** (product spec §3, Table) moved to B3 from B2.

## B6 notes

- **1M rows in Firefox.** The table's content height at 1M rows (28M px) exceeds Firefox's maximum element height (about 17.9M px), so the tail is out of reach there; add offset scaling to the table before publishing 1M numbers as supported in every browser (the B2 baseline in [docs/performance.md](./performance.md) is Chromium only) ([ADR-0006](./adr/0006-client-stream-pipeline.md), follow-ups).
