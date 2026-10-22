import { describe, expect, it, vi } from 'vitest';

import worker, { type Env } from './main.ts';

const ORIGIN = 'https://log-stream-viewer.example.workers.dev';

function fakeEnv() {
  const fetch = vi.fn((request: Request) =>
    Promise.resolve(new Response(`asset ${new URL(request.url).pathname}`, { status: 200 })),
  );
  const env: Env = { ASSETS: { fetch } };
  return { env, fetch };
}

describe('the Worker script', () => {
  it.each(['/assets/index-0123abcd.js', '/assets/stream.worker-deadbeef.js', '/assets/'])(
    'answers a missing %s with an uncached 404 without asking the assets binding',
    async (path) => {
      const { env, fetch } = fakeEnv();

      const response = await worker.fetch(new Request(`${ORIGIN}${path}`), env);

      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      await expect(response.text()).resolves.toBe('Not found\n');
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(['/streams/smoke?deep=link', '/', '/assets', '/assetsfoo.js', '/favicon.ico'])(
    'hands %s to the assets binding for the SPA fallback',
    async (path) => {
      const { env, fetch } = fakeEnv();
      const request = new Request(`${ORIGIN}${path}`);

      const response = await worker.fetch(request, env);

      expect(fetch).toHaveBeenCalledExactlyOnceWith(request);
      expect(response.status).toBe(200);
    },
  );
});
