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

export async function lookupPublicIps(): Promise<PublicIps> {
  const [v4, v6] = await Promise.all([
    trace('https://1.1.1.1/cdn-cgi/trace'),
    trace('https://[2606:4700:4700::1111]/cdn-cgi/trace'),
  ]);
  return { v4: v4?.includes('.') ? v4 : undefined, v6: v6?.includes(':') ? v6 : undefined };
}
