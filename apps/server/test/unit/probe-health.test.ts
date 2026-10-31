import dns from 'node:dns';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isIpHost, probeHealth } from '../../src/tunnel/provider.js';
import { droppingPort } from './helpers-b.js';

// "Stop everything" asks whether the public address still answers. In Direct mode that address is
// https://<public IP>:<port>: no DNS is involved, so no DNS-over-HTTPS query may be sent (it would
// hand the streamer's IP to Cloudflare, and wait up to 5 s when offline). A quick-tunnel name is
// still resolved through DoH, and this machine's resolver is never asked about it while Cloudflare
// does not know it: a resolver asked about a brand-new name remembers "no such name" for 60 s, and
// the streamer's browser asks the same resolver. The probed port drops every connection on
// 127.0.0.1, so the probe answers "gone" (null) at once; on ::1 nothing listens at all (refused at
// once on POSIX, after about 2 s on Windows, which retries the SYN): null as well. The OS lookup is
// a spy that answers "no such name" at once, without the network.

afterEach(() => {
  vi.restoreAllMocks();
});

/** A spy on this machine's resolver (dns.lookup, what an HTTPS request uses for a name) that answers "no such name". */
function osLookupSpy() {
  return vi.spyOn(dns, 'lookup').mockImplementation(((host: string, _opts: unknown, cb: (err: NodeJS.ErrnoException) => void) => {
    cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }));
  }) as unknown as typeof dns.lookup);
}

/** The DNS-over-HTTPS requests among the fetches `spy` saw. */
const dohCalls = (spy: ReturnType<typeof vi.spyOn>): string[] => spy.mock.calls.map((c: unknown[]) => String(c[0])).filter((u: string) => u.includes('dns-query'));

describe('isIpHost', () => {
  it.each([
    ['an IPv4 address', '203.0.113.7', true],
    ['a bracketed IPv6 address, as URL.hostname gives it', new URL('https://[2001:db8::5]:443/').hostname, true],
    ['IPv6 loopback', '::1', true],
    ['a quick-tunnel name', 'abc.trycloudflare.com', false],
    ['a name that starts like an IP', '203.0.113.7.example', false],
  ])('knows %s', (_what, host, ip) => {
    // Act
    const isIp = isIpHost(host);
    // Assert
    expect(isIp).toBe(ip);
  });
});

describe('probeHealth', () => {
  it.each([
    ['IPv4', (port: number) => `https://127.0.0.1:${port}`],
    ['IPv6', (port: number) => `https://[::1]:${port}`],
  ])('sends no DNS-over-HTTPS query for an %s address (Direct mode URL)', async (_what, url) => {
    // Arrange
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const port = await droppingPort();
    // Act
    const marker = await probeHealth(url(port));
    // Assert
    expect(marker).toBeNull();
    expect(dohCalls(fetchSpy)).toEqual([]);
  });

  it('still resolves a name through DNS-over-HTTPS (new quick-tunnel names)', async () => {
    // Arrange
    const port = await droppingPort();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ Answer: [{ type: 1, data: '127.0.0.1' }] }));
    // Act
    const marker = await probeHealth(`https://abc-def.trycloudflare.com:${port}`);
    // Assert
    expect(marker).toBeNull();
    expect(dohCalls(fetchSpy)).toEqual(['https://1.1.1.1/dns-query?name=abc-def.trycloudflare.com&type=A']);
  });

  it("never asks this machine's resolver about a name Cloudflare does not know yet (a brand-new quick tunnel)", async () => {
    // Arrange
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ Status: 3 }));
    const lookup = osLookupSpy();
    // Act
    const marker = await probeHealth('https://brand-new-name.trycloudflare.com');
    // Assert
    expect(marker).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("asks this machine's resolver only when neither of Cloudflare's resolvers answers", async () => {
    // Arrange
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const lookup = osLookupSpy();
    // Act
    const marker = await probeHealth('https://brand-new-name.trycloudflare.com');
    // Assert
    expect(marker).toBeNull();
    expect(dohCalls(fetchSpy)).toEqual(['https://1.1.1.1/dns-query?name=brand-new-name.trycloudflare.com&type=A', 'https://1.0.0.1/dns-query?name=brand-new-name.trycloudflare.com&type=A']);
    expect(lookup.mock.calls.map((c) => c[0])).toEqual(['brand-new-name.trycloudflare.com']);
  });
});
