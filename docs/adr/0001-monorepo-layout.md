# 0001. Monorepo layout

- Status: Accepted
- Date: 2026-10-14

## Context

The product has two runtimes that must agree on one wire format:

- a React SPA that renders the stream (virtualized table, search in a Web Worker, charts) and will grow to many Feature-Sliced Design slices;
- a mock server on Node 24 + `ws` that generates thousands of log events per second and is deployed separately (Fly.io), while the SPA goes to Cloudflare Workers.

The event model and the messages between them change together. If each side kept its own copy of the types, drift would only show up at runtime. From stage B2 the client also needs stream logic (ring buffer, batching, reconnection, filter engine) that should be testable without React, the DOM or a browser.

## Decision

Use a pnpm workspace with three packages now and one more in B2:

- `apps/web` (`@lsv/web`) — the SPA, organised with Feature-Sliced Design (`app → pages → widgets → features → entities → shared`). Steiger checks the structure (`pnpm lint:fsd`).
- `apps/mock-server` (`@lsv/mock-server`) — Node 24 runs its TypeScript sources directly (type stripping), no build step.
- `packages/protocol` (`@lsv/protocol`) — the log event model, wire messages, guards, close codes and golden fixtures. Zero dependencies, consumed from source (`exports → ./src/index.ts`).
- `packages/core` (from B2) — framework-free stream engine: ring buffer, batching, reconnection, filter engine.

Boundaries, enforced by ESLint blocks in `eslint.config.js`:

- `apps/web` and `apps/mock-server` never import each other (neither by package name nor by relative path); they share only `@lsv/protocol`.
- `packages/*` use no React, DOM or Node APIs; `packages/protocol` also bans `ws` and Node built-ins. Their tsconfigs have no DOM lib, so browser APIs do not type-check either.
- Every package is `"type": "module"`. Relative imports in `packages/*` and `apps/mock-server` end in `.ts` (`NodeNext` + `allowImportingTsExtensions`) and use erasable syntax only, so Node can run them without a build.

Shared versions live in the pnpm `catalog`, shared compiler options in `tsconfig.base.json`, and each package registers its Vitest project in the root `vitest.config.ts`.

The original project brief called the shared package `packages/shared`. It is named `protocol` instead: `@lsv/shared` would be confused with the FSD `shared` layer (`@/shared`) inside `apps/web`, and the name says what the package is — the contract between server and client, not a place for any shared code.

## Consequences

- A protocol change touches types, guards, fixtures, server and client in one PR (`/protocol-change`); type errors show drift at compile time on both sides.
- Coverage gates apply per package (`protocol` 90%, `mock-server` 80%), so UI code does not dilute the domain metric.
- FSD slices in `apps/web` stay thin: they adapt `@lsv/protocol` and later `packages/core` to React.
- Source-first packages mean every consumer must compile or strip TypeScript; Vite, Vitest and Node 24 all do. The server's Docker image must keep workspace packages as symlinks (Node refuses to strip types inside `node_modules`).
- A little more configuration than a single app: workspace file, per-package tsconfig and scripts.

## Alternatives considered

- **Single Vite app with the server in a subfolder** — simplest start, but the browser and Node code would share one tsconfig and dependency set, and boundaries would rely on review only.
- **Separate repositories for client and server** — the protocol would need publishing and version pinning; atomic protocol changes become impossible.
- **Building packages to `dist/`** — adds a build and watch step for no benefit while there are no external consumers.
- **Nx / Turborepo** — task caching is not needed at this size; pnpm filters cover orchestration.
