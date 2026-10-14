# 0002. Toolchain baseline

- Status: Accepted
- Date: 2026-10-14

## Context

The repository standard asks for strict TypeScript, ESLint flat config, Prettier, pre-commit hooks, Conventional Commits and a CI quality gate. The same author's [pipeline-builder](https://github.com/dr1m11/pipeline-builder) already settled this toolchain in October 2026 ([its ADR-0002](https://github.com/dr1m11/pipeline-builder/blob/main/docs/adr/0002-toolchain-baseline.md)); the constraints still hold:

- TypeScript 7 (the native port) is `latest`, but `typescript-eslint` 8.71 supports `typescript >=4.8.4 <6.1.0`.
- ESLint 10 is current and ESLint 9 is out of maintenance, but `eslint-plugin-jsx-a11y` declares peer support only up to ESLint 9.

This repository differs in two ways: the mock server is Node code that should run without a build, and there is no Storybook (the UI kit is small and the flagship already demonstrates it).

## Decision

Reuse the flagship's baseline:

- **TypeScript 6.0** (`6.0.3`, pinned in the pnpm catalog), kept below 6.1 until `typescript-eslint` supports newer versions. All compiler options are explicit in `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, …).
- **ESLint 10** with `typescript-eslint` `strictTypeChecked` + `stylisticTypeChecked` through the project service; React rules (`@eslint-react`, `react-hooks`, `react-refresh`) and **`eslint-plugin-jsx-a11y-x`** (a maintained fork that supports ESLint 10) for `apps/web/src`; Vitest and Playwright plugins for tests. Boundary blocks keep `packages/*` and the two apps apart (see [0001](./0001-monorepo-layout.md)).
- **Prettier** for formatting (with the Tailwind class-sorting plugin); ESLint does not format (`eslint-config-prettier`).
- **Husky + lint-staged** run ESLint and Prettier on staged files; **commitlint** enforces Conventional Commits, a scope list and a `no-ai-attribution` rule. CI checks the PR title with the same config, because squash merges use it as the commit subject.
- Plain JS tooling (configs, Claude Code hooks, `scripts/`) is type-checked with `checkJs` and JSDoc through the root `tsconfig.json`.
- Exact versions everywhere (`saveExact`), Node 24 (`.nvmrc`, `engineStrict`), pnpm pinned via `packageManager`.

Differences from the flagship:

- **Node native type stripping for the server.** `apps/mock-server` runs `node src/main.ts` directly. `tsconfig.base.json` adds `allowImportingTsExtensions`; the server and `packages/*` use `NodeNext` resolution, explicit `.ts` in relative imports and erasable syntax only.
- **No Storybook** and none of its lint plugins, scripts or CI jobs.
- **Root scripts delegate recursively** (`pnpm --recursive --if-present`), so `pnpm verify` works at every step while packages are added one by one.

## Consequences

- No TypeScript 7 compile speed yet; revisit when `typescript-eslint` adds support (Renovate will surface it).
- Erasable-only syntax rules out enums, namespaces and parameter properties everywhere, not just on the server; union types and `as const` objects replace enums.
- The JSX a11y plugin is young; if it stalls, the fallback is the original plugin with a peer-dependency override. Runtime axe checks in Playwright back it up.
- One commitlint config is the single source of truth for local commits and PR titles.

## Alternatives considered

- **TypeScript 7 with typed linting disabled** — loses the most valuable rules (`no-floating-promises`, `no-unsafe-*`, exhaustiveness).
- **ESLint 9** — out of maintenance.
- **Biome instead of ESLint + Prettier** — faster, but no type-aware rules comparable to `typescript-eslint` and no FSD/Playwright plugins.
- **Building the server with `tsc` or a bundler** — an extra build step and source maps for no gain while Node 24 runs the sources; kept as the fallback (`tsdown`) if type stripping in Docker causes problems.
