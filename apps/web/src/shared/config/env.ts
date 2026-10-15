/** Local mock server (`pnpm dev`, `pnpm test:e2e`). */
const DEFAULT_STREAM_URL = 'ws://localhost:8787/ws';

const fromEnv = import.meta.env.VITE_STREAM_URL?.trim();

/**
 * WebSocket endpoint of the mock server, without the query (`ws://host:port/ws`). Set at build
 * time with `VITE_STREAM_URL`; production builds point it at the deployed server.
 */
export const STREAM_URL: string =
  fromEnv === undefined || fromEnv === '' ? DEFAULT_STREAM_URL : fromEnv;
