# Roadmap

<!-- current-stage: B1 -->

Each stage is a GitHub milestone; each task is an issue closed by a pull request.

| #   | Stage                 | Outcome                                               | Status  |
| --- | --------------------- | ----------------------------------------------------- | ------- |
| B1  | Foundation            | Monorepo, CI, mock server, deploy                     | Next    |
| B2  | Stream and table      | WebSocket, buffer, virtualization, follow tail, pause | Planned |
| B3  | Search and filters    | Web Worker, regex, URL state                          | Planned |
| B4  | Resilience            | Reconnection, lag indicator, SSE mode                 | Planned |
| B5  | Charts                | uPlot, chart-to-table linking                         | Planned |
| B6  | Measurements and docs | Performance table, tests, README, ADRs                | Planned |

Stretch goal after B6: loading a log file in addition to the live stream.

## B2 notes

Carried over from the B1 review of the stream page (`apps/web/src/pages/stream`):

- **Stream logic moves to `packages/core`.** The events-per-second window and the `seq`-gap accounting in `pages/stream/model/stream-store.ts` become framework-free code with an injected clock — no `performance.now()`, timers or `requestAnimationFrame` inside — tested with a fake clock like the server's generator.
- **Socket, parsing and buffer move into a Web Worker.** Strings cannot be transferred, so the worker owns the WebSocket, runs `parseServerMessage` and appends to the buffer; the UI receives compact batches (transferable arrays where possible), never raw frames.
- **The ring buffer has a hard capacity and evicts on append.** It must not rely on the UI draining it each animation frame: hidden tabs pause `requestAnimationFrame`, and a buffer that only shrinks when the UI reads it grows without bound in a background tab.
- **Rate controls clamp to `hello.limits`.** The `connected` state already keeps `limits` and `expiresAt` from `hello`; never use constants for the bounds.
