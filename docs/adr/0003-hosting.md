# 0003. Hosting: mock server on Fly.io, web app on Cloudflare Workers

- Status: Accepted
- Date: 2026-10-22

## Context

The public demo needs two things online: the static SPA and the mock server that streams logs to it over a WebSocket ([ADR-0005](./0005-mock-server.md)). Every visitor and every PR preview talks to the same server.

Forces:

- **Instant start.** A visitor opens the link and expects logs within a second or two. A host that cold-starts for a minute after idling loses the demo.
- **Long-lived WebSockets.** A stream stays open for up to 30 minutes and pushes thousands of events per second. Request-priced serverless platforms and hosts that cut idle connections fit poorly.
- **Node + ws.** The server is plain Node 24 running TypeScript with `ws`; the brief asks for exactly that, and it is what tests and benchmarks run locally.
- **Cost.** A portfolio project: a few dollars a month at most, no surprises from traffic, and nothing that bills an idle machine all month.
- **Tiny CPU.** Whatever is cheap gives a fraction of a core, so the server's limits must be set from measurements on that fraction.

## Decision

**Mock server → Fly.io**, app `log-stream-viewer-mock` in `fra`: one `shared-cpu-1x` machine with 256 MB, `auto_stop_machines = "suspend"`, `auto_start_machines = true`, `min_machines_running = 0`. The proxy counts concurrency in connections (`soft_limit` 50, `hard_limit` 60, above the app's `MAX_CONNECTIONS` 50 so the app answers extra clients with 4029 instead of the proxy refusing them). A `/healthz` check runs every 15 s. Endpoint: `wss://log-stream-viewer-mock.fly.dev/ws`.

**Web app → Cloudflare Workers static assets**, worker `log-stream-viewer` (`apps/web/wrangler.jsonc`): assets only, no Worker script, `not_found_handling: "single-page-application"` so deep links return `index.html` with status 200, and `preview_urls` for per-PR preview aliases `pr-<number>`. Previews connect to the production mock server, so `ALLOWED_ORIGINS` lists the production origin and an anchored regex for `pr-N` previews.

**Security headers.** A Vite plugin (`apps/web/build/security-headers.ts`) writes `dist/_headers` into every build, and Cloudflare applies it to every asset response, the SPA fallback included:

- `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' <stream origin>; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`, where the stream origin comes from `VITE_STREAM_URL` (`wss://log-stream-viewer-mock.fly.dev` in production, `ws://localhost:8787` for local builds). No inline scripts or styles: the pre-paint theme script is an external file, and React sets `style` props through the CSSOM, which CSP allows;
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, a `Permissions-Policy` that turns off camera, microphone, geolocation, payment and USB, and `Cross-Origin-Opener-Policy: same-origin`;
- `Cache-Control: public, max-age=31536000, immutable` for the content-hashed files under `/assets/`.

`vite preview` reads the same `dist/_headers` and sends its headers, so e2e runs against the CSP of the build it tests, and the e2e fixture turns any CSP violation (a console error) into a failed test. The dev server sends none of them, because Vite injects inline styles and scripts there. A library that injects `<style>` elements (Radix's scroll lock, expected in B2) will need `style-src-elem 'unsafe-inline'`; that relaxation is added on purpose, with a note in this ADR, not to make a test pass.

**Image.** `apps/mock-server/Dockerfile` builds from the repository root on `node:24.21-slim` (the Node 24 minor used locally and in CI): it copies the lockfile and every workspace manifest first (so the frozen lockfile matches), installs with `pnpm install --frozen-lockfile --prod --ignore-scripts --filter @lsv/mock-server...`, then copies the `src` directories of `packages/protocol` and `apps/mock-server`. It runs as `node` with `node apps/mock-server/src/main.ts`; Node strips types from the workspace package because its real path is outside `node_modules`. `pnpm deploy` is not used: it copies the package into `node_modules`, where Node refuses type stripping. `ARG GIT_SHA` is the last layer, so a new commit only rebuilds that layer; `/healthz` reports it as `version`.

**Delivery.** `deploy.yml` runs on pushes to `main` (only commits that passed CI reach `main`), by hand with `force-server`, and on pull requests for previews:

1. `changes` decides whether the server is affected: it diffs the server's files (its app, the protocol, the lockfile, workspace files, `.dockerignore`, the smoke script, the deploy workflow) between `HEAD` and the commit production reports as `/healthz` `version`, not the push's own range, so a change whose run was cancelled while pending or failed is still deployed by the next push; an unreachable server or unknown version means "deploy";
2. `server` runs `flyctl deploy . --config apps/mock-server/fly.toml --dockerfile apps/mock-server/Dockerfile --remote-only --ha=false --build-arg GIT_SHA=$GITHUB_SHA`, then `scripts/smoke-ws.ts` through Fly's proxy with the production Origin: `/healthz` must report this commit and the stream must send `hello` and a `batch`, retrying for 30 s while the machine starts or resumes;
3. `production` deploys the web app after the server — also when `server` was skipped, never after it failed — so a client never ships before a server that speaks its protocol. It builds with `VITE_STREAM_URL=wss://log-stream-viewer-mock.fly.dev/ws`, runs `wrangler deploy`, checks that a deep link returns the app with status 200 and exactly the CSP of `dist/_headers`, then runs the Playwright smoke spec against production (`E2E_BASE_URL`): "Connected", a growing counter, a clean console and no axe violations. These checks run after the deploy and nothing rolls back automatically: a red job means the version is live, and `wrangler rollback` restores the previous one;
4. `preview` (same-repository PRs, not Renovate) builds the same way, uploads a version with `wrangler versions upload --preview-alias pr-<number>`, checks a deep link and keeps a sticky PR comment with the URL. Previews talk to the production mock server, so a PR that changes the server or the protocol cannot be tried end to end on its preview until it merges.

A deploy in progress on `main` is never cancelled (a newer push to a PR does replace its preview upload); GitHub keeps only the newest pending run of a ref, which is safe because of the comparison in step 1. CI's `server-image` job builds the same image on every PR, runs it and smoke-tests `/healthz` and the stream, so a broken Dockerfile fails before `main`.

**Limits from measurements.** Fly's `shared` vCPU gets 5 ms of every 80 ms period (6.25% of a core) plus a burst balance (5 s initially, up to 500 s) spent at up to 100% ([Fly: CPU performance](https://fly.io/docs/machines/cpu-performance/)). We measured the image on Linux (Docker Desktop on WSL2, AMD Ryzen 7 5800H) in a 256 MB container, with the clients in a separate container, permessage-deflate on, 20 s per load after a 2 s warm-up. `cpus=1` stands for a machine that still has burst balance, `--cpu-period=80000 --cpu-quota=5000` for one that has spent it.

| Sessions × events/s | CPU limit               | Delivered events/s | Server CPU, % of a core | Throttled periods | Client lag p50 / p99, ms | RSS end / peak, MB |
| ------------------- | ----------------------- | ------------------ | ----------------------- | ----------------- | ------------------------ | ------------------ |
| 1 × 5,000           | 1 core (bursting)       | 5,004              | 5.5                     | 0%                | 4 / 5                    | 101 / 101          |
| 1 × 10,000          | 1 core (bursting)       | 10,199             | 10.3                    | 0%                | 6 / 12                   | 101 / 106          |
| 50 × 200            | 1 core (bursting)       | 10,004             | 29.1                    | 0%                | 8 / 17                   | 115 / 118          |
| 50 × 400            | 1 core (bursting)       | 19,989             | 36.5                    | 0%                | 10 / 19                  | 117 / 118          |
| 1 × 5,000           | 5 ms / 80 ms (baseline) | 4,703              | 5.7                     | 43%               | 4 / 563                  | 103 / 103          |
| 1 × 10,000          | 5 ms / 80 ms (baseline) | 6,950              | 6.8                     | 97%               | 246 / 1,605              | 97 / 106           |
| 50 × 200            | 5 ms / 80 ms (baseline) | 1,722              | 6.5                     | 100%              | 5,122 / 7,856            | 118 / 122          |

So:

- **`MAX_RATE` 5,000.** One stream at the ceiling costs about 6% of a core, which is the baseline quota itself: even with the burst balance spent, a single visitor still gets ~94% of the events with sub-second lag.
- **`GLOBAL_MAX_EVENTS_PER_SEC` 10,000.** It costs 10–30% of a core depending on how many sessions share it. On burst balance that drains 4–23% of a core per second above the baseline, so a full 500 s balance covers roughly 35 minutes to 3.5 hours of saturated use — far more than a demo visit, and the balance refills while the machine idles.
- **When the balance runs out**, the server does not fall over: ticks stretch, sessions become backpressured and skip events (reported to the client as `batch.dropped`), and memory stays flat (cgroup peak ≤ 73 MB of 256 MB, RSS ≤ 122 MB in every run above). Many sessions suffer more than one (lag of seconds), which is the honest picture of an exhausted shared CPU.
- **256 MB is enough.** The worst probe — 50 clients at `rate=20000` that stop reading — peaked at 129 MB RSS and 146 MB of cgroup memory, kernel buffers included, under the baseline quota (details in [ADR-0005](./0005-mock-server.md)).

**Cost.** With deflate an event costs ~55–60 bytes on the wire ([ADR-0005](./0005-mock-server.md)). 1,000 events/s is ~0.2 GB per hour, and the 10,000 events/s ceiling ~2 GB per hour, about $0.04 per hour at Fly's $0.02/GB for Europe and North America. The machine costs about $2 per month if it ran all month; suspended, only its root filesystem is billed ($0.15 per GB-month). A normal month with occasional visitors stays within a few dollars.

## Consequences

- A visitor's first connection after idling resumes a suspended machine, which takes a moment rather than a cold boot; the smoke test retries for 30 s, and the client reconnects with backoff from B2. An open WebSocket counts as a connection, so a watched stream keeps the machine running.
- The server's limits, not the platform, are the budget protection: Origin allowlist (stops other sites, not scripts), 3 connections per address (`Fly-Client-IP`, trusted because Fly's proxy sets it), 50 in total, 30-minute sessions, 10,000 events/s shared. A script that keeps the ceiling busy around the clock could still cost ~$1 a day in traffic, so the bill is watched in the Fly dashboard, and `fly scale count 0` stops the server at once.
- Without a Worker script, the SPA fallback answers every missing path with `index.html` and status 200, including a missing `/assets/…` file, and that answer carries the `immutable` cache header of the `/assets/*` rule. A tab left open across a deploy that lazy-loads a chunk of the previous version gets HTML (blocked as a script by `nosniff`) and may cache it; after a rollback to that version the browser keeps the cached HTML for that URL. With one bundle in B1 nothing is lazy-loaded. Once code splitting arrives, a tiny Worker script fixes it: with a compatibility date from 2025-04-01, only non-navigation requests that match no asset reach the Worker, which answers 404.
- One machine, no standby (`--ha=false`): a host failure means downtime until Fly restarts it elsewhere. Acceptable for a demo.
- Limits are environment variables in `fly.toml`; changing them needs no code change, but any change should be re-measured with the same probe.
- Moving the server to another host means a new ADR that supersedes this one.

## Alternatives considered

- **Render (free web service)** — the brief's default. A free service sleeps after 15 minutes without traffic and takes about a minute to wake up, and services with heavy outbound traffic may be suspended. Both break a streaming demo that must start at once.
- **Cloudflare Durable Objects with WebSocket hibernation** — cheap and close to the SPA, but not Node + `ws`: the server would be a second implementation that tests and benchmarks do not exercise. Server-Sent Events over Workers would need a different client and protocol.
- **Fly with `auto_stop_machines = "stop"`** — cheaper by a few cents, but every first visit pays a cold boot instead of a resume.
- **A bigger or `performance` machine** — removes the burst limits, but costs many times more for headroom the demo does not need.
