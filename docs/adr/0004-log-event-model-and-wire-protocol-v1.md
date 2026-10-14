# 0004. Log event model and wire protocol v1

- Status: Accepted
- Date: 2026-10-14

## Context

The mock server pushes 10 to 10,000+ log events per second to every viewer; the browser must keep 60 FPS while it renders them. Server and client are deployed separately (Fly.io and Cloudflare Workers), and PR previews connect to the production server, so the format must stay compatible across versions that run at the same time. The brief left the event format open.

Forces:

- **Frame overhead.** WebSocket framing, a `message` event and a `JSON.parse` per frame cost far more than the bytes of one event; at 10K events/s per-event frames would dominate main-thread time.
- **Loss detection.** Under backpressure the server may skip events, and from B4 the client reconnects and may resume. The client needs one reliable way to see that events are missing.
- **Parsing on the hot path.** Every incoming frame must be checked (it comes from the network) without a per-event cost that rivals `JSON.parse` itself.
- **Browser limits.** A browser does not expose the HTTP status of a failed WebSocket handshake; a 403 or 503 surfaces only as a bare close code 1006.
- **Debuggability.** It is a portfolio project: frames should be readable in DevTools.

## Decision

**Event model.** `LogEvent { seq, ts, level, service, host, message, traceId?, payload? }`. `level` is one of `trace | debug | info | warn | error | fatal`, ordered by severity (`LOG_LEVELS`). `payload` is free-form JSON (HTTP details, latency, ids, error stacks). Times are epoch milliseconds of the server clock.

**Transport.** One WebSocket per viewer at `/ws?v=1&rate=…&scenario=…&seed=…`, UTF-8 JSON text frames with **permessage-deflate**. The server accumulates events and sends one `batch` per 50 ms tick (`BATCH_INTERVAL_MS`), so the frame rate is at most 20 per second regardless of the event rate. A `heartbeat` per second carries `serverTime` and `lastSeq`. The first message, `hello`, gives the `streamId`, the effective settings and the deployment's limits (`minRate`, `maxRate`, `sessionMaxMs`) — the UI takes rate bounds from there, not from constants. The client changes settings with `configure` and gets the clamped result in `config`.

**Ordering and gaps.** `seq` starts at 1 and grows by one per generated event within a stream (`streamId`), including events the server drops. A gap in `seq` is the single source of truth for lost events; `batch.dropped` is informational only. `resume=<streamId>&after=<seq>` is reserved in the connection URL now so that B4 can add resumption without a version bump.

**Parsing.** Hand-written guards in `@lsv/protocol` (`parseServerMessage`, `parseClientMessage`) return `Result<Message, ProtocolError>` and never throw. They check the envelope and every scalar field, including each event of a batch, with index loops and no allocations on the success path, but they do not walk into `payload`. An unknown `type` is a distinct `unknown-type` error: the client ignores it, the server answers `error` / `unsupported` and keeps the socket open. The package has zero dependencies.

**Rejections.** Apart from a foreign `Origin` (HTTP 403 before the upgrade), the server accepts the upgrade and closes with an application code the browser can read: 4000 session expired (terminal), 4001 unsupported version (terminal — reload), 4029 busy (retry after `retry-after` seconds from the close reason).

**Compatibility.** Within a version only additive changes (optional fields, message types, close codes); a breaking change bumps `PROTOCOL_VERSION`, and the server is deployed first and keeps serving the previous version. Details and the changelog: [`docs/protocol.md`](../protocol.md).

## Consequences

- Frame count no longer scales with the event rate; the client can hand a whole batch to its buffer (and, from B3, to a worker) at once.
- Batching adds up to 50 ms of latency, well below what a human notices in a scrolling log; heartbeats still give a lag estimate when no events flow.
- Text frames stay readable in DevTools and in the golden fixtures; deflate is expected to absorb most of the repeated keys and values. Its ratio and CPU cost on the shared Fly machine are measured with the server (ADR-0005).
- Validation cost, measured on Node 24.21 with `parseServerMessage` against plain `JSON.parse` of the same batch: about +2–5% for a 25-event batch (0.03 ms) and about +50–60% for a 500-event batch (≈0.9 ms vs ≈0.6 ms) — roughly 0.7 µs per event, about 7 ms per second at 10K events/s. Acceptable now; B6 revisits it with browser measurements.
- Hand-written guards must be kept in step with the types; golden fixtures for every message type and tests for malformed variants make drift visible, and coverage of the package is gated at 90%.
- Closed enumerations (`level`, `scenario`, `error.code`) make new values a compatibility question; the rules in `docs/protocol.md` say when a value is additive.

## Alternatives considered

- **One message per event** — simplest server loop, but at 10K events/s it means 10K frames, `message` events and `JSON.parse` calls per second on the main thread, plus per-frame deflate overhead. Rejected.
- **Binary encoding (MessagePack, protobuf)** — smaller frames and possibly faster decoding, but adds a dependency or a schema compiler, loses readability, and the gain over deflated JSON is unproven for this payload. Revisit in B6 with measurements of bytes on the wire and decode time.
- **Zod (or another schema library) for validation** — precise errors and inferred types, but it builds a parsed copy and allocates on every object it visits, and it would give the protocol package its only dependency. The hand-written checks have a cost we control and measure (see Consequences). Kept out of the hot path.
- **HTTP status codes for rejections (403/503 on the handshake)** — invisible to browser code (always 1006), so the client could not tell "busy" from "network down". Kept only for foreign origins, where the client should not get a socket at all.
- **Server-Sent Events as the primary transport** — no client → server channel for `configure`; planned as an alternative mode in B4.
