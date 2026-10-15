import { busyCloseReason } from '@lsv/protocol';
import { describe, expect, it } from 'vitest';

import { describeClose } from './describe-close';

describe('describeClose', () => {
  it.each([
    [4000, 'Session expired', 'Reload the page to start a new session.'],
    [
      4001,
      'Unsupported protocol version',
      'Reload the page to get the current version of the app.',
    ],
    [1001, 'Server restarting', 'Reload the page in a moment.'],
    [1009, 'Message rejected by the server', 'Reload the page to reconnect.'],
    [1000, 'Stream ended', 'Reload the page to start a new stream.'],
    [4999, 'Connection closed (code 4999)', 'Reload the page to reconnect.'],
  ])('explains close code %i', (code, title, advice) => {
    expect(describeClose(code, '', true)).toEqual({ title, advice });
  });

  it('tells the user when a busy server can be retried', () => {
    expect(describeClose(4029, busyCloseReason(30), false)).toEqual({
      title: 'Server busy',
      advice: 'Reload the page to retry after 30 s.',
    });
    expect(describeClose(4029, 'busy', false).advice).toBe('Reload the page to try again later.');
  });

  it('tells a dropped connection apart from one that never got through', () => {
    expect(describeClose(1006, '', true).title).toBe('Connection lost');
    expect(describeClose(1006, '', false).title).toBe('Server unreachable');
  });

  it('passes on why the browser refused to open the socket', () => {
    expect(
      describeClose(1006, 'An insecure WebSocket connection may not be initiated', false),
    ).toEqual({
      title: 'Cannot open the connection',
      advice: 'An insecure WebSocket connection may not be initiated',
    });
  });

  it('names the protocol error the client detected', () => {
    expect(describeClose(1002, 'server did not complete the handshake within 2 s', true)).toEqual({
      title: 'Protocol error: server did not complete the handshake within 2 s',
      advice: 'Reload the page to reconnect.',
    });
    expect(describeClose(1002, '', true).title).toBe('Protocol error');
  });
});
