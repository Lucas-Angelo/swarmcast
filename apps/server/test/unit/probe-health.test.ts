import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isIpHost, probeHealth } from '../../src/tunnel/provider.js';

// "Stop everything" asks whether the public address still answers. In Direct mode that address
// is https://<public IP>:<port>: no DNS is involved, so no DNS-over-HTTPS query may be sent
// (it would hand the streamer's IP to Cloudflare, and wait up to 5 s when offline).

afterEach(() => vi.restoreAllMocks());

/** A local port nothing listens on: the probe's connection is refused at once. */
async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const dohCalls = (spy: ReturnType<typeof vi.spyOn>): string[] =>
  spy.mock.calls.map((c: unknown[]) => String(c[0])).filter((u: string) => u.includes('dns-query'));

describe('isIpHost', () => {
  it('knows IPv4, bracketed IPv6 (as URL.hostname gives it) and names apart', () => {
    expect(isIpHost('203.0.113.7')).toBe(true);
    expect(isIpHost(new URL('https://[2001:db8::5]:443/').hostname)).toBe(true);
    expect(isIpHost('::1')).toBe(true);
    expect(isIpHost('abc.trycloudflare.com')).toBe(false);
    expect(isIpHost('203.0.113.7.example')).toBe(false);
  });
});

describe('probeHealth', () => {
  it('sends no DNS-over-HTTPS query for an IP address (Direct mode URL)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const port = await closedPort();
    expect(await probeHealth(`https://127.0.0.1:${port}`)).toBeNull();
    expect(await probeHealth(`https://[::1]:${port}`)).toBeNull();
    expect(dohCalls(fetchSpy)).toEqual([]);
  });

  it('still resolves a name through DNS-over-HTTPS (new quick-tunnel names)', async () => {
    const port = await closedPort();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ Answer: [{ type: 1, data: '127.0.0.1' }] }));
    // Resolved to 127.0.0.1 by the DoH answer, where nothing listens: refused, so null.
    expect(await probeHealth(`https://abc-def.trycloudflare.com:${port}`)).toBeNull();
    expect(dohCalls(fetchSpy)).toEqual(['https://1.1.1.1/dns-query?name=abc-def.trycloudflare.com&type=A']);
  });
});
