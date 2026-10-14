/**
 * Version of the wire protocol. The client sends it as `?v=`; the server echoes it in `hello` and
 * closes the socket with 4001 when it does not speak the requested version.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Lowest stream rate in events per second; the server clamps lower requests up to it. The ceiling
 * depends on the deployment and reaches the client in `hello.limits.maxRate`.
 */
export const MIN_RATE = 10;

/** Rate in events per second when the client does not ask for one. */
export const DEFAULT_RATE = 200;

/** The server flushes generated events as one `batch` per tick of this length. */
export const BATCH_INTERVAL_MS = 50;

/** The server sends a `heartbeat` this often. */
export const HEARTBEAT_INTERVAL_MS = 1000;

/** Largest client frame the server accepts; a bigger one closes the socket with 1009. */
export const MAX_CLIENT_MESSAGE_BYTES = 4096;

/** Seeds are unsigned 32-bit integers, so a PRNG such as mulberry32 can use them as is. */
export const MAX_SEED = 0xffff_ffff;
