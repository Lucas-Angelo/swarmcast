import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BLOCKLIST_REFRESH_MS, DEFAULT_BLOCKLISTS, PublicBlocklists, blocklistSources, parseBlocklist } from '../../src/security/blocklists.js';
import { silentLog } from './helpers.js';

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

describe('blocklist parsing', () => {
  it('reads Spamhaus JSON lines (skipping metadata), FireHOL netsets and ";"-commented text', () => {
    expect(parseBlocklist(SPAMHAUS_JSON).map((r) => r.v)).toEqual([4, 6]);
    expect(parseBlocklist(NETSET)).toHaveLength(5);
    expect(parseBlocklist(SPAMHAUS_TXT)).toEqual([{ v: 4, start: 0x021a4b00n, end: 0x021a4bffn }]);
    expect(parseBlocklist('# feodo\n162.243.103.246\n# END 1 entries')).toHaveLength(1);
  });

  it('ignores garbage and absurdly wide entries (a broken list must not block everyone)', () => {
    expect(parseBlocklist('0.0.0.0/0\n::/0\n1.0.0.0/7\n2000::/3\nhello\n{"cidr":5}\n{bad json\n300.1.1.1')).toEqual([]);
    expect(parseBlocklist('224.0.0.0/3\n1.0.0.0/8')).toHaveLength(1);
  });

  it('maps config to sources (extra URLs get stable ids)', () => {
    const s = blocklistSources(DEFAULT_BLOCKLISTS, ['https://lists.blocklist.de/lists/all.txt']);
    expect(s.map((x) => x.id)).toEqual(['spamhaus-drop', 'spamhaus-drop-v6', 'firehol-level1', expect.stringMatching(/^custom-[0-9a-f]{10}$/)]);
    expect(s[0]!.url).toBe('https://www.spamhaus.org/drop/drop_v4.json');
    expect(s[2]!.url).toBe('https://iplists.firehol.org/files/firehol_level1.netset');
  });
});

function fakeFetch(bodies: Record<string, string | number>, log: Array<{ url: string; init?: RequestInit }>): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    log.push({ url, init });
    const b = bodies[url];
    if (b === undefined) throw new Error('offline');
    if (typeof b === 'number') return new Response('nope', { status: b });
    return new Response(b, { status: 200 });
  }) as unknown as typeof fetch;
}

describe('PublicBlocklists', () => {
  const sources = (): ReturnType<typeof blocklistSources> => blocklistSources(['spamhaus-drop', 'spamhaus-drop-v6', 'firehol-level1']);
  const bodies = {
    'https://www.spamhaus.org/drop/drop_v4.json': SPAMHAUS_JSON,
    'https://www.spamhaus.org/drop/drop_v6.json': '{"cidr":"2a06:1280::/29"}',
    'https://iplists.firehol.org/files/firehol_level1.netset': NETSET,
  };

  it('downloads with a plain GET, caches with the fetch date, and blocks only public listed IPs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-bl-'));
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let now = 1_800_000_000_000;
    const bl = new PublicBlocklists({ dir, log: silentLog, sources, fetch: fakeFetch(bodies, calls), now: () => now });
    expect(bl.isBlocked('1.10.16.1')).toBe(false); // not enabled yet
    bl.enabled = true;
    await bl.refresh();
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.init?.method ?? 'GET').toBe('GET');
      expect(c.init?.body).toBeUndefined();
      expect(c.init?.headers).toBeUndefined();
    }
    expect(bl.isBlocked('1.10.16.1')).toBe(true);
    expect(bl.isBlocked('::ffff:1.10.31.255')).toBe(true);
    expect(bl.isBlocked('2001:678:254::abcd')).toBe(true);
    expect(bl.isBlocked('2a06:1287::1')).toBe(true);
    expect(bl.isBlocked('45.9.23.255')).toBe(true);
    expect(bl.isBlocked('5.188.10.179')).toBe(true);
    expect(bl.isBlocked('8.8.8.8')).toBe(false);
    // Bogons from FireHOL are never applied to our own clients (tunnel connector, LAN, CGNAT).
    expect(bl.isBlocked('127.0.0.1')).toBe(false);
    expect(bl.isBlocked('10.1.2.3')).toBe(false);
    expect(bl.isBlocked('100.64.1.1')).toBe(false);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'spamhaus-drop.json'), 'utf8')) as { fetchedAt: number; entries: number };
    expect(meta).toMatchObject({ fetchedAt: now, entries: 2 });
    expect(bl.info()).toMatchObject({ networks: 8, updatedAt: now });
    if (process.platform !== 'win32') expect(fs.statSync(path.join(dir, 'spamhaus-drop.txt')).mode & 0o777).toBe(0o600);

    // Fresh lists are not downloaded again; stale ones are (every 24 h).
    await bl.refresh();
    expect(calls).toHaveLength(3);
    now += BLOCKLIST_REFRESH_MS + 1;
    await bl.refresh();
    expect(calls).toHaveLength(6);
    bl.stop();
    expect(bl.isBlocked('1.10.16.1')).toBe(false);
  });

  it('uses the cache when offline and keeps the cached copy when a download fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-bl-'));
    const first = new PublicBlocklists({ dir, log: silentLog, sources, fetch: fakeFetch(bodies, []), now: () => 1000 });
    first.enabled = true;
    await first.refresh();

    const offline = new PublicBlocklists({ dir, log: silentLog, sources, fetch: fakeFetch({}, []), now: () => 1000 + 2 * BLOCKLIST_REFRESH_MS });
    offline.enabled = true;
    offline.loadCache();
    expect(offline.isBlocked('1.10.16.1')).toBe(true);
    await offline.refresh();
    expect(offline.isBlocked('1.10.16.1')).toBe(true);
    const info = offline.info();
    expect(info.lists.every((l) => l.error === 'offline' && l.entries > 0)).toBe(true);
    expect(info.updatedAt).toBe(1000);

    // An empty or broken response never replaces a good list.
    const broken = new PublicBlocklists({
      dir,
      log: silentLog,
      sources,
      fetch: fakeFetch({ 'https://www.spamhaus.org/drop/drop_v4.json': '<html>maintenance</html>', 'https://www.spamhaus.org/drop/drop_v6.json': 503 }, []),
      now: () => 1000 + 3 * BLOCKLIST_REFRESH_MS,
    });
    broken.enabled = true;
    broken.loadCache();
    await broken.refresh();
    expect(broken.isBlocked('1.10.16.1')).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'spamhaus-drop.json'), 'utf8'))).toMatchObject({ fetchedAt: 1000 });
  });

  it('skips gracefully with no cache and no network', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-bl-'));
    const bl = new PublicBlocklists({ dir, log: silentLog, sources, fetch: fakeFetch({}, []) });
    bl.start();
    await bl.refresh();
    expect(bl.isBlocked('1.10.16.1')).toBe(false);
    expect(bl.info()).toMatchObject({ enabled: true, networks: 0 });
    bl.stop();
  });
});
