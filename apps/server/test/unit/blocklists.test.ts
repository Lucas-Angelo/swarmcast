import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { BLOCKLIST_REFRESH_MS, DEFAULT_BLOCKLISTS, PublicBlocklists, blocklistCacheText, blocklistSources, parseBlocklist, readBodyCapped } from '../../src/security/blocklists.js';
import { manualClock, silentLog, tempDir } from './helpers.js';

// Public IP blocklists (Spamhaus DROP, FireHOL level 1): parsed, cached in the data folder with
// their fetch date, refreshed every 24 h. A list that fails keeps its cached copy, and bogons
// (loopback, LAN, CGNAT) are never applied: our own clients legitimately come from them.
// stop() (the app closes) ends a download in flight: nothing reaches the data folder after it.

const SPAMHAUS_JSON = [
  '{"cidr":"1.10.16.0/20","sblid":"SBL256894","rir":"apnic"}',
  '{"cidr":"2001:678:254::/48","sblid":"SBL697648","rir":"ripencc"}',
  '{"type":"metadata","timestamp":1792959242,"size":102980,"records":2,"copyright":"(c) 2026 The Spamhaus Project SLU","terms":"https://www.spamhaus.org/drop/terms/"}',
].join('\n');

const NETSET = `#
# firehol_level1
# Entries         : 4 subnets
#
0.0.0.0/8
10.0.0.0/8
100.64.0.0/10
45.9.20.0/22
5.188.10.179
`;

const SPAMHAUS_TXT = `; Spamhaus DROP List 2026/10/24
; Last-Modified: Sat, 24 Oct 2026 09:00:57 GMT
2.26.75.0/24 ; SBL698389
`;

const V4_URL = 'https://www.spamhaus.org/drop/drop_v4.json';
const V6_URL = 'https://www.spamhaus.org/drop/drop_v6.json';
const FIREHOL_URL = 'https://iplists.firehol.org/files/firehol_level1.netset';
const BODIES = { [V4_URL]: SPAMHAUS_JSON, [V6_URL]: '{"cidr":"2a06:1280::/29"}', [FIREHOL_URL]: NETSET };

/** A fetch that serves `bodies` (a number: that HTTP status) and is offline for any other URL. */
function fakeFetch(bodies: Record<string, string | number>, log: Array<{ url: string; init?: RequestInit }> = []): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    log.push({ url, init });
    const b = bodies[url];
    if (b === undefined) throw new Error('offline');
    if (typeof b === 'number') return new Response('nope', { status: b });
    return new Response(b, { status: 200 });
  }) as unknown as typeof fetch;
}

const sources = (): ReturnType<typeof blocklistSources> => blocklistSources(['spamhaus-drop', 'spamhaus-drop-v6', 'firehol-level1']);

/** Blocklists over `dir`, enabled, stopped when the test finishes. */
function blocklists(dir: string, fetchImpl: typeof fetch, now: () => number): PublicBlocklists {
  const bl = new PublicBlocklists({ dir, log: silentLog, sources, fetch: fetchImpl, now });
  bl.enabled = true;
  onTestFinished(() => bl.stop());
  return bl;
}

/**
 * A list server on 127.0.0.1 that answers with headers and a first line, then never finishes the
 * body: a download stays in flight until the client gives up. `requested` resolves once it has
 * the request, `abandoned` once the client closed the connection. Closed when the test finishes.
 */
async function hangingListServer(): Promise<{ url: string; requested: Promise<void>; abandoned: Promise<void> }> {
  let gotRequest!: () => void;
  let lost!: () => void;
  const requested = new Promise<void>((r) => (gotRequest = r));
  const abandoned = new Promise<void>((r) => (lost = r));
  const server = http.createServer((req, res) => {
    res.on('close', lost);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('1.2.3.0/24\n');
    gotRequest();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  onTestFinished(() => {
    server.closeAllConnections();
    return new Promise<void>((r) => server.close(() => r()));
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/list.txt`, requested, abandoned };
}

/** A fetch whose first call waits for `release()` (whatever the signal says), and records its calls. */
function gatedFetch(body: string): { fetch: typeof fetch; called: Promise<void>; release: () => void; calls: () => number } {
  let n = 0;
  let wasCalled!: () => void;
  let open!: () => void;
  const called = new Promise<void>((r) => (wasCalled = r));
  const gate = new Promise<void>((r) => (open = r));
  const impl = (async () => {
    n++;
    if (n === 1) {
      wasCalled();
      await gate;
    }
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch: impl, called, release: open, calls: () => n };
}

describe('blocklist parsing', () => {
  it('reads Spamhaus JSON lines (skipping metadata), FireHOL netsets and ";"-commented text', () => {
    // Act
    const json = parseBlocklist(SPAMHAUS_JSON);
    const netset = parseBlocklist(NETSET);
    const txt = parseBlocklist(SPAMHAUS_TXT);
    const feodo = parseBlocklist('# feodo\n162.243.103.246\n# END 1 entries');
    // Assert
    expect(json.map((r) => r.v)).toEqual([4, 6]);
    expect(netset).toHaveLength(5);
    expect(txt).toEqual([{ v: 4, start: 0x021a4b00n, end: 0x021a4bffn }]);
    expect(feodo).toHaveLength(1);
  });

  it('ignores garbage and absurdly wide entries (a broken list must not block everyone)', () => {
    // Act
    const garbage = parseBlocklist('0.0.0.0/0\n::/0\n1.0.0.0/7\n2000::/3\nhello\n{"cidr":5}\n{bad json\n300.1.1.1');
    const wideAndNarrow = parseBlocklist('224.0.0.0/3\n1.0.0.0/8');
    // Assert
    expect(garbage).toEqual([]);
    expect(wideAndNarrow).toHaveLength(1);
  });

  it.each([
    ['Spamhaus JSON', SPAMHAUS_JSON],
    ['a FireHOL netset', NETSET],
    ['Spamhaus text', SPAMHAUS_TXT],
  ])('caches only canonical networks of %s, which read back to the same ranges', (_what, list) => {
    // Arrange
    const ranges = parseBlocklist(list);
    // Act
    const text = blocklistCacheText(ranges);
    // Assert
    expect(text).toMatch(/^([0-9a-f.:]+\/\d{1,3}\n)+$/);
    expect(parseBlocklist(text)).toEqual(ranges);
  });

  it('writes the cache one network per line, without metadata', () => {
    // Act
    const text = blocklistCacheText(parseBlocklist(SPAMHAUS_JSON));
    // Assert
    expect(text).toBe('1.10.16.0/20\n2001:678:254:0:0:0:0:0/48\n');
  });

  it('stops reading an endless body as soon as it passes the size limit', async () => {
    // Arrange
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(1024).fill(0x31));
      },
    });
    // Act
    const read = readBodyCapped(new Response(endless), 10 * 1024);
    // Assert
    await expect(read).rejects.toThrow('list too large');
    expect(pulled).toBeLessThan(20);
  });

  it('refuses a body whose Content-Length is over the limit, and takes one right at the limit', async () => {
    // Act
    const announced = readBodyCapped(new Response('x', { headers: { 'content-length': '999999' } }), 1000);
    const atLimit = await readBodyCapped(new Response('1.2.3.4\n'), 8);
    const overLimit = readBodyCapped(new Response('1.2.3.4\n'), 7);
    // Assert
    await expect(announced).rejects.toThrow('list too large');
    expect(atLimit).toBe('1.2.3.4\n');
    await expect(overLimit).rejects.toThrow('list too large');
  });

  it('maps config to sources (extra URLs get stable ids)', () => {
    // Act
    const s = blocklistSources(DEFAULT_BLOCKLISTS, ['https://lists.blocklist.de/lists/all.txt']);
    // Assert
    expect(s.map((x) => x.id)).toEqual(['spamhaus-drop', 'spamhaus-drop-v6', 'firehol-level1', expect.stringMatching(/^custom-[0-9a-f]{10}$/)]);
    expect(s[0]!.url).toBe(V4_URL);
    expect(s[2]!.url).toBe(FIREHOL_URL);
  });
});

describe('PublicBlocklists', () => {
  it('blocks nothing until enabled', () => {
    // Arrange
    const bl = new PublicBlocklists({ dir: tempDir('sc-bl-'), log: silentLog, sources, fetch: fakeFetch(BODIES) });
    // Act
    const blocked = bl.isBlocked('1.10.16.1');
    // Assert
    expect(blocked).toBe(false);
  });

  it('downloads with a plain GET (no body, no headers) and blocks only public listed IPs', async () => {
    // Arrange
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const bl = blocklists(tempDir('sc-bl-'), fakeFetch(BODIES, calls), manualClock(1_800_000_000_000).now);
    // Act
    await bl.refresh();
    // Assert
    expect(calls.map((c) => c.url)).toEqual([V4_URL, V6_URL, FIREHOL_URL]);
    for (const c of calls) {
      expect(c.init?.method ?? 'GET').toBe('GET');
      expect(c.init?.body).toBeUndefined();
      expect(c.init?.headers).toBeUndefined();
    }
    for (const ip of ['1.10.16.1', '::ffff:1.10.31.255', '2001:678:254::abcd', '2a06:1287::1', '45.9.23.255', '5.188.10.179']) expect(bl.isBlocked(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '127.0.0.1', '10.1.2.3', '100.64.1.1']) expect(bl.isBlocked(ip), ip).toBe(false);
  });

  it('caches each list privately with its fetch date, as parsed networks only', async () => {
    // Arrange
    const dir = tempDir('sc-bl-');
    const clock = manualClock(1_800_000_000_000);
    const bl = blocklists(dir, fakeFetch(BODIES), clock.now);
    // Act
    await bl.refresh();
    // Assert
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'spamhaus-drop.json'), 'utf8')) as { fetchedAt: number; entries: number };
    expect(meta).toMatchObject({ fetchedAt: clock.now(), entries: 2 });
    expect(bl.info()).toMatchObject({ networks: 8, updatedAt: clock.now() });
    if (process.platform !== 'win32') expect(fs.statSync(path.join(dir, 'spamhaus-drop.txt')).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(dir, 'spamhaus-drop.txt'), 'utf8')).toBe('1.10.16.0/20\n2001:678:254:0:0:0:0:0/48\n');
  });

  it('downloads a list again only once it is a day old; stop() turns blocking off', async () => {
    // Arrange
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const clock = manualClock(1_800_000_000_000);
    const bl = blocklists(tempDir('sc-bl-'), fakeFetch(BODIES, calls), clock.now);
    await bl.refresh();
    // Act
    await bl.refresh();
    // Assert
    expect(calls).toHaveLength(3);
    // Act
    clock.advance(BLOCKLIST_REFRESH_MS + 1);
    await bl.refresh();
    // Assert
    expect(calls).toHaveLength(6);
    // Act
    bl.stop();
    // Assert
    expect(bl.isBlocked('1.10.16.1')).toBe(false);
  });

  it('uses the cache when offline and keeps the cached copy when a download fails', async () => {
    // Arrange
    const dir = tempDir('sc-bl-');
    await blocklists(dir, fakeFetch(BODIES), () => 1000).refresh();
    const offline = blocklists(dir, fakeFetch({}), () => 1000 + 2 * BLOCKLIST_REFRESH_MS);
    // Act
    offline.loadCache();
    // Assert
    expect(offline.isBlocked('1.10.16.1')).toBe(true);
    // Act
    await offline.refresh();
    // Assert
    expect(offline.isBlocked('1.10.16.1')).toBe(true);
    const info = offline.info();
    expect(info.lists.every((l) => l.error === 'offline' && l.entries > 0)).toBe(true);
    expect(info.updatedAt).toBe(1000);
  });

  it('an empty or broken response never replaces a good list', async () => {
    // Arrange
    const dir = tempDir('sc-bl-');
    await blocklists(dir, fakeFetch(BODIES), () => 1000).refresh();
    const broken = blocklists(dir, fakeFetch({ [V4_URL]: '<html>maintenance</html>', [V6_URL]: 503 }), () => 1000 + 3 * BLOCKLIST_REFRESH_MS);
    broken.loadCache();
    // Act
    await broken.refresh();
    // Assert
    expect(broken.isBlocked('1.10.16.1')).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'spamhaus-drop.json'), 'utf8'))).toMatchObject({ fetchedAt: 1000 });
  });

  it('skips gracefully with no cache and no network', async () => {
    // Arrange
    const bl = new PublicBlocklists({ dir: tempDir('sc-bl-'), log: silentLog, sources, fetch: fakeFetch({}) });
    onTestFinished(() => bl.stop());
    // Act
    bl.start();
    await bl.refresh();
    // Assert
    expect(bl.isBlocked('1.10.16.1')).toBe(false);
    expect(bl.info()).toMatchObject({ enabled: true, networks: 0 });
  });

  it('stop() ends a download in flight at once, and nothing reaches the data folder', async () => {
    // Arrange
    const dir = tempDir('sc-bl-');
    const server = await hangingListServer();
    const bl = new PublicBlocklists({ dir, log: silentLog, sources: () => [{ id: 'slow', url: server.url }] });
    bl.enabled = true;
    const refresh = bl.refresh();
    await server.requested;
    // Act
    bl.stop();
    await refresh;
    // Assert
    await server.abandoned;
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(bl.info().lists).toEqual([{ id: 'slow', entries: 0 }]);
  });

  it('a list that arrives after stop() is not written either', async () => {
    // Arrange
    const dir = tempDir('sc-bl-');
    const gated = gatedFetch('1.2.3.0/24\n');
    const bl = new PublicBlocklists({ dir, log: silentLog, sources: () => [{ id: 'late', url: 'https://lists.example.org/late.txt' }], fetch: gated.fetch });
    bl.enabled = true;
    const refresh = bl.refresh();
    await gated.called;
    // Act
    bl.stop();
    gated.release();
    await refresh;
    // Assert
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(bl.info().lists).toEqual([{ id: 'late', entries: 0 }]);
  });

  it('start() after stop() downloads again at once, without waiting for the stopped download', async () => {
    // Arrange
    const gated = gatedFetch('1.2.3.0/24\n');
    const bl = new PublicBlocklists({ dir: tempDir('sc-bl-'), log: silentLog, sources: () => [{ id: 'list', url: 'https://lists.example.org/list.txt' }], fetch: gated.fetch });
    onTestFinished(() => bl.stop());
    bl.enabled = true;
    void bl.refresh();
    await gated.called;
    bl.stop();
    // Act
    bl.start();
    await bl.refresh();
    // Assert
    expect(gated.calls()).toBe(2);
    expect(bl.isBlocked('1.2.3.4')).toBe(true);
  });
});
