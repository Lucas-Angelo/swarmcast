// Reads the usage summary (site/public/stats.json, written by scripts/stats/update.mjs and copied
// by the site workflow). Anything missing or malformed means "no data": the block stays hidden.
import type { LatestRelease } from './download';
import type { SiteLang } from './i18n';

export interface UsageView {
  downloads: number | null;
  appsWeek: number | null;
  latest: LatestRelease | null;
}

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : null);

export function parseSummary(data: unknown): UsageView {
  const empty: UsageView = { downloads: null, appsWeek: null, latest: null };
  if (!data || typeof data !== 'object') return empty;
  const d = data as Record<string, unknown>;
  if (d.version !== 1) return empty;
  const downloads = d.downloads && typeof d.downloads === 'object' ? count((d.downloads as Record<string, unknown>).about) : null;
  const apps = d.apps && typeof d.apps === 'object' ? count((d.apps as Record<string, unknown>).week) : null;
  const latest = d.latest && typeof d.latest === 'object' ? (d.latest as LatestRelease) : null;
  return { downloads, appsWeek: apps, latest };
}

export function formatCount(n: number, lang: SiteLang): string {
  return new Intl.NumberFormat(lang).format(n);
}

let pending: Promise<UsageView> | null = null;

/** Same-origin fetch of stats.json, once per page. Never throws. */
export function loadUsage(url: string, fetchImpl: typeof fetch = fetch): Promise<UsageView> {
  pending ??= fetchImpl(url, { credentials: 'omit', cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : null))
    .then(parseSummary)
    .catch(() => parseSummary(null));
  return pending;
}
