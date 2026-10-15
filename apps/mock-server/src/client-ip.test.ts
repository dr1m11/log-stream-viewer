import { describe, expect, it } from 'vitest';

import { clientAddress, expandIpv6, ipKey } from './client-ip.ts';

describe('clientAddress', () => {
  it('uses the proxy header only when the deployment trusts it', () => {
    expect(clientAddress('203.0.113.7', '10.0.0.1', true)).toBe('203.0.113.7');
    expect(clientAddress(['203.0.113.7', '1.1.1.1'], '10.0.0.1', true)).toBe('203.0.113.7');
    expect(clientAddress('203.0.113.7', '10.0.0.1', false)).toBe('10.0.0.1');
  });

  it('falls back to the socket peer for a missing or blank header', () => {
    expect(clientAddress(undefined, '10.0.0.1', true)).toBe('10.0.0.1');
    expect(clientAddress('  ', '10.0.0.1', true)).toBe('10.0.0.1');
    expect(clientAddress(undefined, undefined, false)).toBe('unknown');
  });

  it('cuts an oversized header value', () => {
    expect(clientAddress('x'.repeat(500), undefined, true)).toHaveLength(64);
  });
});

describe('expandIpv6', () => {
  it.each([
    ['::1', [0, 0, 0, 0, 0, 0, 0, 1]],
    ['2001:db8::', [0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]],
    ['2001:db8:0:0:1:2:3:4', [0x2001, 0xdb8, 0, 0, 1, 2, 3, 4]],
    ['::ffff:192.0.2.1', [0, 0, 0, 0, 0, 0xffff, 0xc000, 0x0201]],
  ])('expands %s', (address, groups) => {
    expect(expandIpv6(address)).toEqual(groups);
  });

  it.each(['1:2:3', '1::2::3', '1:2:3:4:5:6:7:8:9', '1:2:3:4::5:6:7:8', 'g::1', '::1.2.3.256'])(
    'rejects %s',
    (address) => {
      expect(expandIpv6(address)).toBeUndefined();
    },
  );
});

describe('ipKey', () => {
  it('keeps IPv4 addresses and unwraps IPv4-mapped IPv6', () => {
    expect(ipKey('203.0.113.7')).toBe('203.0.113.7');
    expect(ipKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(ipKey('::FFFF:cb00:7107')).toBe('203.0.113.7');
  });

  it('counts IPv6 addresses by their /64 prefix', () => {
    const a = ipKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    expect(a).toBe('2001:db8:1:2::/64');
    expect(ipKey('2001:0db8:0001:0002::1')).toBe(a);
    expect(ipKey('[2001:db8:1:2::42%eth0]')).toBe(a);
    expect(ipKey('2001:db8:1:3::1')).not.toBe(a);
    expect(ipKey('::1')).toBe('0:0:0:0::/64');
  });

  it('uses anything else verbatim', () => {
    expect(ipKey('unknown')).toBe('unknown');
    expect(ipKey('Not-An-IP')).toBe('not-an-ip');
  });
});
