/** The local mock server (`pnpm dev`, `pnpm build:local`, e2e). */
export const LOCAL_STREAM_URL = 'ws://localhost:8787/ws';

/**
 * Checks a stream endpoint from `VITE_STREAM_URL`: an absolute `ws:` or `wss:` URL without a
 * fragment (the WebSocket constructor rejects fragments). Returns the problem, or `undefined`.
 * Shared by vite.config.ts, which fails the build on a bad value, and the app.
 */
export function streamUrlProblem(value: string): string | undefined {
  const expected = `an absolute ws: or wss: URL such as ${LOCAL_STREAM_URL}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `VITE_STREAM_URL must be ${expected}, got ${JSON.stringify(value)}`;
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    return `VITE_STREAM_URL must be ${expected}, got the ${url.protocol} URL ${JSON.stringify(value)}`;
  }
  if (url.hash !== '') {
    return `VITE_STREAM_URL must not have a #fragment, got ${JSON.stringify(value)}`;
  }
  return undefined;
}
