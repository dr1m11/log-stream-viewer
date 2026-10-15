# Log Stream Viewer

Browser viewer for streaming logs: a Node mock server pushes thousands of events per second over WebSocket; the client renders them in a virtualized table (100K–1M rows), searches and filters in a Web Worker and charts event rates. Portfolio project, public repo — performance is the point.
Product scope: `docs/product-spec.md`. Stages and current stage: `docs/roadmap.md` (also GitHub milestones). Decisions: `docs/adr/`. Wire format: `docs/protocol.md`.

## Commands (run from the repo root)

| Command                            | What it does                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `pnpm dev`                         | Mock server (:8787) + Vite dev server (:5173) in parallel — long-running, start it in the background |
| `pnpm dev:web` / `pnpm dev:server` | Vite dev server only (:5173) / mock server only (`node --watch`, :8787) — long-running, background   |
| `pnpm build` / `pnpm preview`      | Production build of `apps/web` / serve it on :4173 (`vite preview`, long-running, background)        |
| `pnpm verify`                      | format check → lint → Steiger → typecheck → unit tests → hook tests → build. **Green before a PR**   |
| `pnpm verify:full`                 | `verify` + Playwright e2e                                                                            |
| `pnpm lint` / `pnpm lint:fsd`      | ESLint / Steiger (FSD boundaries)                                                                    |
| `pnpm typecheck`                   | `tsc` across the workspace                                                                           |
| `pnpm test` / `pnpm test:coverage` | Vitest projects `protocol`, `mock-server`, `web` (coverage gates in `vitest.config.ts`)              |
| `pnpm test:e2e`                    | Playwright against `vite preview` + the mock server                                                  |
| `pnpm test:hooks`                  | `node:test` for `.claude/hooks` and `scripts`                                                        |
| `pnpm bench`                       | Vitest benchmarks (`*.bench.ts`, e.g. protocol parsing)                                              |
| `pnpm serve:demo` / `pnpm lhci`    | Preview + mock server (for Lighthouse) / Lighthouse CI                                               |
| `pnpm ports:free`                  | Stop leftover dev servers of this repo on 5173/4173/8787 and their `node --watch` parents            |

## Monorepo

- `apps/web` — React 19 SPA, Feature-Sliced Design. Deployed to Cloudflare Workers static assets.
- `apps/mock-server` — Node 24 + `ws`, runs TypeScript natively (no build). Deployed to Fly.io (Docker).
- `packages/protocol` — log event model and wire messages; the only contract between server and client.
- `packages/core` (from B2) — framework-free stream engine: ring buffer, batching, reconnection, filter engine.

## Architecture rules

- Web and mock server never import each other; they share only `@lsv/protocol`.
- `packages/*` use no React, DOM or Node APIs. Domain logic lives there, slices adapt it to React.
- FSD layers: `app → pages → widgets → features → entities → shared`; import only from lower layers, use a slice only through its `index.ts`, no imports between slices of one layer. Steiger (`pnpm lint:fsd`) is the judge.
- Change the wire protocol only with `/protocol-change` (types, guards, golden fixtures, server, client, docs together).

## Performance rules (details: `.claude/rules/performance.md`)

- Never `setState` per event. Events go into a buffer outside React; the UI reads a snapshot once per animation frame.
- Every buffer has a size limit and an eviction policy.
- Filtering, search and regex run off the main thread.
- No per-event allocations in hot loops.
- Claim an improvement only with a measurement.

## TypeScript

- Strict mode. No `any`, no non-null `!`, no `as` casts except at validated boundaries.
- Named exports only; default exports only where a tool requires them (configs).
- `import type` for type-only imports. `erasableSyntaxOnly`: no enums, namespaces or parameter properties. Relative imports in `packages/*` and `apps/mock-server` end in `.ts`.

## Testing

- Tests live next to the code as `*.test.ts(x)`. RTL queries by role and accessible name; no markup snapshots.
- Seed the log generator and fake the clock; integration tests start the server on port 0.
- Every change in `packages/*` or the server comes with tests.

## Git and PRs

- Branch per task: `<type>/<kebab-summary>`. Never commit to `main`.
- Conventional Commits in English: `type(scope): summary`. Scopes are listed in `commitlint.config.js`.
- **Never add AI attribution** — no `Co-Authored-By: Claude`, no "Generated with Claude Code" — in commits, PRs or issues.
- For another checkout use `git -C <dir> …`, not `cd <dir> && git …`.
- Open PRs with `gh pr create` using `.github/pull_request_template.md`; link the issue with `Closes #N`. `/ship` does branch → verify → commit → push → PR; `/stage <id>` runs a whole roadmap stage.

## Working agreements

- Look up library APIs with `npx ctx7@latest` before relying on memory (versions here are newer than most training data).
- Ask before adding, removing or upgrading dependencies. Never edit `pnpm-lock.yaml` by hand.
- Long-running commands (dev servers, watchers, `fly logs`) run in the background; `/dev-stack` starts and checks the app.
- Architectural decisions get an ADR (`/adr <title>`).
- Definition of done: `pnpm verify` green, tests updated, docs/ADR updated when behaviour, protocol or architecture changed.
