import { defineConfig, devices } from '@playwright/test';

const isCI = Boolean(process.env.CI);
// Same variable as vite.config.ts; `pnpm preview` inherits it.
const previewPortEnv = process.env.PREVIEW_PORT?.trim();
const previewPort = previewPortEnv === undefined || previewPortEnv === '' ? '4173' : previewPortEnv;
// `localhost`, like the default stream URL: the page origin must be in the mock server's dev
// allowlist, and the browser tries both IPv6 and IPv4 loopback while Vite and the server may each
// listen on only one of them (Vite takes the first address of `localhost`, the server 127.0.0.1).
const baseURL = `http://localhost:${previewPort}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // E2E runs against a production bundle built for the local mock server (`pnpm build:local`, or
  // `pnpm build` with VITE_STREAM_URL=ws://localhost:8787/ws as in CI). The mock server therefore
  // always listens on 8787. Neither server is reused, so a leftover dev server fails fast instead
  // of serving stale code: run `pnpm ports:free` first.
  webServer: [
    {
      name: 'mock-server',
      command: 'pnpm --filter @lsv/mock-server start',
      url: 'http://127.0.0.1:8787/healthz',
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        // The preview origin on whatever PREVIEW_PORT is in use (the default list has 4173 only).
        ALLOWED_ORIGINS: `http://localhost:${previewPort},http://127.0.0.1:${previewPort}`,
        // Parallel workers connect from the same IP; the default limit of 3 per IP is for production.
        MAX_CONNECTIONS_PER_IP: '50',
      },
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
    },
    {
      name: 'web',
      command: 'pnpm preview',
      url: baseURL,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
