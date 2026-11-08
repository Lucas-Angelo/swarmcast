import fs from 'node:fs';
import https from 'node:https';
import { dohAnswer, realIo, type CloudflareAnswer, type HealthAnswer, type ReachabilityIo } from './provider.js';

/**
 * A local stand-in for Cloudflare's quick tunnels, for the system tests only
 * (scripts/test/lib/cloudflare.mjs): its quick-tunnel service, its edge, and the HTTPS and
 * DNS-over-HTTPS of the tunnels' public names, all on this machine. With it the gating tests open
 * the tunnel with the real cloudflared and run the live's real tunnel checks without reaching the
 * internet. Given as JSON in SWARMCAST_TEST_CLOUDFLARE, never set in a real run; only 127.0.0.1
 * addresses are accepted, so it can never send a tunnel anywhere but this machine.
 */
export interface CloudflareStandIn {
  /** The quick-tunnel service (cloudflared --quick-service): http://127.0.0.1:<port>. */
  service: string;
  /** The edge (cloudflared --edge): 127.0.0.1:<port>. */
  edge: string;
  /** HTTPS for the tunnels' public names, and DNS-over-HTTPS at /dns-query: 127.0.0.1:<port>. */
  web: string;
  /** PEM file of the CA that signed the edge's and the public side's certificate. */
  ca: string;
}

const LOOPBACK_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;
const LOOPBACK_ADDRESS = /^127\.0\.0\.1:\d{1,5}$/;
const QUICK_TUNNEL_HOST = /\.trycloudflare\.com$/i;

/** The stand-in of SWARMCAST_TEST_CLOUDFLARE, or null when it is not set. Throws on anything but 127.0.0.1 addresses and a CA file. */
export function cloudflareStandIn(env: NodeJS.ProcessEnv = process.env): CloudflareStandIn | null {
  const raw = env.SWARMCAST_TEST_CLOUDFLARE;
  if (!raw) return null;
  const s = JSON.parse(raw) as Partial<CloudflareStandIn>;
  const ok = typeof s.service === 'string' && LOOPBACK_URL.test(s.service) && typeof s.edge === 'string' && LOOPBACK_ADDRESS.test(s.edge) && typeof s.web === 'string' && LOOPBACK_ADDRESS.test(s.web) && typeof s.ca === 'string' && fs.existsSync(s.ca);
  if (!ok) throw new Error('SWARMCAST_TEST_CLOUDFLARE must name 127.0.0.1 addresses for service, edge and web, and an existing CA file');
  return s as CloudflareStandIn;
}

/** cloudflared arguments for the stand-in: its service, edge and CA, HTTP/2 (it has no QUIC), no pre-checks of Cloudflare's network. */
export function standInArgs(s: CloudflareStandIn): string[] {
  return ['--quick-service', s.service, '--edge', s.edge, '--cacert', s.ca, '--protocol', 'http2', '--no-prechecks'];
}

/**
 * The live's reachability checks (provider.ts probeHealth, checkPublicAddress, waitForReachable)
 * against the stand-in: a quick-tunnel name is resolved by its DNS-over-HTTPS (also in place of
 * this machine's resolver, which cannot know it) and answered by its public side. Any other
 * address (Direct mode) goes to the real network.
 */
export function standInIo(s: CloudflareStandIn): ReachabilityIo {
  const ca = fs.readFileSync(s.ca);
  const [host, port] = s.web.split(':') as [string, string];
  const get = (path: string, servername: string | undefined, headers: Record<string, string>) =>
    new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string } | null>((resolve) => {
      // agent: false: a new connection every time, as the real check does.
      const req = https.get({ host, port: Number(port), path, servername, ca, headers, agent: false, timeout: 5000 }, (res) => {
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
    const res = await get(`/dns-query?name=${encodeURIComponent(hostname)}&type=A`, undefined, { accept: 'application/dns-json' });
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
      const res = await get(url.pathname + url.search, url.hostname, { host: url.host, 'cache-control': 'no-store', ...headers });
      if (!res) return null;
      const marker = res.headers['x-swarmcast'];
      return { status: res.status, marker: res.status === 200 && typeof marker === 'string' ? marker : null };
    },
  };
}
