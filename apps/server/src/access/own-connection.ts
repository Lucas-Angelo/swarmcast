import { EventEmitter } from 'node:events';
import os from 'node:os';
import type { Logger } from '../core/logger.js';
import type { PublicIps } from '../direct/publicip.js';
import { parseCidr, parseIp } from '../security/cidr.js';

/**
 * "Is this viewer on the streamer's own internet connection?"
 *
 * In Secure mode viewers never learn the streamer's IP: they reach the server through the tunnel.
 * P2P breaks that for one kind of viewer: someone watching from the streamer's own home (the
 * streamer on a phone, family on the Wi-Fi). With "Help the stream (P2P)" on, the browser offers
 * its public address (its srflx ICE candidate) to every other P2P viewer, and that address is the
 * one the server runs behind. So P2P stays off for sessions whose client address
 * (CF-Connecting-IP) is the server's own public IPv4, or shares its IPv6 /64.
 */

/** Ranges a request through the tunnel never comes from: such a client is on this machine or its LAN. */
const LOCAL_RANGES = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '::/128',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
].map((c) => parseCidr(c)!);

/**
 * True for an address that cannot be a viewer seen through the tunnel: unparseable (the header
 * was missing and the socket address was not usable), loopback (the request did not come through
 * Cloudflare, or carried no CF-Connecting-IP), private or link-local. Such a client is treated as
 * being on the streamer's own connection.
 */
export function isLocalAddress(ip: string | undefined): boolean {
  const p = ip ? parseIp(ip) : null;
  if (!p) return true;
  const n = BigInt(p.n);
  return LOCAL_RANGES.some((r) => r.v === p.v && n >= r.start && n <= r.end);
}

const V6_PREFIX_BITS = 64n;

/** The server's public addresses: IPv4 exact, IPv6 by /64 (one home network gets one /64). */
export class EgressSet {
  private readonly v4 = new Set<number>();
  private readonly v6 = new Set<bigint>();

  /** Add one address; true when it was new. Unparseable input is ignored. */
  add(ip: string | undefined): boolean {
    const p = ip ? parseIp(ip) : null;
    if (!p) return false;
    const before = this.size;
    if (p.v === 4) this.v4.add(p.n);
    else this.v6.add(p.n >> V6_PREFIX_BITS);
    return this.size !== before;
  }

  /** Same IPv4 (also written as ::ffff:a.b.c.d), or an IPv6 in the same /64. */
  has(ip: string | undefined): boolean {
    const p = ip ? parseIp(ip) : null;
    if (!p) return false;
    return p.v === 4 ? this.v4.has(p.n) : this.v6.has(p.n >> V6_PREFIX_BITS);
  }

  get size(): number {
    return this.v4.size + this.v6.size;
  }

  clear(): void {
    this.v4.clear();
    this.v6.clear();
  }
}

/** Whether `client` is on the connection of `egress` (pure helper for one lookup result). */
export function sameConnection(client: string | undefined, egress: PublicIps): boolean {
  const set = new EgressSet();
  set.add(egress.v4);
  set.add(egress.v6);
  return set.has(client);
}

export type OwnConnectionVerdict = 'own' | 'other' | 'unknown';

/** Fingerprint of this machine's network addresses: it changes when the network does. */
export function interfaceFingerprint(): string {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i): i is os.NetworkInterfaceInfo => !!i && !i.internal)
    .map((i) => i.address)
    .sort()
    .join(',');
}

export interface EgressWatchOptions {
  /** The server's public addresses as the internet sees them (Cloudflare's trace endpoint). */
  lookup: () => Promise<PublicIps>;
  log: Logger;
  /** Changes when the network changes (a new lookup follows at once). */
  interfaces?: () => string;
  now?: () => number;
  /** How often the network is checked, and a failed lookup retried. */
  tickMs?: number;
  /** A successful lookup is repeated this often (the provider may change the address). */
  refreshMs?: number;
  /** After a network change, the old answer counts this long before it is "unknown". */
  staleMs?: number;
}

export const EGRESS_TICK_MS = 15_000;
export const EGRESS_REFRESH_MS = 10 * 60_000;
export const EGRESS_STALE_MS = 2 * 60_000;

/**
 * Learns and keeps the server's own public addresses while a live runs in Secure mode: one lookup
 * at the start, again every few minutes, and at once when this machine's network changes.
 * Every address seen during the live is kept (an old one is still the streamer's), and the IPs
 * themselves are never logged.
 *
 * Until one lookup succeeds (or when the network changed and no lookup has worked for a while)
 * the status is "unknown": the caller then keeps P2P off for everyone, since it cannot tell who
 * is at the streamer's home.
 */
export class EgressWatch extends EventEmitter<{ changed: [] }> {
  private readonly known = new EgressSet();
  private confirmedAt = 0;
  private failures = 0;
  private networkChangedAt: number | null = null;
  private fingerprint = '';
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private running = false;
  status: 'unknown' | 'known' = 'unknown';

  constructor(private readonly o: EgressWatchOptions) {
    super();
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  get active(): boolean {
    return this.running;
  }

  /** True while the status is unknown because lookups failed (not merely still running). */
  get failing(): boolean {
    return this.status === 'unknown' && this.failures > 0;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.fingerprint = (this.o.interfaces ?? interfaceFingerprint)();
    void this.refresh('start');
    this.timer = setInterval(() => this.tick(), this.o.tickMs ?? EGRESS_TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.known.clear();
    this.confirmedAt = 0;
    this.failures = 0;
    this.networkChangedAt = null;
    this.status = 'unknown';
  }

  /** Periodic work: notice network changes, retry failed lookups, refresh old answers. */
  tick(): void {
    if (!this.running) return;
    const fp = (this.o.interfaces ?? interfaceFingerprint)();
    if (fp !== this.fingerprint) {
      this.fingerprint = fp;
      this.networkChangedAt ??= this.now();
      this.o.log.info('network changed: checking this connection\'s public address again (P2P privacy)');
      void this.refresh('network');
    } else if (this.status === 'unknown' || this.networkChangedAt !== null || this.now() - this.confirmedAt >= (this.o.refreshMs ?? EGRESS_REFRESH_MS)) {
      void this.refresh('timer');
    }
    if (this.updateStatus()) this.emit('changed');
  }

  /** Look the addresses up now (one lookup at a time). */
  refresh(reason: string): Promise<void> {
    this.inFlight ??= this.lookupOnce(reason).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Resolves once no lookup is running. */
  idle(): Promise<void> {
    return this.inFlight ?? Promise.resolve();
  }

  private async lookupOnce(reason: string): Promise<void> {
    let ips: PublicIps = {};
    try {
      ips = await this.o.lookup();
    } catch {
      /* counted as a failure below */
    }
    if (!this.running) return;
    const added = [this.known.add(ips.v4), this.known.add(ips.v6)].some(Boolean);
    if (ips.v4 || ips.v6) {
      if (this.failures > 0 || this.confirmedAt === 0 || added) {
        // Only which families were found: the addresses themselves never go into a log.
        this.o.log.info({ ipv4: !!ips.v4, ipv6: !!ips.v6, reason }, 'public address of this connection known: P2P stays off for viewers on it');
      }
      this.confirmedAt = this.now();
      this.failures = 0;
      this.networkChangedAt = null;
    } else {
      this.failures += 1;
      if (this.failures === 1) this.o.log.info({ reason }, 'could not look up the public address of this connection; retrying (P2P waits while it is unknown)');
    }
    if (this.updateStatus() || added) this.emit('changed');
  }

  private updateStatus(): boolean {
    const stale = this.networkChangedAt !== null && this.now() - this.networkChangedAt > (this.o.staleMs ?? EGRESS_STALE_MS);
    const next = this.confirmedAt > 0 && !stale ? 'known' : 'unknown';
    if (next === this.status) return false;
    this.status = next;
    return true;
  }

  /**
   * "own": the client is on this connection (or on this machine/LAN); "other": it is not;
   * "unknown": no public address is known now, so nobody can be told apart.
   */
  classify(clientIp: string | undefined): OwnConnectionVerdict {
    if (isLocalAddress(clientIp) || this.known.has(clientIp)) return 'own';
    return this.status === 'known' ? 'other' : 'unknown';
  }
}
