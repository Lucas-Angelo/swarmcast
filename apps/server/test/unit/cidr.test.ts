import { describe, expect, it } from 'vitest';
import { CidrSet, formatCidr, ipPrefixLabel, isNonPublicIp, parseCidr, parseIp, prefixLength } from '../../src/security/cidr.js';
import { scrubActivity } from '../../src/core/activity.js';

describe('IP parsing', () => {
  it('parses IPv4, IPv6 (compressed, embedded IPv4, zone) and maps ::ffff:a.b.c.d to IPv4', () => {
    expect(parseIp('1.2.3.4')).toEqual({ v: 4, n: 0x01020304 });
    expect(parseIp('255.255.255.255')).toEqual({ v: 4, n: 0xffffffff });
    expect(parseIp('::ffff:1.2.3.4')).toEqual({ v: 4, n: 0x01020304 });
    expect(parseIp('::ffff:102:304')).toEqual({ v: 4, n: 0x01020304 });
    expect(parseIp('::1')).toEqual({ v: 6, n: 1n });
    expect(parseIp('::')).toEqual({ v: 6, n: 0n });
    expect(parseIp('2001:db8::1')).toEqual({ v: 6, n: (0x20010db8n << 96n) | 1n });
    expect(parseIp('fe80::1%en0')).toEqual({ v: 6, n: (0xfe80n << 112n) | 1n });
    expect(parseIp('64:ff9b::1.2.3.4')).toEqual({ v: 6, n: (0x64ff9bn << 96n) | 0x01020304n });
    for (const bad of ['1.2.3', '1.2.3.256', '01.2.3.4x', 'a.b.c.d', '', '1:2:3', 'gggg::1', '1.2.3.4/24']) expect(parseIp(bad), bad).toBeNull();
  });

  it('parses CIDRs, ignoring host bits, and rejects bad prefixes', () => {
    expect(parseCidr('10.1.2.3/8')).toEqual({ v: 4, start: 0x0a000000n, end: 0x0affffffn });
    expect(parseCidr('1.2.3.4')).toEqual({ v: 4, start: 0x01020304n, end: 0x01020304n });
    expect(parseCidr('0.0.0.0/0')).toEqual({ v: 4, start: 0n, end: 0xffffffffn });
    expect(parseCidr('2001:db8::/32')!.end).toBe((0x20010db8n << 96n) | ((1n << 96n) - 1n));
    expect(parseCidr('::ffff:1.2.3.0/120')).toEqual({ v: 4, start: 0x01020300n, end: 0x010203ffn });
    for (const bad of ['1.2.3.4/33', '1.2.3.4/-1', '::/129', '1.2.3.4/a', 'x/8']) expect(parseCidr(bad), bad).toBeNull();
  });

  it('formats ranges back to CIDRs that parse to the same range', () => {
    const cases: Array<[string, string]> = [
      ['10.1.2.3/8', '10.0.0.0/8'],
      ['1.2.3.4', '1.2.3.4/32'],
      ['0.0.0.0/0', '0.0.0.0/0'],
      ['255.255.255.255', '255.255.255.255/32'],
      ['::ffff:1.2.3.0/120', '1.2.3.0/24'],
      ['2001:db8::/32', '2001:db8:0:0:0:0:0:0/32'],
      ['::1', '0:0:0:0:0:0:0:1/128'],
      ['ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/128', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/128'],
      ['::/0', '0:0:0:0:0:0:0:0/0'],
    ];
    for (const [input, text] of cases) {
      const r = parseCidr(input)!;
      expect(formatCidr(r), input).toBe(text);
      expect(parseCidr(text), text).toEqual(r);
    }
    expect(prefixLength(parseCidr('2a06:1280::/29')!)).toBe(29);
  });
});

describe('CidrSet', () => {
  const set = new CidrSet(['1.10.16.0/20', '1.10.20.0/24', '5.0.0.0/8', '200.1.2.3', '2001:678:254::/48', '2a00::/12', 'garbage']);

  it('matches IPv4 ranges at their edges and merges overlaps', () => {
    expect(set.has('1.10.16.0')).toBe(true);
    expect(set.has('1.10.31.255')).toBe(true);
    expect(set.has('1.10.32.0')).toBe(false);
    expect(set.has('1.10.15.255')).toBe(false);
    expect(set.has('5.255.255.255')).toBe(true);
    expect(set.has('6.0.0.0')).toBe(false);
    expect(set.has('200.1.2.3')).toBe(true);
    expect(set.has('200.1.2.4')).toBe(false);
    expect(set.has('0.0.0.0')).toBe(false);
    expect(set.has('255.255.255.255')).toBe(false);
    expect(set.size).toBe(6);
    expect(set.rangeCount).toBe(5); // 1.10.20.0/24 is inside 1.10.16.0/20
  });

  it('matches IPv6 ranges and IPv4-mapped addresses', () => {
    expect(set.has('2001:678:254::1')).toBe(true);
    expect(set.has('2001:678:254:ffff:ffff:ffff:ffff:ffff')).toBe(true);
    expect(set.has('2001:678:255::')).toBe(false);
    expect(set.has('2a0f:ffff::1')).toBe(true);
    expect(set.has('2a10::1')).toBe(false);
    expect(set.has('::ffff:5.6.7.8')).toBe(true);
    expect(set.has('not an ip')).toBe(false);
  });

  it('handles adjacent ranges and the empty set', () => {
    const adj = new CidrSet(['10.0.0.0/25', '10.0.0.128/25']);
    expect(adj.rangeCount).toBe(1);
    expect(adj.has('10.0.0.200')).toBe(true);
    expect(new CidrSet([]).has('1.2.3.4')).toBe(false);
  });

  it('is fast enough for thousands of networks', () => {
    const many = Array.from({ length: 5000 }, (_, i) => `${(i % 200) + 20}.${Math.floor(i / 200)}.0.0/16`);
    const big = new CidrSet(many);
    const t = performance.now();
    for (let i = 0; i < 100_000; i++) big.has(`${(i % 250) + 1}.${i % 256}.1.1`);
    expect(performance.now() - t).toBeLessThan(1500);
  });
});

describe('non-public addresses and log labels', () => {
  it('never treats loopback, private, CGNAT, link-local or ULA as public', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '100.64.0.1', '100.127.255.255', '172.16.0.1', '192.168.1.1', '169.254.1.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(isNonPublicIp(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '100.128.0.1', '172.32.0.1', '2001:db8::1', '1.10.16.1']) expect(isNonPublicIp(ip), ip).toBe(false);
  });

  it('labels only the /24 or /48 network, and the activity scrubber keeps that label', () => {
    expect(ipPrefixLabel('203.0.113.77')).toBe('203.0.113.*');
    expect(ipPrefixLabel('2001:db8:1234:5678::9')).toBe('2001:db8:1234:*');
    expect(ipPrefixLabel('::ffff:1.2.3.4')).toBe('1.2.3.*');
    expect(scrubActivity('from 203.0.113.* and 2001:db8:1234:*')).toBe('from 203.0.113.* and 2001:db8:1234:*');
  });
});
