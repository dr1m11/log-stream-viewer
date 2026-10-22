import { resolveStreamUrl } from './stream-url';

/**
 * WebSocket endpoint of the mock server, without the query (`ws://host:port/ws`), from
 * `VITE_STREAM_URL`. Production builds must set it (vite.config.ts fails the build otherwise);
 * dev, tests and `pnpm build:local` fall back to the local mock server.
 */
export const STREAM_URL: string = resolveStreamUrl(import.meta.env.VITE_STREAM_URL);
