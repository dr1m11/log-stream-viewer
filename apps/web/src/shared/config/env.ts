import { LOCAL_STREAM_URL } from './stream-url';

const fromEnv = import.meta.env.VITE_STREAM_URL?.trim();

/**
 * WebSocket endpoint of the mock server, without the query (`ws://host:port/ws`), from
 * `VITE_STREAM_URL`. Production builds must set it (vite.config.ts fails the build otherwise);
 * dev, tests and `pnpm build:local` fall back to the local mock server.
 */
export const STREAM_URL: string =
  fromEnv === undefined || fromEnv === '' ? LOCAL_STREAM_URL : fromEnv;
