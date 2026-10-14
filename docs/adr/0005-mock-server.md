# 0005. Mock server: Node 24 native TypeScript, ws, deterministic generator, limits

- Status: Accepted
- Date: 2026-10-14

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

| Module         | Role                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`    | Environment → `Result<ServerConfig, string[]>`, every problem reported at once. Nothing else reads `process.env`.           |
| `generator/`   | Seeded PRNG (mulberry32), six services, scenarios, `createGenerator({ seed, scenario }).next(count, now)`. Pure.            |
| `scheduler.ts` | `eventsDue(state, now)`: rate × elapsed with a carried fraction, catch-up capped at two ticks. Pure.                        |
| `budget.ts`    | Global events-per-second budget (a scheduler at `GLOBAL_MAX_EVENTS_PER_SEC`) and a max–min fair split per tick. Pure.       |
| `hub.ts`       | One tick for all streams: demands → budget → flush; measures events/s for `/healthz`. Pure.                                 |
| `session.ts`   | Protocol v1 for one socket (`hello`, `batch`, `heartbeat`, `configure` → `config`, `error`, ping, expiry). Owns no timers.  |
| `server.ts`    | HTTP routes, upgrade admission (path, Origin, version, capacity), the single 50 ms tick timer, logging, graceful `close()`. |
| `main.ts`      | Parses the config (exit 1 with every problem listed), listens, SIGTERM/SIGINT → close all streams with 1001 → exit.         |

ESLint enforces the purity of `generator/`, `scheduler.ts`, `budget.ts` and `hub.ts`: no Node built-ins or `ws`, no `Date`, `performance`, timers or `Math.random`.

**Generator.** mulberry32 seeded with the stream's `seed` (the client's or a random one from the server). Six services with traffic weights (`api-gateway` 30, `search` 18, `auth` 15, `orders` 15, `payments` 12, `notifications` 10) and 2–3 hosts each (`payments-7f9c-2`, the hex part derived from the seed). Level mix: trace 8%, debug 20%, info 55%, warn 12%, error 4.5%, fatal 0.5%. Each service has level-specific templates with payloads: HTTP method/path/status, log-normal latencies, user/order ids, amounts, and `error { name, message, stack }` for error and fatal. Trace ids are 32 hex characters; about a third of traced events continue a recent trace, so one request appears in several services. Scenarios restart their clock when selected:

- `steady` — the mix above;
- `error-burst` — every 45 s, from second 5 for 20 s, one service (chosen from the seed and the burst number) turns 30% of its events into errors;
- `traffic-spike` — every 30 s, from second 5 for 10 s, the rate is multiplied by 5 and latencies by 2.

The same seed, scenario and sequence of `next(count, now)` calls give the same events; the content (levels, messages, payloads, traces) does not even depend on how the calls are chunked, only `ts` does.

**Timing.** One `setInterval(BATCH_INTERVAL_MS)` drives every session; it starts with the first connection and stops with the last. Each tick:

1. every session computes its due events (`eventsDue` at `rate × scenario multiplier`); counting in thousandths of an event keeps odd rates exact, and after an event-loop stall a session catches up by at most two ticks — the rest is never generated, so there is no gap;
2. the global budget for the tick is split max–min fairly: small demands in full, the rest equally;
3. each session sends one `batch` of its grant (empty ticks are skipped), a `heartbeat` when a second has passed, a ping every 15 s, and closes with 4000 at `expiresAt`.

Events the budget does not grant are never generated (the effective rate drops, `seq` stays continuous). **Backpressure** is different: while `bufferedAmount` exceeds 4 MiB the session skips generation but still assigns the `seq` numbers, so the client sees the gap and the next batch reports `dropped`.

**Client messages.** The server sends only the known `error` codes. A malformed frame, a binary frame or a `configure` with an invalid field (for example a scenario this server does not know) gets `error` / `bad-message` and changes nothing; an unknown type gets `error` / `unsupported`; the socket stays open in every case. Unknown fields of `configure` are dropped by the parser. `resume` / `after` are parsed and ignored until B4: every connection starts a new stream with `resumed: false` (logged as `resume=ignored`).

**Admission and limits.**

| Limit                       | Default                                                            | Behaviour                                                                                             |
| --------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Path                        | `/ws`                                                              | Other upgrade paths: HTTP 404. `GET /ws` without upgrade: 426.                                        |
| `ALLOWED_ORIGINS`           | `http://localhost:5173`, `:4173`, `http://127.0.0.1:5173`, `:4173` | Foreign `Origin`: HTTP 403 before the upgrade. Missing `Origin`: accepted locally, 403 in production. |
| `?v=`                       | `1`                                                                | Missing, malformed or unsupported: upgrade, then close 4001.                                          |
| `MAX_CONNECTIONS`           | 50                                                                 | Upgrade, then close 4029 `busy; retry-after=30`.                                                      |
| `MAX_CONNECTIONS_PER_IP`    | 3                                                                  | Same; the IP is `Fly-Client-IP`, else the socket peer.                                                |
| `MAX_RATE` / `DEFAULT_RATE` | 20,000 / 200 (Fly sets `MAX_RATE` 5,000)                           | `rate` and `configure.rate` are clamped to `[MIN_RATE, MAX_RATE]`; the client reads `hello.limits`.   |
| `GLOBAL_MAX_EVENTS_PER_SEC` | 20,000                                                             | Shared fairly by all streams every tick.                                                              |
| `SESSION_MAX_MS`            | 30 min                                                             | Close 4000 (terminal for the client).                                                                 |
| `maxPayload`                | 4,096 bytes (`MAX_CLIENT_MESSAGE_BYTES`)                           | Close 1009 (also checked after inflation).                                                            |
| Liveness                    | ping every 15 s                                                    | No pong by the next ping: terminate.                                                                  |
| Backpressure                | 4 MiB `bufferedAmount`                                             | Skip generation, report `dropped`.                                                                    |

A rejected socket that does not finish the closing handshake within 5 s is destroyed. `ALLOWED_ORIGINS` is a comma-separated list: an entry is either an exact origin (`scheme://host[:port]`, no path or trailing slash) or an anchored regular expression that starts with `^` and ends with `$` (`^https://pr-\d+-log-stream-viewer\.marat-gabdrashitov17\.workers\.dev$`); regex entries cannot contain commas, and a split one fails validation instead of widening the list. Production (`NODE_ENV=production`) must set `ALLOWED_ORIGINS` and listens on `0.0.0.0` by default; locally `HOST` defaults to `127.0.0.1`.

**Operations.** `GET /healthz` returns `{ status, version: GIT_SHA, uptimeS, connections, eventsPerSec }`; `GET /` a short text. One log line per connect, close and rejection, with client-supplied values JSON-quoted and truncated and no payloads. `SIGTERM`/`SIGINT` close every stream with 1001, give clients 2 s to answer, destroy the rest and exit.

**Compression.** permessage-deflate with `zlibDeflateOptions.level: 1` and `threshold: 1024` bytes (heartbeats and small batches go uncompressed). Measured with `pnpm --filter @lsv/mock-server bench:deflate` (one client at 10,000 events/s, 10 s per run, 3 alternating rounds per mode; server in its own process, CPU = user + system time of all its threads / wall time; Node 24.21, Windows 11, AMD Ryzen 7 5800H):

| Mode           | Server CPU, median (range) | Bytes per event on the wire | Wire throughput | JSON throughput |
| -------------- | -------------------------- | --------------------------- | --------------- | --------------- |
| deflate, lvl 1 | 8.1% (8.0–9.7%) of a core  | 55–56                       | ≈ 540 KB/s      | ≈ 2.6 MB/s      |
| off            | 5.2% (4.5–7.9%) of a core  | 270                         | ≈ 2.6 MB/s      | ≈ 2.6 MB/s      |

A single run at 20,000 events/s gave 17.3% with deflate and 14.5% without (1.1 MB/s vs 5.3 MB/s on the wire). Compression costs about 3 percentage points of a desktop core per 10,000 events/s and cuts traffic 4.8×, so it stays on: egress and the client's network matter more than a few percent of CPU.

## Consequences

- No build or bundling: `node --watch` restarts the sources on change, and the Docker image (PR5) runs them directly.
- Sessions and the hub are tested with a fake clock and a fake socket; integration tests run the real server on port 0 with a real `ws` client. Determinism lets tests compare whole streams.
- One tick timer keeps all batches aligned and the budget in one place. A slow tick delays every stream; the measured cost (about 5–8% of a core at 10,000 events/s) works out to roughly 2.5–4 ms per 50 ms tick.
- A shared-CPU Fly machine gets only a fraction of a core, which is why production lowers `MAX_RATE` to 5,000 while the global budget stays at 20,000. Watch `fly metrics` after the first deploy (PR5) and lower the ceilings if the machine is throttled; 10,000+ events/s remain available locally.
- `Fly-Client-IP` is trusted as is. That is safe only behind Fly's proxy, which sets it; locally a client can spoof it to dodge the per-IP cap (harmless). Running the server publicly elsewhere would need a trusted-proxy switch.
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
