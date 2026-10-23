import { defineConfig, devices } from '@playwright/test';

/**
 * Performance baseline (`pnpm perf`, docs/performance.md): the specs in `perf/` measure frame
 * times, interaction latency and heap of a production build in Chromium through CDP.
 *
 * Unlike the e2e config it builds the bundle itself, for the mock server on MOCK_PORT, so every
 * run measures the current code; and it runs one test at a time, so runs never share the CPU.
 * Always local: a deployed app adds network and server load that the numbers should not include.
 */

function portFromEnv(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value === undefined || value === '' ? fallback : value;
}

const previewPort = portFromEnv('PREVIEW_PORT', '4173');
const mockPort = portFromEnv('MOCK_PORT', '8787');
const baseURL = `http://localhost:${previewPort}`;

export default defineConfig({
  testDir: './perf',
  testMatch: '*.perf.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  // A 1M-row buffer takes about a minute to fill at the local rate ceiling.
  timeout: 5 * 60_000,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    // The full Chromium in its new headless mode: it composites like headed Chrome and paces
    // animation frames to the display, unlike the stripped-down headless shell.
    channel: 'chromium',
  },
  webServer: [
    {
      name: 'mock-server',
      command: 'pnpm --filter @lsv/mock-server start',
      url: `http://127.0.0.1:${mockPort}/healthz`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        PORT: mockPort,
        ALLOWED_ORIGINS: `http://localhost:${previewPort},http://127.0.0.1:${previewPort}`,
      },
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
    },
    {
      name: 'web',
      command: 'pnpm build:local && pnpm preview',
      url: baseURL,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { VITE_STREAM_URL: `ws://localhost:${mockPort}/ws` },
    },
  ],
});
