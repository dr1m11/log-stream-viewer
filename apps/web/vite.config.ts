import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

import { LOCAL_STREAM_URL, streamUrlProblem } from './src/shared/config/stream-url.ts';

/**
 * Port from an environment variable, so several checkouts can run side by side. The mock server's
 * default origin allowlist only knows 5173 and 4173: on other ports set its `ALLOWED_ORIGINS`.
 */
function portFromEnv(name: string, fallback: number): number {
  const text = process.env[name]?.trim();
  if (text === undefined || text === '') return fallback;
  const port = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be a port from 1 to 65535, got ${JSON.stringify(text)}`);
  }
  return port;
}

/**
 * Validates `VITE_STREAM_URL` (shell environment or .env files) wherever it is set, and requires
 * it for production builds, so a deploy can never ship a bundle that silently connects to
 * localhost. `pnpm build:local` (mode `localhost`) builds against the local mock server instead.
 */
function streamUrlCheck(): Plugin {
  return {
    name: 'lsv:stream-url',
    configResolved({ command, mode, env }) {
      const raw: unknown = env.VITE_STREAM_URL;
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (value === '') {
        if (command === 'build' && mode === 'production') {
          throw new Error(
            'VITE_STREAM_URL is required for a production build: set it to the mock server ' +
              `endpoint (e.g. wss://log-stream-viewer-mock.fly.dev/ws). To build against the ` +
              `local mock server (${LOCAL_STREAM_URL}), run \`pnpm build:local\`.`,
          );
        }
        return;
      }
      const problem = streamUrlProblem(value);
      if (problem !== undefined) throw new Error(problem);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), streamUrlCheck()],
  resolve: {
    // Reads the `@/*` alias from tsconfig.app.json, so paths are declared once.
    tsconfigPaths: true,
  },
  build: {
    sourcemap: true,
  },
  server: {
    port: portFromEnv('WEB_PORT', 5173),
    strictPort: true,
  },
  preview: {
    port: portFromEnv('PREVIEW_PORT', 4173),
    strictPort: true,
  },
});
