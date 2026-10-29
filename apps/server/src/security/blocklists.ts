import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../core/logger.js';
import { ensurePrivateDir, writePrivateFile } from '../core/paths.js';
import { CidrSet, formatCidr, isNonPublicIp, parseCidr, parseIp, prefixLength, type CidrRange } from './cidr.js';

/**
 * Free public IP blocklists that need no account. Only a plain GET is ever sent to them.
 * Terms checked 2026-10-25:
 * - Spamhaus DROP / DROPv6: free of charge under https://www.spamhaus.org/drop/terms/
 *   (do not use the Spamhaus name in marketing). Networks hijacked or run by criminals.
 * - FireHOL level1: aggregate of Spamhaus DROP, DShield top attackers, Feodo C2 and bogons,
 *   built for "maximum protection with minimum false positives" (https://iplists.firehol.org/).
 *   Its bogon part (private/CGNAT/loopback) is ignored: see isNonPublicIp.
 * - abuse.ch Feodo Tracker (optional; already inside FireHOL level1): CC0 per
 *   https://abuse.ch/terms-of-use/.
 * Aggressive lists (full blocklist.de, Tor exit nodes…) are not built in; add them with
 * `security.extraBlocklistUrls` if you really want them.
 */
export const BUILTIN_BLOCKLISTS = {
  'spamhaus-drop': 'https://www.spamhaus.org/drop/drop_v4.json',
  'spamhaus-drop-v6': 'https://www.spamhaus.org/drop/drop_v6.json',
  'firehol-level1': 'https://iplists.firehol.org/files/firehol_level1.netset',
  feodo: 'https://feodotracker.abuse.ch/downloads/ipblocklist_recommended.txt',
} as const;
export type BuiltinBlocklist = keyof typeof BUILTIN_BLOCKLISTS;
export const DEFAULT_BLOCKLISTS: BuiltinBlocklist[] = ['spamhaus-drop', 'spamhaus-drop-v6', 'firehol-level1'];

export const BLOCKLIST_REFRESH_MS = 24 * 3600_000;
const MAX_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
/** Ignore absurdly wide entries (a broken or hostile list must not block whole continents). */
const MIN_PREFIX = { 4: 8, 6: 12 } as const;

export interface BlocklistSource {
  id: string;
  url: string;
}

export function blocklistSources(builtin: readonly string[], extraUrls: readonly string[] = []): BlocklistSource[] {
  const out: BlocklistSource[] = [];
  for (const id of builtin) if (id in BUILTIN_BLOCKLISTS) out.push({ id, url: BUILTIN_BLOCKLISTS[id as BuiltinBlocklist] });
  for (const url of extraUrls) out.push({ id: `custom-${crypto.createHash('sha256').update(url).digest('hex').slice(0, 10)}`, url });
  return out;
}

/**
 * Parse a list: Spamhaus JSON lines ({"cidr": …}), FireHOL netsets, plain one-address-per-line
 * files. Comments (#, ;) and unparsable lines are skipped.
 */
export function parseBlocklist(text: string): CidrRange[] {
  const out: CidrRange[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    let token: string | undefined;
    if (line.startsWith('{')) {
      try {
        const rec = JSON.parse(line) as { cidr?: unknown };
        if (typeof rec.cidr === 'string') token = rec.cidr;
      } catch {
        continue;
      }
    } else {
      token = line.split(/[\s;#,]+/)[0];
    }
    if (!token) continue;
    const r = parseCidr(token);
    if (!r) continue;
    if (prefixLength(r) < MIN_PREFIX[r.v]) continue;
    out.push(r);
  }
  return out;
}

/**
 * The body as text, at most `max` bytes: the download stops (and throws) as soon as more
 * arrive, whatever Content-Length said or when there is none (a chunked answer).
 */
export async function readBodyCapped(res: Response, max: number): Promise<string> {
  if (Number(res.headers.get('content-length') ?? 0) > max) throw new Error('list too large');
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new Error('list too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The cache file: one canonical network per line, only the entries parseBlocklist accepted. */
export function blocklistCacheText(ranges: readonly CidrRange[]): string {
  return ranges.map(formatCidr).join('\n') + '\n';
}

interface CacheMeta {
  url: string;
  fetchedAt: number;
  entries: number;
}

export interface BlocklistInfo {
  enabled: boolean;
  /** Networks loaded across all lists. */
  networks: number;
  /** Oldest successful download among the loaded lists. */
  updatedAt?: number;
  lists: Array<{ id: string; entries: number; fetchedAt?: number; error?: string }>;
}

export interface BlocklistDeps {
  dir: string;
  log: Logger;
  sources: () => BlocklistSource[];
  fetch?: typeof fetch;
  now?: () => number;
}

/** Downloads, caches (data dir, with the fetch date) and matches public blocklists. */
export class PublicBlocklists {
  private set = new CidrSet([]);
  private lists = new Map<string, { ranges: CidrRange[]; fetchedAt?: number; error?: string }>();
  private timer: NodeJS.Timeout | null = null;
  private refreshing: Promise<void> | null = null;
  enabled = false;

  constructor(private readonly d: BlocklistDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  /** Load the cache, then download what is stale; re-check hourly (refresh every 24 h). */
  start(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.loadCache();
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 3600_000);
    this.timer.unref();
  }

  stop(): void {
    this.enabled = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** True when `ip` is public and listed. Never blocks loopback/private/CGNAT addresses. */
  isBlocked(ip: string): boolean {
    if (!this.enabled || this.set.size === 0) return false;
    const p = parseIp(ip);
    if (!p || isNonPublicIp(p)) return false;
    return this.set.has(p);
  }

  info(): BlocklistInfo {
    const lists = this.d.sources().map((s) => {
      const l = this.lists.get(s.id);
      return { id: s.id, entries: l?.ranges.length ?? 0, ...(l?.fetchedAt ? { fetchedAt: l.fetchedAt } : {}), ...(l?.error ? { error: l.error } : {}) };
    });
    const dates = lists.filter((l) => l.entries > 0 && l.fetchedAt).map((l) => l.fetchedAt!);
    return { enabled: this.enabled, networks: this.set.rangeCount, ...(dates.length ? { updatedAt: Math.min(...dates) } : {}), lists };
  }

  private file(id: string, ext: 'txt' | 'json'): string {
    return path.join(this.d.dir, `${id}.${ext}`);
  }

  /** Read cached lists (used offline and until the first download finishes). */
  loadCache(): void {
    for (const s of this.d.sources()) {
      try {
        const meta = JSON.parse(fs.readFileSync(this.file(s.id, 'json'), 'utf8')) as CacheMeta;
        if (meta.url !== s.url) continue;
        const ranges = parseBlocklist(fs.readFileSync(this.file(s.id, 'txt'), 'utf8'));
        this.lists.set(s.id, { ranges, fetchedAt: meta.fetchedAt });
      } catch {
        /* no cache yet */
      }
    }
    this.rebuild();
  }

  /** Download every list older than 24 h (or all with `force`). Failures keep the cached copy. */
  refresh(force = false): Promise<void> {
    // `.finally` always runs asynchronously, so `refreshing` is cleared after it was assigned.
    this.refreshing ??= this.refreshStale(force).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refreshStale(force: boolean): Promise<void> {
    for (const s of this.d.sources()) {
      const cur = this.lists.get(s.id);
      if (!force && cur?.fetchedAt && this.now() - cur.fetchedAt < BLOCKLIST_REFRESH_MS) continue;
      await this.download(s);
    }
    this.rebuild();
  }

  private async download(s: BlocklistSource): Promise<void> {
    const prev = this.lists.get(s.id);
    try {
      // A plain GET: no cookies, no identifiers, nothing about the stream or its viewers.
      const res = await (this.d.fetch ?? fetch)(s.url, { redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ranges = parseBlocklist(await readBodyCapped(res, MAX_BYTES));
      if (ranges.length === 0) throw new Error('no entries');
      const fetchedAt = this.now();
      ensurePrivateDir(this.d.dir);
      // Only the parsed networks are kept, never the downloaded bytes as they came.
      writePrivateFile(this.file(s.id, 'txt'), blocklistCacheText(ranges));
      writePrivateFile(this.file(s.id, 'json'), JSON.stringify({ url: s.url, fetchedAt, entries: ranges.length } satisfies CacheMeta) + '\n');
      this.lists.set(s.id, { ranges, fetchedAt });
      this.d.log.info({ list: s.id, entries: ranges.length }, 'blocklist updated');
    } catch (err) {
      const error = (err as Error).message;
      this.lists.set(s.id, { ranges: prev?.ranges ?? [], ...(prev?.fetchedAt ? { fetchedAt: prev.fetchedAt } : {}), error });
      this.d.log.info({ list: s.id, err: error }, 'blocklist download failed; using the cached copy if any');
    }
  }

  private rebuild(): void {
    const wanted = new Set(this.d.sources().map((s) => s.id));
    const all: CidrRange[] = [];
    for (const [id, l] of this.lists) if (wanted.has(id)) all.push(...l.ranges);
    this.set = new CidrSet(all);
  }
}
