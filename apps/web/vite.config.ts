import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

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

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
