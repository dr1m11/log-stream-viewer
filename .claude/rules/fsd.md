---
paths:
  - 'apps/web/src/**'
---

# Feature-Sliced Design in apps/web

- Layers, top to bottom: `app`, `pages`, `widgets`, `features`, `entities`, `shared`. A module may import only from layers below it.
- `app` and `shared` have no slices, only segments. Every other layer is split into slices (`pages/stream`, `features/pause-stream`, `entities/log-event`).
- Segment names: `ui` (components), `model` (state, stores, domain glue), `lib` (helpers), `api` (I/O: socket, worker client), `config` (constants, env).
- Slice and folder names are kebab-case. React component files are PascalCase (`LogTable.tsx`); everything else is kebab-case.
- Each slice exposes a public API in `index.ts` that re-exports only what other layers consume. Never deep-import another slice (`@/features/x/model/store` ✗ → `@/features/x` ✓).
- No imports between slices of the same layer. If two features need the same thing, move it down (entity or shared). Cross-entity `@x` imports are not used.
- Segments are named by purpose, not by kind (`app/error-handling` ✓; `providers`, `components`, `hooks`, `types` ✗ — Steiger rule `segments-by-purpose`). `app/` has no `ui` segment; global styles live in `app/styles`.
- Stream and domain logic (buffer, batching, reconnection, filtering) belongs in `packages/core` (from B2); the wire format comes from `@lsv/protocol`. Slices adapt them to React (stores, hooks, components).
- Use the `@/` alias for cross-layer imports and relative imports inside a slice.
- After structural changes run `pnpm lint:fsd` and fix every finding.
