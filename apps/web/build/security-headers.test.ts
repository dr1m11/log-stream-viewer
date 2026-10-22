import { describe, expect, it } from 'vitest';

import {
  contentSecurityPolicy,
  formatHeadersFile,
  headersForPath,
  parseHeadersFile,
  securityHeaderRules,
} from './security-headers.ts';

const PRODUCTION_STREAM = 'wss://log-stream-viewer-mock.fly.dev/ws';

describe('contentSecurityPolicy', () => {
  it('allows WebSocket connections to the stream origin only', () => {
    const csp = contentSecurityPolicy(`${PRODUCTION_STREAM}?rate=200`);

    expect(csp).toContain("connect-src 'self' wss://log-stream-viewer-mock.fly.dev;");
    expect(csp).not.toContain('/ws');
    expect(csp).not.toContain('rate=');
  });

  it('keeps a non-default port of the local mock server', () => {
    expect(contentSecurityPolicy('ws://localhost:8787/ws')).toContain(
      "connect-src 'self' ws://localhost:8787;",
    );
  });

  it('forbids inline code, plugins, framing and base rewrites', () => {
    const directives = contentSecurityPolicy(PRODUCTION_STREAM).split('; ');

    expect(directives).toEqual(
      expect.arrayContaining([
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ]),
    );
    expect(directives.join(' ')).not.toContain('unsafe');
  });

  it('rejects an IPv6 stream host, which CSP cannot express', () => {
    expect(() => contentSecurityPolicy('ws://[::1]:8787/ws')).toThrow('not an IPv6 address');
  });
});

describe('_headers file', () => {
  it('parses back to the rules it was written from', () => {
    const rules = securityHeaderRules(PRODUCTION_STREAM);

    expect(parseHeadersFile(formatHeadersFile(rules))).toEqual(rules);
  });

  it('accepts CRLF line endings', () => {
    expect(parseHeadersFile('/*\r\n  X-Test: 1\r\n')).toEqual([
      { path: '/*', headers: [['X-Test', '1']] },
    ]);
  });

  it.each([
    ['a placeholder', '/movies/:title\n  X-Test: 1'],
    ['an absolute URL', 'https://example.com/*\n  X-Test: 1'],
    ['a header removal', '/*\n  ! X-Test'],
    ['a header before any path', '  X-Test: 1'],
    ['a line without a colon', '/*\n  X-Test'],
  ])('rejects %s instead of serving different headers than Cloudflare', (_, text) => {
    expect(() => parseHeadersFile(text)).toThrow(/_headers line \d/);
  });
});

describe('headersForPath', () => {
  const rules = securityHeaderRules(PRODUCTION_STREAM);

  it('sends the CSP on the root and on deep links served by the SPA fallback', () => {
    for (const path of ['/', '/index.html', '/streams/abc/details']) {
      expect(headersForPath(rules, path).get('content-security-policy')).toBe(
        contentSecurityPolicy(PRODUCTION_STREAM),
      );
    }
  });

  it('marks only hashed assets as immutable', () => {
    expect(headersForPath(rules, '/assets/index-abc123.js').get('cache-control')).toContain(
      'immutable',
    );
    expect(headersForPath(rules, '/theme-init.js').has('cache-control')).toBe(false);
    expect(headersForPath(rules, '/assets-like/x.js').has('cache-control')).toBe(false);
  });

  it('joins a header set by several matching rules, as Cloudflare does', () => {
    const merged = headersForPath(
      [
        { path: '/*', headers: [['X-Test', 'a']] },
        { path: '/a.b', headers: [['x-test', 'b']] },
      ],
      '/a.b',
    );

    expect(merged.get('x-test')).toBe('a, b');
    // The dot is literal, not a regex wildcard.
    expect(headersForPath([{ path: '/a.b', headers: [['X', '1']] }], '/axb').size).toBe(0);
  });
});
