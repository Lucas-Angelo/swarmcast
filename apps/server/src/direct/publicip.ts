import net from 'node:net';

/** Public IP as seen from the internet (Cloudflare trace endpoint, no account needed). */
export interface PublicIps {
  v4?: string;
  v6?: string;
}

async function trace(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
    const text = await res.text();
    return /^ip=(.+)$/m.exec(text)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

/**
 * Both address families, asked by IP so each request leaves over that family. When both fail
 * (some routers answer for 1.1.1.1 themselves, some networks block it), Cloudflare's trace by
 * name gives at least the family this machine prefers.
 */
export async function lookupPublicIps(): Promise<PublicIps> {
  const [v4, v6] = await Promise.all([trace('https://1.1.1.1/cdn-cgi/trace'), trace('https://[2606:4700:4700::1111]/cdn-cgi/trace')]);
  const out: PublicIps = { v4: v4 && net.isIPv4(v4) ? v4 : undefined, v6: v6 && net.isIPv6(v6) ? v6 : undefined };
  if (out.v4 || out.v6) return out;
  const any = await trace('https://www.cloudflare.com/cdn-cgi/trace');
  if (any && net.isIPv4(any)) out.v4 = any;
  else if (any && net.isIPv6(any)) out.v6 = any;
  return out;
}
