---
name: fsd-slice
description: Scaffold a Feature-Sliced Design slice in apps/web (pages, widgets, features or entities) with segments, a public API and test stubs. Use when adding a new page, widget, feature or entity.
argument-hint: <layer>/<slice-name> [segments, default "ui model"]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(pnpm lint:fsd*), Bash(pnpm test*), Bash(pnpm typecheck*)
---

# Create an FSD slice

Arguments: `$ARGUMENTS` — e.g. `features/pause-stream ui model` or `entities/log-event`.

1. Parse `<layer>/<slice>`. Layer must be one of `pages`, `widgets`, `features`, `entities` (`app` and `shared` have no slices — refuse and explain). Slice name must be kebab-case.
2. Check `apps/web/src/<layer>/<slice>` does not exist yet, and look at one or two existing slices on the same layer to match their style.
3. Create only the segments requested (default `ui model`):
   - `ui/<PascalName>.tsx` — a minimal named-export component, plus `ui/<PascalName>.test.tsx` (RTL, query by role).
   - `model/` — one file for the slice's state or React glue and its colocated test. Stream logic (buffer, batching, filtering) belongs in `packages/core`; the model segment subscribes to it with `useSyncExternalStore` and never stores events in React state (see `.claude/rules/performance.md`).
   - `lib/`, `api/`, `config/` — only if asked.
4. Create `index.ts` exporting only what other layers will consume (usually the main component and its prop type, or a hook).
5. Wire the slice into its consumer through the public API (`@/<layer>/<slice>`) if the user named one.
6. Run `pnpm lint:fsd`, `pnpm typecheck` and `pnpm test`; fix every finding before reporting.
7. Report the created files and the public API in a short list.
