import dns from 'node:dns';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import net, { type LookupFunction } from 'node:net';
import { abortable, sleep } from '../core/retry.js';

export type TunnelEvents = {
  /** Emitted when the public URL becomes reachable (also after a reconnect that changed it). */
  url: [url: string];
  down: [reason: string];
};

/**
 * A way to make the local public server (127.0.0.1:<port>) reachable over HTTPS.
 * The default is a Cloudflare quick tunnel; others (named tunnel, VPS reverse proxy)
 * can be added without touching the rest of the app.
 */
export abstract class TunnelProvider extends EventEmitter<TunnelEvents> {
  abstract readonly name: string;
  abstract start(localPort: number): Promise<string>;
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
 * Resolve a hostname through Cloudflare's DNS-over-HTTPS. A brand-new quick-tunnel hostname
 * often does not exist yet when we first ask; the OS resolver then caches that NXDOMAIN for
 * minutes, so we bypass it for the readiness check (viewers resolve the name later, after the
 * link is shown, so they are not affected).
 */
export async function resolveViaDoh(hostname: string): Promise<string | null> {
  try {
    const res = await fetch(`https://1.1.1.1/dns-query?name=${encodeURIComponent(hostname)}&type=A`, {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(5000),
    });
    const body = (await res.json()) as { Answer?: Array<{ type: number; data: string }> };
    return body.Answer?.find((a) => a.type === 1)?.data ?? null;
  } catch {
    return null;
  }
}

/** True for a URL host that is an IP address (`203.0.113.7`, `[2001:db8::5]`), not a name. */
export function isIpHost(hostname: string): boolean {
  return net.isIP(hostname.replace(/^\[(.*)\]$/, '$1')) !== 0;
}

/**
 * GET url/healthz and return the X-SwarmCast header (or null), resolving the host via DoH when
 * it is a name. An IP address (Direct mode: https://<public IP>:<port>) needs no DNS at all:
 * asking a DNS-over-HTTPS server about it would only send the streamer's address to Cloudflare
 * and, offline, wait up to 5 s on every check of "Stop everything".
 */
export async function probeHealth(url: string, probe?: string): Promise<string | null> {
  const u = new URL('/healthz', url);
  const probeHeader: Record<string, string> = probe ? { 'x-swarmcast-probe': probe } : {};
  if (u.protocol !== 'https:') {
    const res = await fetch(u, { signal: AbortSignal.timeout(5000), cache: 'no-store', headers: probeHeader });
    await res.body?.cancel();
    return res.ok ? res.headers.get('x-swarmcast') : null;
  }
  const ip = isIpHost(u.hostname) ? null : await resolveViaDoh(u.hostname);
  const lookup: LookupFunction | undefined = ip
    ? (_host, opts, cb) => {
        if ((opts as dns.LookupOptions).all) (cb as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, [{ address: ip, family: 4 }]);
        else cb(null, ip, 4);
      }
    : undefined;
  return new Promise((resolve) => {
    const req = https.get(u, { lookup, timeout: 5000, headers: { 'cache-control': 'no-store', ...probeHeader } }, (res) => {
      res.resume();
      resolve(res.statusCode === 200 ? ((res.headers['x-swarmcast'] as string | undefined) ?? null) : null);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

/** Poll `url` until it answers with our marker header, with growing delays (DNS can take a while). Rejects (QuitAbortError) when `signal` aborts. */
export async function waitForReachable(
  url: string,
  expectMarker: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch; signal?: AbortSignal; /** Sent as X-SwarmCast-Probe: only then does /healthz reveal the live's marker. */ probe?: string } = {},
): Promise<boolean> {
  const { signal } = opts;
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  let delay = 500;
  while (Date.now() < deadline) {
    try {
      let marker: string | null;
      if (opts.fetchImpl) {
        const res = await opts.fetchImpl(`${url}/healthz`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000), cache: 'no-store', ...(opts.probe ? { headers: { 'x-swarmcast-probe': opts.probe } } : {}) });
        await res.body?.cancel();
        marker = res.ok ? res.headers.get('x-swarmcast') : null;
      } else {
        marker = await abortable(probeHealth(url, opts.probe), signal);
      }
      if (marker === expectMarker) {
        // Reachable through Cloudflare. Before showing the link, make sure the name also
        // resolves through this machine's normal DNS servers (the streamer will usually open
        // the link right away, and viewers' resolvers behave like hers).
        if (!url.startsWith('https://') || opts.fetchImpl) return true;
        const host = new URL(url).hostname;
        while (Date.now() < deadline + 30_000) {
          try {
            if ((await abortable(dns.promises.resolve4(host), signal)).length > 0) return true;
          } catch {
            /* not propagated yet */
          }
          await sleep(2000, signal);
        }
        return true;
      }
    } catch {
      /* not yet */
    }
    await sleep(delay, signal);
    delay = Math.min(delay * 1.5, 4000);
  }
  return false;
}
