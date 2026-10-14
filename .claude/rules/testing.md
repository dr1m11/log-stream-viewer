---
paths:
  - '**/*.test.ts'
  - '**/*.test.tsx'
  - 'apps/web/e2e/**'
---

# Testing conventions

- Vitest with explicit imports (`import { describe, expect, it, vi } from 'vitest'`); globals are off.
- Name tests by behaviour: `it('evicts the oldest events when the buffer is full')`.
- React components: Testing Library. Query by role and accessible name (`getByRole('button', { name: 'Pause' })`); fall back to label/text, never to class names or test ids unless there is no accessible handle.
- User interaction via `const user = userEvent.setup()` and `await user.click(...)`, not `fireEvent`.
- No snapshot tests of markup. Assert on behaviour and accessible output.
- Mock at module boundaries only (network, workers, time). Use `vi.useFakeTimers()` for backoff, schedulers and throttling, and restore afterwards. Stub the browser `WebSocket` with a small fake class via `vi.stubGlobal`.
- Generator tests use a fixed seed. Server integration tests listen on port 0 and connect a real `ws` client; assert `seq` continuity and use wide timing windows instead of tight "±N% in 1 s" checks.
- Protocol tests on both sides load the golden fixtures from `packages/protocol/fixtures/v1/`.
- Playwright e2e: import `test`/`expect` from `e2e/fixtures.ts` — it fails the test on console errors (including CSP violations) and provides `expectNoA11yViolations()`. Simulate connection loss with `page.routeWebSocket`.
- Locate elements with `getByRole`/`getByLabel`; never use `waitForTimeout`, wait for state with web-first assertions.
- Keep e2e scenarios few and end-to-end (user journeys from `docs/product-spec.md`); push edge cases down to unit tests.
