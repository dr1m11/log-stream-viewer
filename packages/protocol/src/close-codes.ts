/**
 * WebSocket close codes of the protocol: the standard ones the peers use plus application codes
 * (4000–4999). Rejections happen after the upgrade with an application code, because browsers do
 * not expose the HTTP status of a failed handshake (it surfaces as a bare 1006).
 */
export const CLOSE_CODES = {
  /** Normal closure, e.g. the client disconnected on purpose. */
  normal: 1000,
  /** The server is shutting down or redeploying. Reconnect with backoff. */
  goingAway: 1001,
  /** The client sent messages faster than the server accepts them. Reconnect with backoff. */
  policyViolation: 1008,
  /** A client frame exceeded `MAX_CLIENT_MESSAGE_BYTES`. */
  messageTooBig: 1009,
  /** The session reached `hello.limits.sessionMaxMs`. Terminal: do not reconnect automatically. */
  sessionExpired: 4000,
  /** The server does not speak the requested `?v=`. Terminal: the page must reload to get a matching client. */
  unsupportedVersion: 4001,
  /** Connection limits reached (in total or per IP). Retry after the delay given in the close reason. */
  busy: 4029,
} as const;

/** A close code listed in {@link CLOSE_CODES}. */
export type CloseCode = (typeof CLOSE_CODES)[keyof typeof CLOSE_CODES];

/**
 * Tells whether a close code ends the session for good: the client must not reconnect on its own
 * and should ask the user instead. Every other code (including unknown ones) allows a reconnect
 * with backoff.
 */
export function isTerminalCloseCode(code: number): boolean {
  return code === CLOSE_CODES.sessionExpired || code === CLOSE_CODES.unsupportedVersion;
}

/** Longest `retry-after` delay a busy server asks for, and a client honours. */
export const MAX_RETRY_AFTER_SECONDS = 3600;

const RETRY_AFTER = /(?:^|;)\s*retry-after=(\d{1,9})\s*(?:;|$)/;

/** Rounds a delay up to whole seconds within `0…MAX_RETRY_AFTER_SECONDS`; NaN means the maximum. */
function clampRetryAfter(seconds: number): number {
  if (!Number.isFinite(seconds)) return seconds < 0 ? 0 : MAX_RETRY_AFTER_SECONDS;
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(0, Math.ceil(seconds)));
}

/** Close reason for {@link CLOSE_CODES.busy}, e.g. `busy; retry-after=30`. */
export function busyCloseReason(retryAfterSeconds: number): string {
  return `busy; retry-after=${String(clampRetryAfter(retryAfterSeconds))}`;
}

/**
 * Reads the `retry-after` delay in seconds from a close reason, capped at
 * {@link MAX_RETRY_AFTER_SECONDS}; `undefined` when the reason has none.
 */
export function retryAfterSeconds(reason: string): number | undefined {
  const digits = RETRY_AFTER.exec(reason)?.[1];
  return digits === undefined ? undefined : clampRetryAfter(Number(digits));
}
