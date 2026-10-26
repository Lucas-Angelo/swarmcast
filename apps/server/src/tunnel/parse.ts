/** Extract the public quick-tunnel URL from a line of cloudflared output. */
export function parseQuickTunnelUrl(line: string): string | null {
  const re = /https:\/\/([a-z0-9]+(?:-[a-z0-9]+)*)\.trycloudflare\.com\b/gi;
  for (const m of line.matchAll(re)) {
    const sub = m[1]!.toLowerCase();
    // The API host appears in error messages; it is never the tunnel address.
    if (sub === 'api') continue;
    return `https://${sub}.trycloudflare.com`;
  }
  return null;
}
