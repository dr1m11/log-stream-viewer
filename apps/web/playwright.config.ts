import { defineConfig, devices } from '@playwright/test';

const isCI = Boolean(process.env.CI);
// Same variable as vite.config.ts; `pnpm preview` inherits it.
const previewPortEnv = process.env.PREVIEW_PORT?.trim();
const previewPort = previewPortEnv === undefined || previewPortEnv === '' ? '4173' : previewPortEnv;
const mockPortEnv = process.env.MOCK_PORT?.trim();
const mockPort = mockPortEnv === undefined || mockPortEnv === '' ? '8787' : mockPortEnv;
// A deployed app (`E2E_BASE_URL=https://… pnpm test:e2e`): no local servers, the specs run against
// it and its own mock server. deploy.yml uses it to smoke-test production.
const remoteBaseURL = process.env.E2E_BASE_URL?.trim() ?? '';
const isRemote = remoteBaseURL !== '';
// `localhost`, like the default stream URL: the page origin must be in the mock server's dev
// allowlist, and the browser tries both IPv6 and IPv4 loopback while Vite and the server may each
// listen on only one of them (Vite takes the first address of `localhost`, the server 127.0.0.1).
const baseURL = isRemote ? remoteBaseURL : `http://localhost:${previewPort}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  // The production mock server allows 3 connections per address, and a retry opens new ones.
  ...(isRemote ? { workers: 1 } : {}),
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  // A suspended Fly machine resumes on the first connection, which takes a moment.
  ...(isRemote ? { expect: { timeout: 15_000 } } : {}),
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // E2E runs against a production bundle built for the local mock server (`pnpm build:local`, or
  // `pnpm build` with VITE_STREAM_URL=ws://localhost:8787/ws as in CI). The mock server listens on
  // 8787 unless MOCK_PORT is set, for a second checkout next to the first; the bundle must then be
  // built with the matching VITE_STREAM_URL. Neither server is reused, so a leftover dev server
  // fails fast instead of serving stale code: run `pnpm ports:free` first.
  webServer: isRemote
    ? []
    : [
        {
          name: 'mock-server',
          command: 'pnpm --filter @lsv/mock-server start',
          url: `http://127.0.0.1:${mockPort}/healthz`,
          reuseExistingServer: false,
          timeout: 30_000,
          env: {
            PORT: mockPort,
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
