import fs from 'node:fs';
import http from 'node:http';
import { dohAnswer, realIo, type CloudflareAnswer, type HealthAnswer, type ReachabilityIo } from './provider.js';

/**
 * A local stand-in for Cloudflare's quick tunnels, for the system tests only
 * (scripts/test/lib/cloudflare.mjs): its quick-tunnel service, its edge, and the public side and
 * DNS-over-HTTPS of the tunnels' names, all on this machine. With it the gating tests open the
 * tunnel with the real cloudflared and run the live's real tunnel checks without reaching the
 * internet (docs/TESTING.md, "No third-party service in the gate"). Given as JSON in
 * SWARMCAST_TEST_CLOUDFLARE, never set in a real run.
 *
 * Only 127.0.0.1 addresses are accepted, so it can never send a tunnel, a check or a trust
 * decision anywhere but this machine. It adds no power over the app: whoever can set the app's
 * environment already runs code as its user (SWARMCAST_BIN_DIR picks the cloudflared it starts).
 */
export interface CloudflareStandIn {
  /** The quick-tunnel service (cloudflared --quick-service): http://127.0.0.1:<port>. */
  service: string;
  /** The edge (cloudflared --edge): 127.0.0.1:<port>. */
  edge: string;
  /** PEM file of the CA that signed the edge's certificate (cloudflared --cacert; the app never reads it). */
  ca: string;
  /**
   * The public side over plain HTTP, for the live's reachability checks: a tunnel's name in Host
   * goes through the edge to its cloudflared, and /dns-query (application/dns-json) is the
   * stand-in's DNS-over-HTTPS. 127.0.0.1:<port>.
   */
  checks: string;
}

const LOOPBACK_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;
const LOOPBACK_ADDRESS = /^127\.0\.0\.1:\d{1,5}$/;
const QUICK_TUNNEL_HOST = /\.trycloudflare\.com$/i;
/** How long one check may wait for the stand-in (the real checks' limit, provider.ts). */
const CHECK_TIMEOUT_MS = 5000;
const INVALID = 'SWARMCAST_TEST_CLOUDFLARE must be JSON naming 127.0.0.1 addresses for service, edge and checks, and an existing CA file';

/** The stand-in of SWARMCAST_TEST_CLOUDFLARE, or null when it is not set. Throws on anything but 127.0.0.1 addresses and a CA file. */
export function cloudflareStandIn(env: NodeJS.ProcessEnv = process.env): CloudflareStandIn | null {
  const raw = env.SWARMCAST_TEST_CLOUDFLARE;
  if (!raw) return null;
  let s: Partial<CloudflareStandIn>;
  try {
    s = JSON.parse(raw) as Partial<CloudflareStandIn>;
  } catch {
    throw new Error(INVALID);
  }
  const ok =
    typeof s.service === 'string' && LOOPBACK_URL.test(s.service)
    && typeof s.edge === 'string' && LOOPBACK_ADDRESS.test(s.edge)
    && typeof s.checks === 'string' && LOOPBACK_ADDRESS.test(s.checks)
    && typeof s.ca === 'string' && fs.existsSync(s.ca);
  if (!ok) throw new Error(INVALID);
  return { service: s.service!, edge: s.edge!, ca: s.ca!, checks: s.checks! };
}

/** cloudflared arguments for the stand-in: its service, edge and CA, HTTP/2 (it has no QUIC), no pre-checks of Cloudflare's network. */
export function standInArgs(s: CloudflareStandIn): string[] {
  return ['--quick-service', s.service, '--edge', s.edge, '--cacert', s.ca, '--protocol', 'http2', '--no-prechecks'];
}

/**
 * The live's reachability checks (provider.ts probeHealth, checkPublicAddress, waitForReachable)
 * against the stand-in: a quick-tunnel name is resolved by its DNS-over-HTTPS (also in place of
 * this machine's resolver, which cannot know it) and answered by its public side, both over
 * plain HTTP on 127.0.0.1 (what is checked is the tunnel path, not the stand-in's TLS). Any other
 * address (Direct mode) goes to the real network.
 */
export function standInIo(s: CloudflareStandIn): ReachabilityIo {
  const [host, port] = s.checks.split(':') as [string, string];
  const get = (path: string, headers: Record<string, string>) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string } | null>((resolve) => {
      // agent: false: a new connection every time, as the real check does.
      const req = http.get({ host, port: Number(port), path, headers, agent: false, timeout: CHECK_TIMEOUT_MS }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        res.on('error', () => resolve(null));
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(null));
    });
  const cloudflare = async (hostname: string): Promise<CloudflareAnswer> => {
    const res = await get(`/dns-query?name=${encodeURIComponent(hostname)}&type=A`, { host: s.checks, accept: 'application/dns-json' });
    if (!res || res.status !== 200) return 'unreachable';
    try {
      return dohAnswer(JSON.parse(res.body));
    } catch {
      return 'unreachable';
    }
  };
  return {
    cloudflare: (hostname) => (QUICK_TUNNEL_HOST.test(hostname) ? cloudflare(hostname) : realIo.cloudflare(hostname)),
    system: async (hostname) => (QUICK_TUNNEL_HOST.test(hostname) ? typeof (await cloudflare(hostname)) === 'object' : realIo.system(hostname)),
    health: async (url, ip, headers): Promise<HealthAnswer | null> => {
      if (url.protocol !== 'https:' || !QUICK_TUNNEL_HOST.test(url.hostname)) return realIo.health(url, ip, headers);
      const res = await get(url.pathname + url.search, { host: url.host, 'cache-control': 'no-store', ...headers });
      if (!res) return null;
      const marker = res.headers['x-swarmcast'];
      return { status: res.status, marker: res.status === 200 && typeof marker === 'string' ? marker : null };
    },
  };
}
