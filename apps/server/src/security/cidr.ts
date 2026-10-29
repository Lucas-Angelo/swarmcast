import net from 'node:net';

/** A parsed address: IPv4 as a uint32 number, IPv6 as a 128-bit bigint. IPv4-mapped IPv6 becomes IPv4. */
export type ParsedIp = { v: 4; n: number } | { v: 6; n: bigint };

function parseV4(s: string): number | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const b = Number(p);
    if (b > 255) return null;
    n = n * 256 + b;
  }
  return n;
}

function parseV6(input: string): bigint | null {
  let s = input;
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!net.isIPv6(s)) return null;
  // Embedded IPv4 tail (::ffff:1.2.3.4) becomes two hex groups.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseV4(tail);
    if (v4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const [head, rest] = s.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const r = rest !== undefined && rest !== '' ? rest.split(':') : [];
  const groups = rest === undefined ? h : [...h, ...Array<string>(8 - h.length - r.length).fill('0'), ...r];
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) n = (n << 16n) | BigInt(parseInt(g || '0', 16));
  return n;
}

/** Parse an IPv4 or IPv6 address (IPv4-mapped IPv6 such as ::ffff:1.2.3.4 is treated as IPv4). */
export function parseIp(ip: string): ParsedIp | null {
  const s = ip.trim();
  if (s.includes(':')) {
    const n = parseV6(s);
    if (n === null) return null;
    if (n >> 32n === 0xffffn) return { v: 4, n: Number(n & 0xffffffffn) };
    return { v: 6, n };
  }
  const n = parseV4(s);
  return n === null ? null : { v: 4, n };
}

export interface CidrRange {
  v: 4 | 6;
  start: bigint;
  end: bigint;
}

/** Parse "a.b.c.d/nn", "x:y::/nn" or a bare address (= /32 or /128). Host bits are ignored. */
export function parseCidr(text: string): CidrRange | null {
  const [addr, bitsText] = text.trim().split('/') as [string, string | undefined];
  const ip = parseIp(addr);
  if (!ip) return null;
  // A mapped IPv6 prefix (::ffff:a.b.c.d/nn, nn >= 96) is an IPv4 prefix.
  const mapped = addr.includes(':') && ip.v === 4;
  const max = ip.v === 4 ? 32 : 128;
  let bits = max;
  if (bitsText !== undefined) {
    if (!/^\d{1,3}$/.test(bitsText)) return null;
    bits = Number(bitsText) - (mapped ? 96 : 0);
    if (bits < 0 || bits > max) return null;
  }
  const n = BigInt(ip.n);
  const hostBits = BigInt(max - bits);
  const start = (n >> hostBits) << hostBits;
  const end = start | ((1n << hostBits) - 1n);
  return { v: ip.v, start, end };
}

/** Prefix length of a range made by parseCidr (always one aligned power-of-two block). */
export function prefixLength(r: CidrRange): number {
  const size = r.end - r.start + 1n;
  return (r.v === 4 ? 32 : 128) - (size.toString(2).length - 1);
}

/**
 * A range back as text that parseCidr reads: "a.b.c.d/nn", or IPv6 as eight hex groups
 * ("2001:678:254:0:0:0:0:0/48"; not shortened, which keeps it simple and unambiguous).
 */
export function formatCidr(r: CidrRange): string {
  const bits = prefixLength(r);
  if (r.v === 4) {
    const n = Number(r.start);
    return `${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}/${bits}`;
  }
  const groups: string[] = [];
  for (let i = 7; i >= 0; i--) groups.push(((r.start >> BigInt(16 * i)) & 0xffffn).toString(16));
  return `${groups.join(':')}/${bits}`;
}

/** Binary search: is `x` inside one of the sorted, non-overlapping [starts[i], ends[i]] ranges? */
function contains<T extends number | bigint>(starts: ArrayLike<T>, ends: ArrayLike<T>, x: T): boolean {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid]! <= x) lo = mid + 1;
    else hi = mid - 1;
  }
  // `hi` is the last range starting at or before x.
  return hi >= 0 && ends[hi]! >= x;
}

function merge(ranges: Array<{ start: bigint; end: bigint }>): Array<{ start: bigint; end: bigint }> {
  ranges.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const out: Array<{ start: bigint; end: bigint }> = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1n) {
      if (r.end > last.end) last.end = r.end;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/**
 * Immutable set of IPv4/IPv6 networks: sorted, merged ranges with binary search
 * (O(log n) lookups, no native dependencies). IPv4 uses typed arrays; IPv6 uses bigints.
 */
export class CidrSet {
  private readonly v4Starts: Uint32Array;
  private readonly v4Ends: Uint32Array;
  private readonly v6Starts: bigint[];
  private readonly v6Ends: bigint[];
  /** Number of input networks (before merging). */
  readonly size: number;

  constructor(cidrs: Iterable<string | CidrRange>) {
    const v4: Array<{ start: bigint; end: bigint }> = [];
    const v6: Array<{ start: bigint; end: bigint }> = [];
    let size = 0;
    for (const c of cidrs) {
      const r = typeof c === 'string' ? parseCidr(c) : c;
      if (!r) continue;
      size += 1;
      (r.v === 4 ? v4 : v6).push({ start: r.start, end: r.end });
    }
    const m4 = merge(v4);
    const m6 = merge(v6);
    this.v4Starts = Uint32Array.from(m4, (r) => Number(r.start));
    this.v4Ends = Uint32Array.from(m4, (r) => Number(r.end));
    this.v6Starts = m6.map((r) => r.start);
    this.v6Ends = m6.map((r) => r.end);
    this.size = size;
  }

  /** Merged range count (what lookups search over). */
  get rangeCount(): number {
    return this.v4Starts.length + this.v6Starts.length;
  }

  has(ip: string | ParsedIp): boolean {
    const p = typeof ip === 'string' ? parseIp(ip) : ip;
    if (!p) return false;
    return p.v === 4 ? contains(this.v4Starts, this.v4Ends, p.n) : contains(this.v6Starts, this.v6Ends, p.n);
  }
}

/**
 * Loopback, private, carrier-grade NAT (100.64/10), link-local, unspecified and IPv6 ULA
 * addresses. Public blocklists like FireHOL level1 include these "bogons", but our own
 * clients legitimately come from them (the local tunnel connector, LAN tests), so they are
 * never blocked.
 */
const NON_PUBLIC = new CidrSet([
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '::/128',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
]);

export function isNonPublicIp(ip: string | ParsedIp): boolean {
  return NON_PUBLIC.has(ip);
}

/**
 * Privacy-preserving label for logs: the /24 (IPv4) or /48 (IPv6) network, written so the
 * activity log's IP scrubber keeps it (e.g. "203.0.113.*", "2001:db8:1:*").
 */
export function ipPrefixLabel(ip: string): string {
  const p = parseIp(ip);
  if (!p) return '?';
  if (p.v === 4) return `${p.n >>> 24}.${(p.n >>> 16) & 255}.${(p.n >>> 8) & 255}.*`;
  const g = (i: number): string => ((p.n >> BigInt(112 - 16 * i)) & 0xffffn).toString(16);
  return `${g(0)}:${g(1)}:${g(2)}:*`;
}
