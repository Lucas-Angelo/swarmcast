import net from 'node:net';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { networkKey } from '../../src/access/network.js';

// Per-network grouping of client addresses (access/network.ts), for limits that count networks
// rather than addresses (0.5.0 poll votes). The properties check it against Node's own subnet
// matcher (net.BlockList) on random addresses written in every legal spelling.

/** Eight random 16-bit groups, never an IPv4-mapped address (that range is checked on its own). */
const hextets = fc.array(fc.integer({ min: 0, max: 0xffff }), { minLength: 8, maxLength: 8 }).filter((h) => !(h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff));

/** One spelling of an address: full or `::`-compressed at a run of zeros, any letter case, leading zeros or not. */
function spell(h: number[], o: { pad: boolean; upper: boolean; compressAt: number }): string {
  const parts = h.map((x) => (o.pad ? x.toString(16).padStart(4, '0') : x.toString(16)));
  let text = parts.join(':');
  // Compress the run of zero groups that starts at `compressAt`, if there is one there.
  let end = o.compressAt;
  while (end < 8 && h[end] === 0) end++;
  if (end - o.compressAt >= 2) text = `${parts.slice(0, o.compressAt).join(':')}::${parts.slice(end).join(':')}`;
  return o.upper ? text.toUpperCase() : text;
}
const spelling = fc.record({ pad: fc.boolean(), upper: fc.boolean(), compressAt: fc.integer({ min: 0, max: 7 }) });
/** Addresses with runs of zeros, so `::` actually appears. */
const sparse = fc.array(fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 0xffff })), { minLength: 8, maxLength: 8 }).filter((h) => !(h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff));

const RUNS = { numRuns: 2000, seed: 64 };

describe('networkKey', () => {
  it.each([
    ['an IPv4 address is its own network', '203.0.113.7', '203.0.113.7'],
    ['an IPv4-mapped IPv6 address is the IPv4 address', '::ffff:203.0.113.7', '203.0.113.7'],
    ['an IPv4-mapped address in hex is the IPv4 address', '::FFFF:cb00:7107', '203.0.113.7'],
    ['an IPv6 address counts by its /64', '2001:db8:aa:bb:1:2:3:4', '2001:db8:aa:bb:0:0:0:0/64'],
    ['a zone and brackets are ignored', '[fe80::1%en0]', 'fe80:0:0:0:0:0:0:0/64'],
    ['a trailing dotted quad is two groups', '2001:db8:1:2:3:4:1.2.3.4', '2001:db8:1:2:0:0:0:0/64'],
    ['a NAT64 address keeps its prefix', '64:ff9b::198.51.100.1', '64:ff9b:0:0:0:0:0:0/64'],
    ['something that is not an address stays itself', ' Unknown ', 'unknown'],
  ])('%s', (_case, ip, want) => {
    // Act
    const key = networkKey(ip);
    // Assert
    expect(key).toBe(want);
  });

  it('takes another prefix length when asked (48, 60, 128)', () => {
    // Act
    const keys = [48, 60, 128].map((p) => networkKey('2001:db8:abcd:1234:5678::9', p));
    // Assert
    expect(keys).toEqual(['2001:db8:abcd:0:0:0:0:0/48', '2001:db8:abcd:1230:0:0:0:0/60', '2001:db8:abcd:1234:5678:0:0:9/128']);
  });

  it('every spelling of one address gives the same key', () => {
    // Arrange
    const property = fc.property(sparse, spelling, spelling, (h, a, b) => networkKey(spell(h, a)) === networkKey(spell(h, b)));
    // Act
    const run = () => fc.assert(property, RUNS);
    // Assert
    expect(run).not.toThrow();
  });

  it('two addresses share a key exactly when Node puts them in the same /64', () => {
    // Arrange
    const sameOrNear = fc.tuple(hextets, hextets, fc.boolean()).map(([a, b, near]) => [a, near ? [...a.slice(0, 4), ...b.slice(4)] : b] as const);
    const property = fc.property(sameOrNear, spelling, ([a, b], how) => {
      const list = new net.BlockList();
      list.addSubnet(spell(a, how), 64, 'ipv6');
      return (networkKey(spell(a, how)) === networkKey(spell(b, how))) === list.check(spell(b, how), 'ipv6');
    });
    // Act
    const run = () => fc.assert(property, RUNS);
    // Assert
    expect(run).not.toThrow();
  });

  it('an IPv4 address and its IPv4-mapped form share a key; different IPv4 addresses never do', () => {
    // Arrange
    const property = fc.property(fc.ipV4(), fc.ipV4(), (a, b) => networkKey(`::ffff:${a}`) === networkKey(a) && (networkKey(a) === networkKey(b)) === (a === b));
    // Act
    const run = () => fc.assert(property, RUNS);
    // Assert
    expect(run).not.toThrow();
  });

  it('never throws, whatever the text', () => {
    // Arrange
    const property = fc.property(fc.oneof(fc.string(), fc.ipV6(), fc.ipV4Extended(), fc.string({ unit: 'binary' })), (ip) => typeof networkKey(ip) === 'string');
    // Act
    const run = () => fc.assert(property, RUNS);
    // Assert
    expect(run).not.toThrow();
  });
});
