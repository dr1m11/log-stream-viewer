---
paths:
  - 'packages/protocol/**'
  - 'docs/protocol.md'
---

# packages/protocol — the wire contract

- Types, constants and pure functions only. Zero dependencies; no React, DOM, Node (`node:*`) or `ws` imports. Relative imports end in `.ts` (Node runs these files directly).
- Every message type has: a TypeScript type, a guard in `parse.ts`, unit tests and a golden fixture in `fixtures/v1/` that both server and client tests use.
- Guards check the envelope and scalar fields only. Do not deep-validate `payload` — parsing runs on the hot path for every batch.
- Expected failures return `Result<T, ProtocolError>`; never throw on bad input from the network.
- Compatibility: only additive changes (new optional fields, new message types) within a protocol version. The client ignores unknown message types; the server answers an unknown client `type` with `error` / `unsupported` and keeps the socket open.
- A breaking change bumps `PROTOCOL_VERSION`, adds a changelog entry in `docs/protocol.md`, and ships the server first, still compatible with the previous client — PR previews and cached tabs talk to the production server.
- Close codes live in `close-codes.ts` (4000 session expired — terminal, 4001 unsupported version, 4029 busy). Rate limits reach the UI through `hello.limits`, never through hard-coded constants.
- Use `/protocol-change` for any change here.
