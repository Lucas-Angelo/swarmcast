import dns from 'node:dns';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import net, { type LookupFunction } from 'node:net';
import { abortable, sleep } from '../core/retry.js';
import type { TransientCause } from './start-failure.js';

/** Cloudflare refused or failed a new tunnel; the provider tries again after `delayMs`. */
export interface TunnelRetry {
  cause: TransientCause;
  /** cloudflared's own words. */
  reason: string;
  delayMs: number;
  /** The attempt that comes after the wait (2 for the first retry), of `attempts` in total. */
  attempt: number;
  attempts: number;
}

export type TunnelEvents = {
  /** Emitted when the public URL becomes reachable (also after a reconnect that changed it). */
  url: [url: string];
  down: [reason: string];
  /** Starting: Cloudflare refused or failed, a new attempt follows (see TunnelRetry). */
  retry: [info: TunnelRetry];
  /**
   * The connector cannot reach Cloudflare over UDP (QUIC), its preferred route: it keeps failing
   * before its first connection. `reason` is its own words. A new tunnel over TCP is the cure
   * (start with `transport: 'tcp'`).
   */
  'udp-blocked': [reason: string];
};

/**
 * How the connector reaches Cloudflare. `auto`: cloudflared's default, QUIC over UDP (port 7844),
 * which it only gives up for HTTP/2 after many failures (minutes); `tcp`: HTTP/2 over TCP (port
 * 7844) from the start, for networks that block or drop UDP.
 */
export type TunnelTransport = 'auto' | 'tcp';

export interface TunnelStartOptions {
  transport?: TunnelTransport;
  /** Epoch ms after which a retry is not started (the tunnel step's budget, tunnel/start-budget.ts). */
  deadline?: number;
}

/**
 * A way to make the local public server (127.0.0.1:<port>) reachable over HTTPS.
 * The default is a Cloudflare quick tunnel; others (named tunnel, VPS reverse proxy)
 * can be added without touching the rest of the app.
 */
export abstract class TunnelProvider extends EventEmitter<TunnelEvents> {
  abstract readonly name: string;
  abstract start(localPort: number, opts?: TunnelStartOptions): Promise<string>;
  abstract stop(): Promise<void>;
  abstract get url(): string | null;
  /** Process id of the connector, if any (used by the shutdown verification). */
  get pid(): number | undefined {
    return undefined;
  }
}

/** No tunnel: the public server is only reachable on this machine. Used by CI and tests. */
export class NoTunnel extends TunnelProvider {
  readonly name = 'none';
  private current: string | null = null;
  async start(localPort: number): Promise<string> {
    this.current = `http://127.0.0.1:${localPort}`;
    return this.current;
  }
  async stop(): Promise<void> {
    this.current = null;
  }
  get url(): string | null {
    return this.current;
  }
}

/** A tunnel/reverse proxy the user runs themselves; we only know its public URL. */
export class ExternalTunnel extends TunnelProvider {
  readonly name = 'external';
  private current: string | null = null;
  constructor(private readonly publicUrl: string) {
    super();
  }
  async start(): Promise<string> {
    this.current = this.publicUrl.replace(/\/$/, '');
    return this.current;
  }
  async stop(): Promise<void> {
    this.current = null;
  }
  get url(): string | null {
    return this.current;
  }
}

/**
 * What Cloudflare's resolver says about a name: its IPv4 address; `unknown` when it has none (a
 * brand-new quick-tunnel name for the first seconds after cloudflared prints it); `unreachable`
 * when neither of its addresses answers (a network that blocks them).
 */
export type CloudflareAnswer = { ip: string } | 'unknown' | 'unreachable';

/** Cloudflare's DNS-over-HTTPS servers, by address: asking for them by name would need DNS too. */
const DOH_SERVERS = ['1.1.1.1', '1.0.0.1'] as const;

/**
 * Resolve a hostname through Cloudflare's DNS-over-HTTPS, which answers for trycloudflare.com
 * first-hand. Any DNS answer without an address (NXDOMAIN, SERVFAIL...) is `unknown`: the
 * resolver works, the name is not there yet. `unreachable` only when no server answered at all.
 */
export async function resolveViaDoh(hostname: string): Promise<CloudflareAnswer> {
  for (const server of DOH_SERVERS) {
    try {
      const res = await fetch(`https://${server}/dns-query?name=${encodeURIComponent(hostname)}&type=A`, {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        await res.body?.cancel();
        continue;
      }
      const body = (await res.json()) as { Answer?: Array<{ type: number; data: string }> };
      const ip = body.Answer?.find((a) => a.type === 1)?.data;
      return ip ? { ip } : 'unknown';
    } catch {
      /* this server did not answer: the next one */
    }
  }
  return 'unreachable';
}

/** True for a URL host that is an IP address (`203.0.113.7`, `[2001:db8::5]`), not a name. */
export function isIpHost(hostname: string): boolean {
  return net.isIP(hostname.replace(/^\[(.*)\]$/, '$1')) !== 0;
}

/** The network side of a reachability check (probeHealth, waitForReachable): real by default, replaced in tests. */
export interface ReachabilityIo {
  /** What Cloudflare's resolver says about `hostname` (resolveViaDoh). */
  cloudflare(hostname: string): Promise<CloudflareAnswer>;
  /** Whether this machine's own resolver (getaddrinfo, the OS's DNS cache) has an address for `hostname`. */
  system(hostname: string): Promise<boolean>;
  /**
   * GET `url` and return its X-SwarmCast header, or null when it does not answer 200. With `ip`
   * the connection goes to that address (TLS and Host still name the host); without it, a name
   * is resolved by this machine's resolver.
   */
  health(url: URL, ip: string | undefined, headers: Record<string, string>): Promise<string | null>;
}

const realIo: ReachabilityIo = {
  cloudflare: resolveViaDoh,
  system: (hostname) => dns.promises.lookup(hostname).then(
    () => true,
    () => false,
  ),
  health: async (url, ip, headers) => {
    if (url.protocol !== 'https:') {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000), cache: 'no-store', headers });
      await res.body?.cancel();
      return res.ok ? res.headers.get('x-swarmcast') : null;
    }
    const lookup: LookupFunction | undefined = ip
      ? (_host, opts, cb) => {
          if ((opts as dns.LookupOptions).all) (cb as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, [{ address: ip, family: 4 }]);
          else cb(null, ip, 4);
        }
      : undefined;
    return new Promise((resolve) => {
      const req = https.get(url, { lookup, timeout: 5000, headers: { 'cache-control': 'no-store', ...headers } }, (res) => {
        res.resume();
        resolve(res.statusCode === 200 ? ((res.headers['x-swarmcast'] as string | undefined) ?? null) : null);
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(null));
    });
  },
};

/**
 * GET url/healthz and return the X-SwarmCast header (or null). A name is resolved by Cloudflare
 * (DNS-over-HTTPS) and the request goes to the address it gives; this machine's resolver is never
 * asked about a name Cloudflare does not know yet. Cloudflare has no address for a new quick
 * tunnel for its first 4 to 19 s, and a resolver asked about it then remembers "no such name"
 * for the zone's negative TTL (60 s), in some or all of its caches. Measured (DNS experiment run
 * 41197660617, lookups after Cloudflare had the address): on macOS runners the OS's lookup failed
 * for the whole 75 s watched in 8 of 8 runs where it had been asked early, and every preflight
 * showed the link 80 s after start (this check waited the cache out); on Windows runners the
 * resolver still said "no such name" to 11 of 157 lookups in 9 of 24 such runs, and the OS's
 * lookup failed for up to 10 s in 3 of them (a browser opening the new link fails). When it had
 * not been asked early: 0 failed lookups (Windows 0 of 72 in 12 runs, macOS 0 of 12). The OS
 * resolver is used only when neither DoH server answers at all. An IP address (Direct mode:
 * https://<public IP>:<port>) needs no DNS: asking a DNS-over-HTTPS server about it would only
 * send the streamer's address to Cloudflare and, offline, wait up to 5 s on every check of "Stop
 * everything".
 */
export async function probeHealth(url: string, probe?: string, io: ReachabilityIo = realIo): Promise<string | null> {
  const u = new URL('/healthz', url);
  const headers: Record<string, string> = probe ? { 'x-swarmcast-probe': probe } : {};
  if (u.protocol !== 'https:' || isIpHost(u.hostname)) return io.health(u, undefined, headers);
  const answer = await io.cloudflare(u.hostname);
  if (answer === 'unknown') return null;
  return io.health(u, answer === 'unreachable' ? undefined : answer.ip, headers);
}

/**
 * Poll `url` until it answers with our marker header, with growing delays (a new quick-tunnel
 * name takes a few seconds to exist), then until this machine's resolver also knows the name
 * (the streamer usually opens her link right away). That resolver is asked only after Cloudflare
 * answered with the address (probeHealth). Rejects (QuitAbortError) when `signal` aborts.
 */
export async function waitForReachable(
  url: string,
  expectMarker: string,
  opts: { timeoutMs?: number; signal?: AbortSignal; /** Sent as X-SwarmCast-Probe: only then does /healthz reveal the live's marker. */ probe?: string; io?: ReachabilityIo } = {},
): Promise<boolean> {
  const { signal } = opts;
  const io = opts.io ?? realIo;
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  let delay = 500;
  while (Date.now() < deadline) {
    try {
      if ((await abortable(probeHealth(url, opts.probe, io), signal)) === expectMarker) {
        const host = new URL(url).hostname;
        if (!url.startsWith('https://') || isIpHost(host)) return true;
        while (Date.now() < deadline + 30_000) {
          if (await abortable(io.system(host), signal)) return true;
          await sleep(2000, signal);
        }
        return true;
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      /* not yet */
    }
    await sleep(delay, signal);
    delay = Math.min(delay * 1.5, 4000);
  }
  return false;
}
