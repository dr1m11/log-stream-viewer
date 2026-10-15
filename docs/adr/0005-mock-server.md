# 0005. Mock server: Node 24 native TypeScript, ws, deterministic generator, limits

- Status: Accepted
- Date: 2026-10-14 (updated 2026-10-15: memory bounds, admission hardening, load measurements)

## Context

The viewer needs a source of realistic logs at 10 to 10,000+ events per second. The source runs locally for development and tests and publicly on one small shared Fly.io machine that PR previews also use, so it must stay cheap and hard to abuse. It speaks wire protocol v1 ([ADR-0004](./0004-log-event-model-and-wire-protocol-v1.md), [`docs/protocol.md`](../protocol.md)).

Forces:

- **Reproducibility.** Unit and integration tests, e2e and performance measurements need the same stream for the same input.
- **Cost and abuse.** Anyone can open the public WebSocket. Connections, event volume and session length need ceilings; a foreign site must not embed the stream.
- **Browser limits.** A browser sees neither the HTTP status of a failed handshake nor the reason, only close codes after an upgrade.
- **CPU.** permessage-deflate shrinks JSON batches several times but costs CPU on a machine with a fraction of a core.
- **No build step.** Node 24 runs TypeScript directly ([ADR-0002](./0002-toolchain-baseline.md)).

## Decision

**Runtime.** `apps/mock-server` is plain TypeScript run by Node 24 (`node src/main.ts`, `node --watch` in dev): erasable syntax, `.ts` in relative imports. HTTP is `node:http`; WebSockets are [`ws`](https://github.com/websockets/ws) 8 in `noServer` mode, so the server decides about every upgrade itself.

**Structure.** Node APIs stay at the edges; the core is pure and driven by a clock argument:

| Module          | Role                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`     | Environment → `Result<ServerConfig, string[]>`, every problem reported at once. Nothing else reads `process.env`.                                 |
| `generator/`    | Seeded PRNG (mulberry32), six services, scenarios, `createGenerator({ seed, scenario }).next(count, now)`. Pure.                                  |
| `scheduler.ts`  | `eventsDue(state, now)`: rate × elapsed with a carried fraction, catch-up capped at two ticks. Pure.                                              |
| `budget.ts`     | Global events-per-second budget (a scheduler at `GLOBAL_MAX_EVENTS_PER_SEC`) and a max–min fair split per tick. Pure.                             |
| `hub.ts`        | One tick for all streams: demands → budget → flush; a stream that throws is dropped and reported once. Pure.                                      |
| `rate-limit.ts` | Token bucket for client frames. Pure.                                                                                                             |
| `client-ip.ts`  | Which address counts for the per-IP cap (trusted proxy header or socket peer) and its key (IPv4, IPv6 /64). Pure.                                 |
| `session.ts`    | Protocol v1 for one socket (`hello`, `batch`, `heartbeat`, `configure` → `config`, `error`, ping, expiry) and its memory bounds. Owns no timers.  |
| `server.ts`     | HTTP routes, upgrade admission (path, Origin, flood guard, version, capacity), the single 50 ms tick timer, metrics, logging, graceful `close()`. |
| `main.ts`       | Parses the config (exit 1 with every problem listed), listens, SIGTERM/SIGINT → close all streams with 1001 → exit.                               |

ESLint enforces the purity of `generator/`, `scheduler.ts`, `budget.ts`, `hub.ts`, `rate-limit.ts` and `client-ip.ts`: no Node built-ins or `ws`, no `Date`, `performance`, timers or `Math.random`.

**Generator.** mulberry32 seeded with the stream's `seed` (the client's or a random one from the server). Six services with traffic weights (`api-gateway` 30, `search` 18, `auth` 15, `orders` 15, `payments` 12, `notifications` 10) and 2–3 hosts each (`payments-7f9c-2`, the hex part derived from the seed). Level mix: trace 8%, debug 20%, info 55%, warn 12%, error 4.5%, fatal 0.5%. Each service has level-specific templates with payloads: HTTP method/path/status, log-normal latencies, user/order ids, amounts, and `error { name, message, stack }` for error and fatal. Trace ids are 32 hex characters; about a third of traced events continue a recent trace, so one request appears in several services. Scenarios restart their clock when selected:

- `steady` — the mix above;
- `error-burst` — every 45 s, from second 5 for 20 s, one service (chosen from the seed and the burst number) turns 30% of its events into errors;
- `traffic-spike` — every 30 s, from second 5 for 10 s, the rate is multiplied by 5 (but never above `MAX_RATE`, the real per-stream ceiling) and latencies by 2.

The same seed, scenario and sequence of `next(count, now)` calls give the same events; the content (levels, messages, payloads, traces) does not even depend on how the calls are chunked, only `ts` does.

**Timing.** One `setInterval(BATCH_INTERVAL_MS)` drives every session; it starts with the first connection and stops with the last. Each tick:

1. every session computes its due events (`eventsDue` at `min(rate × scenario multiplier, MAX_RATE)`); counting in thousandths of an event keeps odd rates exact, and after an event-loop stall a session catches up by at most two ticks — the rest is never generated, so there is no gap;
2. the global budget for the tick is split max–min fairly: small demands in full, the rest equally;
3. each session sends one `batch` of its grant (empty ticks are skipped), a `heartbeat` when a second has passed, a ping every 15 s, and closes with 4000 at `expiresAt`.

Events the budget does not grant are never generated (the effective rate drops, `seq` stays continuous). A session that throws during a tick is dropped from the hub, logged once and its socket destroyed; the other sessions keep streaming.

**Memory per session.** A client that stops reading must not be able to grow server memory — not with the stream, not by provoking replies:

- **Soft threshold, rate-aware.** About one second of the session's own stream: `clamp(rate × 300 B, 64 KiB, 1 MiB)`. Above it the session is backpressured: it skips exactly the events the budget granted it (their `seq` numbers become a gap, reported as `batch.dropped` — so `dropped` is never inflated by an oversubscribed server), and it leaves client frames unanswered. It resumes once the buffer has drained below half of the threshold (hysteresis). A one-second threshold also keeps pings from queueing behind minutes of data, so a slow but alive client is not killed by the liveness check.
- **Hard cap.** Above `MAX_BUFFERED_BYTES` (2 MiB; more only if `MAX_RATE` makes one catch-up batch on top of the largest soft threshold exceed it) the socket is terminated — checked every tick and after every send.
- **No automatic pongs.** `autoPong: false`: browsers never send pings, and answering them would queue pongs for a client that does not read. Liveness is the server's own ping every 15 s.
- **Inbound rate limit.** A token bucket per connection, `MAX_CLIENT_MESSAGES_PER_SECOND` (20) with bursts of `CLIENT_MESSAGE_BURST` (40), both in `@lsv/protocol`; a client that floods is closed with **1008** (`policyViolation`, a non-terminal code — the client may reconnect with backoff).

Worst case across sessions: a backpressured session stops at its soft threshold plus one batch (≤ 1 MiB + 0.6 MiB at the default `MAX_RATE`), so 50 sessions stay below ~80 MiB of send buffers even in theory, and the hard cap bounds any surprise at 2 MiB each. A separate global cap on buffered bytes was considered unnecessary at these numbers.

**Client messages.** The server sends only the known `error` codes. A malformed frame, a binary frame or a `configure` with an invalid field (for example a scenario this server does not know) gets `error` / `bad-message` and changes nothing; an unknown type gets `error` / `unsupported`; the socket stays open in every case. Unknown fields of `configure` are dropped by the parser. `resume` / `after` are parsed and ignored until B4: every connection starts a new stream with `resumed: false` (logged as `resume=ignored`).

**Admission and limits.**

| Limit                       | Default                                                            | Behaviour                                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Path                        | `/ws`                                                              | Other upgrade paths: HTTP 404. `GET /ws` without upgrade: 426.                                                                                                              |
| `ALLOWED_ORIGINS`           | `http://localhost:5173`, `:4173`, `http://127.0.0.1:5173`, `:4173` | Foreign `Origin`: HTTP 403 before the upgrade. Missing `Origin`: accepted locally, 403 in production.                                                                       |
| `?v=`                       | `1`                                                                | Missing, malformed or unsupported: upgrade, then close 4001.                                                                                                                |
| Flood guard                 | `MAX_CONNECTIONS` + 10 sockets (open, rejected or still closing)   | HTTP 503 before the upgrade (browsers see 1006 — acceptable for a flood; real clients get 4029 first).                                                                      |
| `MAX_CONNECTIONS`           | 50                                                                 | Upgrade, then close 4029 `busy; retry-after=30`.                                                                                                                            |
| `MAX_CONNECTIONS_PER_IP`    | 3                                                                  | Same. The address is `Fly-Client-IP` when `TRUST_PROXY_IP_HEADER` is on (default in production), else the socket peer; IPv6 counts by /64 prefix, IPv4-mapped IPv6 as IPv4. |
| `MAX_RATE` / `DEFAULT_RATE` | 20,000 / 200 (Fly sets `MAX_RATE` 5,000)                           | `rate` and `configure.rate` are clamped to `[MIN_RATE, MAX_RATE]`; the client reads `hello.limits`.                                                                         |
| `GLOBAL_MAX_EVENTS_PER_SEC` | 20,000                                                             | Shared fairly by all streams every tick.                                                                                                                                    |
| `SESSION_MAX_MS`            | 30 min                                                             | Close 4000 (terminal for the client).                                                                                                                                       |
| `maxPayload`                | 4,096 bytes (`MAX_CLIENT_MESSAGE_BYTES`)                           | Close 1009 (also checked after inflation).                                                                                                                                  |
| Client frames               | 20/s, bursts of 40                                                 | Close 1008.                                                                                                                                                                 |
| Liveness                    | ping every 15 s                                                    | No pong by the next ping: terminate.                                                                                                                                        |
| Backpressure                | ~1 s of the stream (64 KiB–1 MiB), resume below half               | Skip the granted events, report `dropped`, leave client frames unanswered.                                                                                                  |
| Send buffer hard cap        | 2 MiB                                                              | Terminate.                                                                                                                                                                  |

Every socket the server closes (rejection, expiry, shutdown) and that does not finish the closing handshake within 5 s is destroyed (ws `closeTimeout`), so it frees its slot. `ALLOWED_ORIGINS` is a comma-separated list: an entry is either an exact origin (`scheme://host[:port]`, no path or trailing slash) or an anchored regular expression that starts with `^` and ends with an unescaped `$` (`^https://pr-\d+-log-stream-viewer\.marat-gabdrashitov17\.workers\.dev$`). A regex entry is compiled as `^(?:body)$` in Unicode mode, and its body must compile on its own, so an alternation such as `^https://a\.dev|https://b\.dev$` cannot escape the anchors and a stray `)` cannot close the wrapping group. Regex entries cannot contain commas; a split one fails validation instead of widening the list. Production (`NODE_ENV=production`) must set `ALLOWED_ORIGINS` and listens on `0.0.0.0` by default; locally `HOST` defaults to `127.0.0.1`.

**Operations.** `GET /healthz` returns `{ status, version: GIT_SHA, uptimeS, connections, eventsPerSec, rssMb, eventLoopDelayMs: { p50, p99, max }, tickMs: { p50, p99, max } }`; the latencies come from `perf_hooks` histograms (`monitorEventLoopDelay` and a tick-duration histogram) over the last complete 10 s window. `GET /` returns a short text. One log line per connect, close (with the reason: `client`, `expired`, `liveness`, `buffer-overflow`, `message-rate`, `shutdown`, `error`) and rejection, with client-supplied values JSON-quoted and truncated and no payloads. A permanent `error` listener on the HTTP server logs failures such as `EMFILE` instead of crashing. `SIGTERM`/`SIGINT` close every stream with 1001, give clients 2 s to answer, destroy the rest and exit; `close()` always runs to the end, even when a client answers the close with an invalid frame.

**Compression.** permessage-deflate with `zlibDeflateOptions.level: 1` and server context takeover (the ratio comes from keys and values repeating across batches). With context takeover ws compresses every message — its `threshold` option only applies without it — so no threshold is configured.

**Measurements.** `pnpm --filter @lsv/mock-server bench:deflate` runs the server and the clients in two separate processes (so client-side JSON parsing cannot throttle the server) and reports the server's CPU (user + system time of all its threads, zlib's thread pool included, over wall time), RSS, tick duration and event-loop delay from its own histograms. Medians of 3 rounds, 8 s each after a 2 s warm-up, per mode and variant; Windows 11 desktop, AMD Ryzen 7 5800H, Node 24.21. A Linux run under a Fly-like CPU quota (Docker `--cpus`) is done with the deployment (PR5).

| Sessions × events/s | Deflate | Server CPU, % of a core (min–max) | RSS end / peak, MB | Tick p50 / p99, ms | Wire bytes per event |
| ------------------- | ------- | --------------------------------- | ------------------ | ------------------ | -------------------- |
| 1 × 20,000          | level 1 | 10.9 (7.8–12.1)                   | 99.8 / 104.8       | 3.2 / 5.0          | 55                   |
| 1 × 20,000          | off     | 7.2 (6.2–13.4)                    | 90.2 / 90.2        | 3.6 / 6.1          | 271                  |
| 10 × 2,000          | level 1 | 18.4 (15.0–20.1)                  | 108.0 / 110.3      | 4.1 / 5.5          | 57                   |
| 10 × 2,000          | off     | 7.2 (6.2–7.8)                     | 90.0 / 90.2        | 4.4 / 5.8          | 270                  |
| 50 × 400            | level 1 | 28.3 (25.9–32.8)                  | 122.2 / 125.2      | 3.7 / 5.3          | 59                   |
| 50 × 400            | off     | 11.9 (10.5–11.9)                  | 90.7 / 91.0        | 6.5 / 8.4          | 271                  |
| 50 × 10 (idle)      | level 1 | 5.8 (3.5–8.4)                     | 87.7 / 92.9        | 0.5 / 1.2          | 92                   |
| 50 × 10 (idle)      | off     | 3.5 (1.0–4.1)                     | 80.6 / 80.6        | 1.6 / 3.7          | 331                  |

All loaded modes reached the requested total (≈ 20,000 events/s). The idle server process uses about 74 MB RSS. Reading the numbers:

- Deflate cuts traffic 4.6–4.9× (≈ 270 → 55–59 bytes per event). Its CPU cost grows with the number of connections, because every connection compresses its own messages: about +4 points of a core for one 20,000 events/s stream, +16 points for the same events spread over 50 streams. Its memory is about 0.6 MB per busy connection (+31 MB for 50 × 400) and ~0.14 MB per idle one.
- Tick duration is measured directly now: 3–4 ms median and 5–6 ms p99 for 20,000 events/s, well inside the 50 ms tick. With deflate off the tick is slower at 50 streams (6.5 / 8.4 ms) because socket writes happen inside it; with deflate they move to zlib's thread pool. Generating 1,000 events takes ≈ 0.8 ms and serializing them ≈ 1 ms of that.
- Event-loop delay p99 was 33–39 ms in every mode, idle included: on Windows the timers behind `monitorEventLoopDelay` have ~15.6 ms granularity, so these numbers are a measurement floor, not load. Linux numbers (PR5) are the meaningful ones.

A smaller zlib state per connection — 8 KiB window (`serverMaxWindowBits: 13`), `memLevel: 7`, `clientNoContextTakeover` — was measured as well: 66–71 bytes per event (18–20% more traffic), RSS no lower (128 MB vs 122 MB end at 50 × 400, 109 vs 108 at 10 × 2,000) and CPU within the noise (13.1 / 12.1 / 30.0%). It was not adopted.

Compression stays on: traffic and the client's network matter more than the CPU, which the global budget bounds anyway.

## Consequences

- No build or bundling: `node --watch` restarts the sources on change, and the Docker image (PR5) runs them directly.
- Sessions and the hub are tested with a fake clock and a fake socket; integration tests run the real server on port 0 with a real `ws` client. Determinism lets tests compare whole streams.
- One tick timer keeps all batches aligned and the budget in one place. A slow tick delays every stream; measured ticks take 3–4 ms (p99 5–6 ms) at 20,000 events/s, and `/healthz` reports tick and event-loop percentiles in production so a regression is visible.
- A shared-CPU Fly machine gets only a fraction of a core. With deflate, 20,000 events/s over 50 streams took ~28% of a desktop core, so production lowers `MAX_RATE` to 5,000 and the global budget may need to go below 20,000 on that machine. The Linux run under a CPU quota (PR5), `fly metrics` and `/healthz` (tick and event-loop percentiles, RSS) decide; 10,000+ events/s remain available locally.
- Memory on the 256 MB machine: ~74 MB idle, ~125 MB peak with 50 streams at 400 events/s and deflate (Windows numbers), plus the send buffers each session may hold (bounded per session, see "Memory per session").
- `Fly-Client-IP` is honoured only with `TRUST_PROXY_IP_HEADER` (on by default in production, behind Fly's proxy, which sets it); elsewhere the socket address counts, so a client cannot dodge the per-IP cap by sending the header. Running the server publicly behind another proxy needs that proxy to overwrite the header, or the flag turned off.
- Counting IPv6 clients by /64 can put several users behind one prefix (some ISPs hand out /64s per site, not per subscriber); with a cap of 3 that is acceptable for a demo.
- Behind Fly's proxy, `bufferedAmount` may not reflect a slow browser because the proxy buffers too; verify with network throttling after the deploy (PR5).
- Budget throttling lowers the effective rate without telling the client; it is visible only in `/healthz` and in the client's own events/s counter. A server-initiated `config` could report it later.
- A seed reproduces content but not timing: the number of events per batch depends on the wall clock.

## Alternatives considered

- **Building with `tsc` or a bundler** — an extra step for no gain while Node 24 strips types ([ADR-0002](./0002-toolchain-baseline.md)); `tsdown` stays the fallback.
- **uWebSockets.js** — faster, but a native binary distributed from GitHub rather than npm, harder to pin and to build in Docker; `ws` is far below the CPU budget at the rates we serve.
- **Socket.IO** — its own framing, fallbacks and a heavier client library; the protocol (ADR-0004) needs plain WebSocket frames that DevTools and the golden fixtures show as they are.
- **Fastify or Hono for HTTP** — three routes do not justify a framework or another dependency.
- **faker.js for log content** — a large dependency with generic data and its own seeding; hand-written templates give domain-shaped logs, consistent levels and correlated traces.
- **A timer per session** — timers drift apart, the global budget could not be split fairly in one place, and tests would need fake timers for every session.
- **HTTP 503 when busy, 400 for a bad version** — invisible to browser code (a bare 1006); kept only for foreign origins, which should not get a socket at all.
- **Dropping budget-throttled events with `seq` gaps** — would make a gap mean server overload instead of a slow client; gaps are reserved for backpressure.
- **Generating events in worker threads** — unnecessary at the measured cost; revisit only if one machine must serve far more than 20,000 events/s.
