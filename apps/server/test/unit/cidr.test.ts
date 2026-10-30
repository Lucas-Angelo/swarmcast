import { describe, expect, it } from 'vitest';
import { CidrSet, formatCidr, ipPrefixLabel, isNonPublicIp, parseCidr, parseIp, prefixLength } from '../../src/security/cidr.js';
import { scrubActivity } from '../../src/core/activity.js';

// IP and CIDR parsing for the public blocklists, the set they are matched against, and the
// addresses that are never public.

describe('IP parsing', () => {
  it.each([
    ['1.2.3.4', { v: 4, n: 0x01020304 }],
    ['255.255.255.255', { v: 4, n: 0xffffffff }],
    ['::ffff:1.2.3.4', { v: 4, n: 0x01020304 }],
    ['::ffff:102:304', { v: 4, n: 0x01020304 }],
    ['::1', { v: 6, n: 1n }],
    ['::', { v: 6, n: 0n }],
    ['2001:db8::1', { v: 6, n: (0x20010db8n << 96n) | 1n }],
    ['fe80::1%en0', { v: 6, n: (0xfe80n << 112n) | 1n }],
    ['64:ff9b::1.2.3.4', { v: 6, n: (0x64ff9bn << 96n) | 0x01020304n }],
  ])('parses %s (IPv4, IPv6 compressed, embedded IPv4 or zone; ::ffff:a.b.c.d is IPv4)', (ip, parsed) => {
    // Act
    const p = parseIp(ip);
    // Assert
    expect(p).toEqual(parsed);
  });

  it.each(['1.2.3', '1.2.3.256', '01.2.3.4x', 'a.b.c.d', '', '1:2:3', 'gggg::1', '1.2.3.4/24'])('rejects %j as an IP', (bad) => {
    // Act
    const p = parseIp(bad);
    // Assert
    expect(p).toBeNull();
  });

  it.each([
    ['10.1.2.3/8', { v: 4, start: 0x0a000000n, end: 0x0affffffn }],
    ['1.2.3.4', { v: 4, start: 0x01020304n, end: 0x01020304n }],
    ['0.0.0.0/0', { v: 4, start: 0n, end: 0xffffffffn }],
    ['::ffff:1.2.3.0/120', { v: 4, start: 0x01020300n, end: 0x010203ffn }],
  ])('parses the CIDR %s, ignoring host bits', (cidr, range) => {
    // Act
    const r = parseCidr(cidr);
    // Assert
    expect(r).toEqual(range);
  });

  it('parses an IPv6 CIDR to the end of its network', () => {
    // Act
    const r = parseCidr('2001:db8::/32');
    // Assert
    expect(r!.end).toBe((0x20010db8n << 96n) | ((1n << 96n) - 1n));
  });

  it.each(['1.2.3.4/33', '1.2.3.4/-1', '::/129', '1.2.3.4/a', 'x/8'])('rejects the bad prefix %s', (bad) => {
    // Act
    const r = parseCidr(bad);
    // Assert
    expect(r).toBeNull();
  });

  it.each([
    ['10.1.2.3/8', '10.0.0.0/8'],
    ['1.2.3.4', '1.2.3.4/32'],
    ['0.0.0.0/0', '0.0.0.0/0'],
    ['255.255.255.255', '255.255.255.255/32'],
    ['::ffff:1.2.3.0/120', '1.2.3.0/24'],
    ['2001:db8::/32', '2001:db8:0:0:0:0:0:0/32'],
    ['::1', '0:0:0:0:0:0:0:1/128'],
    ['ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/128', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/128'],
    ['::/0', '0:0:0:0:0:0:0:0/0'],
  ])('formats %s back to %s, which parses to the same range', (input, text) => {
    // Arrange
    const r = parseCidr(input)!;
    // Act
    const formatted = formatCidr(r);
    // Assert
    expect(formatted).toBe(text);
    expect(parseCidr(formatted)).toEqual(r);
  });

  it('gives the prefix length of a range', () => {
    // Act
    const length = prefixLength(parseCidr('2a06:1280::/29')!);
    // Assert
    expect(length).toBe(29);
  });
});

describe('CidrSet', () => {
  const set = new CidrSet(['1.10.16.0/20', '1.10.20.0/24', '5.0.0.0/8', '200.1.2.3', '2001:678:254::/48', '2a00::/12', 'garbage']);

  it('counts the input networks and merges overlaps (1.10.20.0/24 is inside 1.10.16.0/20)', () => {
    // Assert
    expect(set.size).toBe(6);
    expect(set.rangeCount).toBe(5);
  });

  it.each([
    ['1.10.16.0', true],
    ['1.10.31.255', true],
    ['1.10.32.0', false],
    ['1.10.15.255', false],
    ['5.255.255.255', true],
    ['6.0.0.0', false],
    ['200.1.2.3', true],
    ['200.1.2.4', false],
    ['0.0.0.0', false],
    ['255.255.255.255', false],
  ])('IPv4 ranges at their edges: %s → %s', (ip, listed) => {
    // Act
    const has = set.has(ip);
    // Assert
    expect(has).toBe(listed);
  });

  it.each([
    ['2001:678:254::1', true],
    ['2001:678:254:ffff:ffff:ffff:ffff:ffff', true],
    ['2001:678:255::', false],
    ['2a0f:ffff::1', true],
    ['2a10::1', false],
    ['::ffff:5.6.7.8', true],
    ['not an ip', false],
  ])('IPv6 ranges and IPv4-mapped addresses: %s → %s', (ip, listed) => {
    // Act
    const has = set.has(ip);
    // Assert
    expect(has).toBe(listed);
  });

  it('merges adjacent ranges', () => {
    // Act
    const adj = new CidrSet(['10.0.0.0/25', '10.0.0.128/25']);
    // Assert
    expect(adj.rangeCount).toBe(1);
    expect(adj.has('10.0.0.200')).toBe(true);
  });

  it('the empty set has nothing', () => {
    // Act
    const has = new CidrSet([]).has('1.2.3.4');
    // Assert
    expect(has).toBe(false);
  });

  /**
   * The best of `rounds` runs of `fn` (ms): noise (GC, scheduling) only ever adds time, so the
   * minimum is the measurement.
   */
  function bestOf(rounds: number, fn: () => void): number {
    let best = Infinity;
    for (let r = 0; r < rounds; r++) {
      const t = performance.now();
      fn();
      best = Math.min(best, performance.now() - t);
    }
    return best;
  }

  // Lookups must stay fast with the thousands of networks public lists hold: a binary search.
  // Measured against a baseline from the same run, never an absolute time (CI machines differ
  // tenfold): the same 100,000 lookups in a set of one network. A binary search over 5,000 ranges
  // costs about 1.2 times that; a linear scan, about 100 times.
  it('looking up an address among 5,000 networks costs about the same as among one', () => {
    // Arrange
    const disjoint = Array.from({ length: 5000 }, (_, i) => `${(i % 200) + 20}.${Math.floor(i / 200) * 2}.${i % 7}.0/24`);
    const big = new CidrSet(disjoint);
    const one = new CidrSet(['1.2.3.0/24']);
    const ips = Array.from({ length: 100_000 }, (_, i) => `${(i % 250) + 1}.${i % 256}.1.1`);
    const lookups = (s: CidrSet) => () => {
      for (const ip of ips) s.has(ip);
    };
    lookups(big)();
    lookups(one)();
    // Act
    const tBig = bestOf(5, lookups(big));
    const tOne = bestOf(5, lookups(one));
    // Assert
    expect(big.rangeCount).toBe(5000);
    expect(tBig / tOne).toBeLessThan(5);
  });
});

describe('non-public addresses and log labels', () => {
  it.each(['127.0.0.1', '10.1.2.3', '100.64.0.1', '100.127.255.255', '172.16.0.1', '192.168.1.1', '169.254.1.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1'])(
    'never treats %s (loopback, private, CGNAT, link-local or ULA) as public',
    (ip) => {
      // Act
      const nonPublic = isNonPublicIp(ip);
      // Assert
      expect(nonPublic).toBe(true);
    },
  );

  it.each(['8.8.8.8', '100.128.0.1', '172.32.0.1', '2001:db8::1', '1.10.16.1'])('%s is public', (ip) => {
    // Act
    const nonPublic = isNonPublicIp(ip);
    // Assert
    expect(nonPublic).toBe(false);
  });

  it.each([
    ['203.0.113.77', '203.0.113.*'],
    ['2001:db8:1234:5678::9', '2001:db8:1234:*'],
    ['::ffff:1.2.3.4', '1.2.3.*'],
  ])('labels only the /24 or /48 network of %s: %s', (ip, label) => {
    // Act
    const l = ipPrefixLabel(ip);
    // Assert
    expect(l).toBe(label);
  });

  it('the activity scrubber keeps those labels', () => {
    // Act
    const text = scrubActivity('from 203.0.113.* and 2001:db8:1234:*');
    // Assert
    expect(text).toBe('from 203.0.113.* and 2001:db8:1234:*');
  });
});
