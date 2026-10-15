import { DEFAULT_RATE } from '@lsv/protocol';
import { describe, expect, it } from 'vitest';

import {
  CONFIG_DEFAULTS,
  DEV_ORIGINS,
  type Env,
  isOriginAllowed,
  type OriginPolicy,
  parseAllowedOrigins,
  parseConfig,
  type ServerConfig,
} from './config.ts';

function configOf(env: Env): ServerConfig {
  const result = parseConfig(env);
  if (!result.ok) throw new Error(`Unexpected config errors: ${result.error.join('; ')}`);
  return result.value;
}

function errorsOf(env: Env): string[] {
  const result = parseConfig(env);
  return result.ok ? [] : result.error;
}

const PRODUCTION: Env = {
  NODE_ENV: 'production',
  ALLOWED_ORIGINS: 'https://lsv.example.dev',
};

describe('parseConfig', () => {
  it('uses local development defaults when nothing is set', () => {
    const config = configOf({});
    expect(config).toMatchObject({
      port: 8787,
      host: '127.0.0.1',
      defaultRate: DEFAULT_RATE,
      maxRate: 20_000,
      maxConnections: 50,
      maxConnectionsPerIp: 3,
      globalMaxEventsPerSec: 20_000,
      sessionMaxMs: 30 * 60 * 1000,
      gitSha: 'dev',
      production: false,
    });
    expect([...config.origins.exact]).toEqual([...DEV_ORIGINS]);
    expect(config.origins.patterns).toEqual([]);
    expect(config.origins.allowMissing).toBe(true);
  });

  it('reads every variable', () => {
    const config = configOf({
      PORT: '9000',
      HOST: '::',
      ALLOWED_ORIGINS: 'https://a.example.dev, ^https://pr-\\d+-a\\.example\\.dev$',
      DEFAULT_RATE: '50',
      MAX_RATE: '5000',
      MAX_CONNECTIONS: '10',
      MAX_CONNECTIONS_PER_IP: '2',
      GLOBAL_MAX_EVENTS_PER_SEC: '8000',
      SESSION_MAX_MS: '60000',
      GIT_SHA: ' 0123abc ',
    });
    expect(config).toMatchObject({
      port: 9000,
      host: '::',
      defaultRate: 50,
      maxRate: 5000,
      maxConnections: 10,
      maxConnectionsPerIp: 2,
      globalMaxEventsPerSec: 8000,
      sessionMaxMs: 60_000,
      gitSha: '0123abc',
    });
    expect([...config.origins.exact]).toEqual(['https://a.example.dev']);
    expect(config.origins.patterns.map(String)).toEqual([
      '/^(?:https:\\/\\/pr-\\d+-a\\.example\\.dev)$/u',
    ]);
  });

  it('treats blank variables as unset', () => {
    expect(configOf({ PORT: '', MAX_RATE: '   ', ALLOWED_ORIGINS: '' }).port).toBe(8787);
  });

  it('lowers the default rate to a smaller MAX_RATE', () => {
    expect(configOf({ MAX_RATE: '100' }).defaultRate).toBe(100);
  });

  it('reports every invalid variable at once', () => {
    const errors = errorsOf({
      PORT: '80a',
      MAX_RATE: '5',
      MAX_CONNECTIONS: '0',
      MAX_CONNECTIONS_PER_IP: '-1',
      GLOBAL_MAX_EVENTS_PER_SEC: '1e5',
      SESSION_MAX_MS: '10',
      ALLOWED_ORIGINS: 'localhost:5173',
    });
    expect(errors).toHaveLength(7);
    expect(errors[0]).toBe('PORT must be an integer from 0 to 65535, got "80a"');
    for (const name of [
      'MAX_RATE',
      'MAX_CONNECTIONS',
      'MAX_CONNECTIONS_PER_IP',
      'GLOBAL_MAX_EVENTS_PER_SEC',
      'SESSION_MAX_MS',
      'ALLOWED_ORIGINS',
    ]) {
      expect(errors.some((error) => error.startsWith(name))).toBe(true);
    }
  });

  it('rejects a default rate above the maximum', () => {
    expect(errorsOf({ DEFAULT_RATE: '30000' })).toEqual([
      'DEFAULT_RATE must be an integer from 10 to 20000, got "30000"',
    ]);
  });

  it('requires ALLOWED_ORIGINS in production and rejects a missing Origin there', () => {
    expect(errorsOf({ NODE_ENV: 'production' })).toEqual([
      'ALLOWED_ORIGINS is required when NODE_ENV=production',
    ]);
    const config = configOf(PRODUCTION);
    expect(config.production).toBe(true);
    expect(config.host).toBe(CONFIG_DEFAULTS.productionHost);
    expect(config.origins.allowMissing).toBe(false);
  });

  it('trusts the proxy IP header in production or when asked to', () => {
    expect(configOf({}).trustProxyIpHeader).toBe(false);
    expect(configOf(PRODUCTION).trustProxyIpHeader).toBe(true);
    expect(configOf({ TRUST_PROXY_IP_HEADER: 'true' }).trustProxyIpHeader).toBe(true);
    expect(configOf({ TRUST_PROXY_IP_HEADER: '1' }).trustProxyIpHeader).toBe(true);
    expect(configOf({ ...PRODUCTION, TRUST_PROXY_IP_HEADER: 'false' }).trustProxyIpHeader).toBe(
      false,
    );
    expect(errorsOf({ TRUST_PROXY_IP_HEADER: 'yes' })).toEqual([
      'TRUST_PROXY_IP_HEADER must be true, false, 1 or 0, got "yes"',
    ]);
  });
});

describe('parseAllowedOrigins', () => {
  it('accepts exact origins and anchored regexes', () => {
    const result = parseAllowedOrigins(
      'https://a.example.dev,http://localhost:5173,,^https://pr-\\d+\\.example\\.dev$',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.value.exact]).toEqual(['https://a.example.dev', 'http://localhost:5173']);
    expect(result.value.patterns).toHaveLength(1);
  });

  it.each([
    ['https://a.example.dev/', 'not an origin'],
    ['https://a.example.dev/app', 'not an origin'],
    ['ftp://files.example.dev', 'not an origin'],
    ['*', 'not an origin'],
    ['^https://a\\.example\\.dev', 'must end with an unescaped $'],
    ['^https://a\\.example\\.dev\\$', 'must end with an unescaped $'],
    ['^https://(a\\.example\\.dev$', 'invalid regex'],
    // Balanced overall, but the body alone is not: it would close the anchoring group.
    ['^https://a\\.dev)|(.*$', 'invalid regex'],
    [' , ', 'at least one origin'],
  ])('rejects %j (%s)', (text, problem) => {
    const result = parseAllowedOrigins(text);
    expect(result.ok ? [] : result.error.join('\n')).toContain(problem);
  });

  it('turns a comma inside a regex into an error instead of a wider allowlist', () => {
    const result = parseAllowedOrigins('^https://a{1,3}\\.example\\.dev$');
    expect(result.ok).toBe(false);
  });

  it('keeps an alternation inside the anchors', () => {
    const result = parseAllowedOrigins('^https://a\\.dev|https://b\\.dev$');
    if (!result.ok) throw new Error(result.error.join('; '));
    const policy: OriginPolicy = { ...result.value, allowMissing: false };
    expect(isOriginAllowed(policy, 'https://a.dev')).toBe(true);
    expect(isOriginAllowed(policy, 'https://b.dev')).toBe(true);
    expect(isOriginAllowed(policy, 'https://a.dev.evil.test')).toBe(false);
    expect(isOriginAllowed(policy, 'https://evil.test/https://b.dev')).toBe(false);
  });

  it('accepts an escaped backslash before the final $', () => {
    expect(parseAllowedOrigins('^https://a\\.dev\\\\$').ok).toBe(true);
  });
});

describe('isOriginAllowed', () => {
  const policy: OriginPolicy = {
    exact: new Set(['https://lsv.example.dev']),
    patterns: [/^https:\/\/pr-\d+-lsv\.example\.dev$/],
    allowMissing: false,
  };

  it.each([
    ['https://lsv.example.dev', true],
    ['https://pr-12-lsv.example.dev', true],
    ['https://pr-12-lsv.example.dev.evil.test', false],
    ['http://lsv.example.dev', false],
    ['https://evil.example', false],
    ['null', false],
  ])('%s → %s', (origin, allowed) => {
    expect(isOriginAllowed(policy, origin)).toBe(allowed);
  });

  it('accepts a missing Origin only where the policy allows it', () => {
    expect(isOriginAllowed(policy, undefined)).toBe(false);
    expect(isOriginAllowed({ ...policy, allowMissing: true }, undefined)).toBe(true);
  });
});
