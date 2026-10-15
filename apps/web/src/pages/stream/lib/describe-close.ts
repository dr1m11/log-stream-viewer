import { CLOSE_CODES, retryAfterSeconds } from '@lsv/protocol';

import { SOCKET_FAILURE_CODES } from '@/shared/api';

/** Why the stream stopped, in words for the status badge. */
export interface CloseDescription {
  /** Short cause, e.g. "Server busy". */
  readonly title: string;
  /**
   * What the user can do about it (there is no automatic reconnect yet, B4), or the browser's
   * explanation when it refused to open the socket.
   */
  readonly advice: string;
}

/**
 * Describes a close code (`docs/protocol.md`, "Close codes", and the client's own
 * `SOCKET_FAILURE_CODES`). `wasConnected` tells a connection that dropped apart from one that
 * never got through.
 */
export function describeClose(
  code: number,
  reason: string,
  wasConnected: boolean,
): CloseDescription {
  switch (code) {
    case CLOSE_CODES.sessionExpired:
      return { title: 'Session expired', advice: 'Reload the page to start a new session.' };
    case CLOSE_CODES.unsupportedVersion:
      return {
        title: 'Unsupported protocol version',
        advice: 'Reload the page to get the current version of the app.',
      };
    case CLOSE_CODES.busy: {
      const seconds = retryAfterSeconds(reason);
      return {
        title: 'Server busy',
        advice:
          seconds === undefined
            ? 'Reload the page to try again later.'
            : `Reload the page to retry after ${String(seconds)} s.`,
      };
    }
    case CLOSE_CODES.goingAway:
      return { title: 'Server restarting', advice: 'Reload the page in a moment.' };
    case CLOSE_CODES.messageTooBig:
      return { title: 'Message rejected by the server', advice: 'Reload the page to reconnect.' };
    case CLOSE_CODES.normal:
      return { title: 'Stream ended', advice: 'Reload the page to start a new stream.' };
    case SOCKET_FAILURE_CODES.protocolError:
      return {
        title: reason === '' ? 'Protocol error' : `Protocol error: ${reason}`,
        advice: 'Reload the page to reconnect.',
      };
    case SOCKET_FAILURE_CODES.abnormalClosure:
      // Browsers never give a reason here; one from the client means the socket was never created.
      if (reason !== '') return { title: 'Cannot open the connection', advice: reason };
      return wasConnected
        ? { title: 'Connection lost', advice: 'Reload the page to reconnect.' }
        : { title: 'Server unreachable', advice: 'Check that the server is running, then reload.' };
    default:
      return {
        title: `Connection closed (code ${String(code)})`,
        advice: 'Reload the page to reconnect.',
      };
  }
}
