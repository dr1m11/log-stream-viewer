---
name: protocol-change
description: Change the WebSocket wire protocol safely across packages/protocol, the mock server and the web client — types, guards, golden fixtures, compatibility, docs. Use whenever a message, field, close code or connection parameter is added, changed or removed.
argument-hint: <what should change, e.g. "add sentAt to heartbeat">
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(pnpm test*), Bash(pnpm typecheck*), Bash(pnpm lint*), Bash(pnpm verify*)
---

# Change the wire protocol

Requested change: `$ARGUMENTS`.

1. Read `docs/protocol.md`, `.claude/rules/protocol.md` and the affected files in `packages/protocol/src/`.
2. Classify the change and say it out loud before editing:
   - **Additive** — a new optional field or a new message type. Same `PROTOCOL_VERSION`; old clients ignore it, old servers never send it.
   - **Breaking** — renaming/removing a field, changing a type or meaning, making a field required. Bump `PROTOCOL_VERSION`; the server must still serve the previous version (or close it with 4001 so the page reloads) because PR previews and open tabs use the production server.
   Prefer an additive design when one exists.
3. `packages/protocol`: update the types, the guard in `parse.ts` (envelope and scalars only), constants or close codes, and add or update golden fixtures in `fixtures/v1/` (or `fixtures/v<N>/`). Tests: valid fixtures parse, malformed variants return an error `Result`.
4. `apps/mock-server`: produce/handle the new shape in `session.ts`/`server.ts`; extend the integration test (real `ws` client on port 0) to cover it.
5. `apps/web`: update the consumer (stream client, stores). Unknown message types must stay ignored; UI limits come from `hello.limits`.
6. `docs/protocol.md`: update the message table and add a changelog line (`vN — date — change — additive/breaking`).
7. Run `pnpm verify`. Fix everything.
8. In the summary, state the classification and the deploy order: server first (the `deploy.yml` `server` job runs before `production`), then the client. Breaking changes also need an ADR (`/adr`).
