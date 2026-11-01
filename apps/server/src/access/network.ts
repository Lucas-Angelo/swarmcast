import net from 'node:net';
import { CHAT_IPV6_NETWORK_PREFIX } from '@swarmcast/shared';

/**
 * The network a client address belongs to, for limits per network rather than per address (one
 * vote count per network in 0.5.0 polls). An IPv4 address is its own network. An IPv6 address
 * counts by its first `v6Prefix` bits (/64 by default): a home or a phone usually holds a whole
 * /64, so rotating the last 64 bits must not buy more of anything. An IPv4-mapped IPv6 address
 * (`::ffff:192.0.2.1`, what a dual-stack socket reports) is that IPv4 address. Brackets and a zone
 * (`[fe80::1%en0]`) are ignored. Anything that is not an IP address is returned trimmed and
 * lower-cased, so it still groups with itself.
 *
 * The key of an IPv6 network is its masked address in full form plus the prefix length, e.g.
 * `2001:db8:0:1:0:0:0:0/64`, so every spelling of one address gives the same key.
 */
export function networkKey(ip: string, v6Prefix: number = CHAT_IPV6_NETWORK_PREFIX): string {
  let a = ip.trim();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  if (net.isIPv4(a)) return a;
  if (!net.isIPv6(a)) return ip.trim().toLowerCase();
  const h = ipv6Hextets(a);
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return `${h[6]! >> 8}.${h[6]! & 0xff}.${h[7]! >> 8}.${h[7]! & 0xff}`;
  const prefix = Math.min(128, Math.max(0, Math.floor(v6Prefix)));
  const masked = h.map((x, i) => {
    const bits = Math.min(16, Math.max(0, prefix - 16 * i));
    return bits === 0 ? 0 : x & (0xffff << (16 - bits)) & 0xffff;
  });
  return `${masked.map((x) => x.toString(16)).join(':')}/${prefix}`;
}

/** The eight 16-bit groups of a valid IPv6 address (`::` expanded, a trailing dotted IPv4 as two groups). */
function ipv6Hextets(a: string): number[] {
  let text = a;
  const lastColon = text.lastIndexOf(':');
  if (text.includes('.', lastColon)) {
    const [b0, b1, b2, b3] = text
      .slice(lastColon + 1)
      .split('.')
      .map(Number) as [number, number, number, number];
    text = `${text.slice(0, lastColon + 1)}${((b0 << 8) | b1).toString(16)}:${((b2 << 8) | b3).toString(16)}`;
  }
  const parse = (part: string): number[] => (part === '' ? [] : part.split(':').map((x) => parseInt(x, 16)));
  const gap = text.indexOf('::');
  if (gap < 0) return parse(text);
  const head = parse(text.slice(0, gap));
  const rest = parse(text.slice(gap + 2));
  return [...head, ...new Array<number>(8 - head.length - rest.length).fill(0), ...rest];
}
