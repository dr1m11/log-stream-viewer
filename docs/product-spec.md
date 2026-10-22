# Log Stream Viewer — product spec

> Working title. Stage-by-stage plan: [roadmap](./roadmap.md). Decisions: [ADRs](./adr/README.md).

## 1. What it is

A browser-based viewer for streaming logs. A server sends thousands of events per second; the interface shows them in real time and lets the user search, filter, pause the stream and look at charts — without stutter on 100K+ rows.

## 2. Users and scenarios

The user is a developer or SRE watching the logs of a service. A demo visitor must see a live stream immediately, without any setup.

Key scenarios:

1. Open the demo → the stream is already running and the table follows the tail (auto-scrolls to the newest event).
2. Pause the stream, scroll through history, return to the tail — no events received during the pause are lost.
3. Filter by level, time range and regex — results arrive without blocking the UI.
4. Open an event and see it in full (JSON payload).
5. Raise the stream intensity in the demo settings and see that the UI keeps up.
6. Lose the connection → the interface shows the status and reconnects on its own.

## 3. Functional requirements

**Stream**

- WebSocket transport; SSE as an alternative mode, switchable in the settings.
- Reconnection with exponential backoff and jitter; connection status in the UI.
- Buffering of incoming events and batched rendering (one batch per animation frame).
- Lag indicator: how far the UI is behind the server.
- Pause, resume, follow tail; a bounded buffer with an eviction policy.

**Table**

- Virtualized table (TanStack Virtual) for 100K+ rows, up to 1M while paused.
- Columns: time, level, service, message; configurable column visibility.
- Search match highlighting; expanding a row shows the full payload.

**Search and filters**

- Filters by level, service and time range; substring and regex search.
- Runs in a Web Worker; stale queries are cancelled; match counter with next/previous navigation.
- Filter state is kept in the URL.

**Charts**

- Events over time, split by level (uPlot).
- Throttled updates; clicking the chart filters the table by time.

**Mock server**

- A Node server generates realistic logs from several services with configurable intensity (10 to 10,000+ events per second) and error-burst scenarios.
- Client and server start with a single command.
- Wire format: [protocol](./protocol.md) (added in stage B1).

## 4. Non-functional requirements

- **Performance:** a steady 60 FPS while scrolling 100K rows with a stream of 1,000+ events per second. The README publishes FPS, INP and memory for 10K / 100K / 1M events.
- **Quality:** TypeScript strict; unit tests for the buffer, parsing, filters and reconnection logic; Playwright e2e scenarios for streaming, pause, filtering and connection loss.
- **Accessibility:** keyboard navigation in the table; ARIA for the table and controls.
- **Lighthouse CI** in the pipeline.

## 5. Technology

React 19, TypeScript, Vite, TanStack Virtual, Zustand, uPlot, Web Workers, Node + `ws` for the mock server, pnpm workspaces, Vitest, Testing Library, Playwright. UI: Radix + Tailwind CSS. TanStack Query is planned for loading history beyond the in-memory buffer.

## 6. Architecture guidelines

- pnpm monorepo: `apps/web` (client), `apps/mock-server` (Node + ws), `packages/protocol` (event model and wire protocol shared by both); a framework-free `packages/core` (buffer, batching, stream stats; reconnection and filter engine later) shared by the stream worker and the main thread.
- The client follows Feature-Sliced Design; Steiger checks layer boundaries in CI.
- Transport, buffer and filtering are plain TypeScript, tested in isolation.
- Hosting: the client on Cloudflare Workers, the mock server on Fly.io.
- Decisions are recorded in [`docs/adr/`](./adr/README.md).

## 7. Repository standard

- GitHub Actions CI: lint → typecheck → Steiger → test (+coverage) → build → e2e → Lighthouse.
- ESLint (flat config), Prettier, Husky + lint-staged, commitlint, Conventional Commits in English.
- Work through branches and PRs with descriptions; roadmap in issues and milestones.
- README with a demo GIF and the performance table, MIT license, Renovate, `.env.example`.

## 8. Out of scope

Collecting real logs from external systems, server-side storage, authentication, alerting.

## 9. Open questions

- ~~Comlink or a custom message protocol for the worker~~ — decided in B2: a custom typed message protocol ([ADR-0006](./adr/0006-client-stream-pipeline.md)).
- Loading a log file in addition to the live stream (stretch goal after B6).
