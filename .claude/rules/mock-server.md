---
paths:
  - 'apps/mock-server/**'
---

# apps/mock-server — Node 24 + ws

- Node runs the TypeScript sources directly (type stripping): erasable syntax only (no enums, namespaces, parameter properties, decorators), relative imports end in `.ts`, `import type` for types. No build step; never import from `apps/web`.
- Node APIs (`node:http`, `ws`, `process`, timers) stay in `server.ts`, `session.ts` and `main.ts`. The generator (`src/generator/`), scheduler and budget are pure TypeScript.
- The generator is deterministic: randomness only from the seeded PRNG, time only from an injected clock. No `Date.now()` or `Math.random()` inside generator code.
- Configuration is parsed and validated once in `config.ts` (env → `Result`); other modules receive a typed config object.
- Limits are mandatory and covered by tests: Origin allowlist (anchored regex; missing Origin rejected in production), `maxPayload`, total and per-IP connection caps (per IP via `Fly-Client-IP`), a global events-per-second budget, `MAX_RATE`, session lifetime, ping/pong liveness, backpressure on `bufferedAmount`.
- Browsers cannot see the HTTP status of a failed WebSocket handshake. Reject a bad Origin with 403, but report capacity or version problems by accepting the upgrade and closing with an app close code from `@lsv/protocol` (4029, 4001).
- Graceful shutdown on SIGTERM/SIGINT: close sockets with 1001, stop timers, then exit.
- Logs are one line per event, no payload dumps, never log client-supplied strings unescaped.
- Integration tests start the server on port 0 with a fake clock where possible; assert `seq` continuity and use wide windows for timing.
