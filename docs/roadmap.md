# Roadmap

<!-- current-stage: B2 -->

Each stage is a GitHub milestone; each task is an issue closed by a pull request.

| #   | Stage                 | Outcome                                               | Status  |
| --- | --------------------- | ----------------------------------------------------- | ------- |
| B1  | Foundation            | Monorepo, CI, mock server, deploy                     | Done    |
| B2  | Stream and table      | WebSocket, buffer, virtualization, follow tail, pause | Next    |
| B3  | Search and filters    | Web Worker, regex, URL state                          | Planned |
| B4  | Resilience            | Reconnection, lag indicator, SSE mode                 | Planned |
| B5  | Charts                | uPlot, chart-to-table linking                         | Planned |
| B6  | Measurements and docs | Performance table, tests, README, ADRs                | Planned |

Stretch goal after B6: loading a log file in addition to the live stream.

## B2 notes

Carried over from the B1 review of the stream page (`apps/web/src/pages/stream`):

- **Stream logic moves to `packages/core` (done).** The events-per-second window and the `seq`-gap accounting are `StreamStats` in `@lsv/core`, with an injected clock; see [ADR-0006](./adr/0006-client-stream-pipeline.md).
- **Socket, parsing and buffer move into a Web Worker (done).** The stream worker in `entities/log-stream` owns the WebSocket, parses and buffers; the UI receives column batches with transferred typed arrays, never raw frames ([ADR-0006](./adr/0006-client-stream-pipeline.md)).
- **The ring buffer has a hard capacity and evicts on append (done).** `EventStore` in `@lsv/core` evicts during the append, so a hidden tab stays bounded ([ADR-0006](./adr/0006-client-stream-pipeline.md)).
- **Missing chunks return 404 (done).** A minimal Worker script answers a missing `/assets/…` file with 404 and `no-store`; see "Missing assets → 404" in [ADR-0003](./adr/0003-hosting.md).
- **Rate controls clamp to `hello.limits` (done).** The stream settings in `features/configure-stream` take the slider and number-input bounds from `hello.limits` and clamp typed values to them; the effective rate comes from the server's `config`.

## B6 notes

- **1M rows in Firefox.** The table's content height at 1M rows (28M px) exceeds Firefox's maximum element height (about 17.9M px), so the tail is out of reach there; add offset scaling to the table before publishing 1M numbers ([ADR-0006](./adr/0006-client-stream-pipeline.md), follow-ups).
