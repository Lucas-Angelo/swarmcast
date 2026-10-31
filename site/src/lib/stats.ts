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

/** A same-origin reader of stats.json that fetches once and gives every caller that answer. Never throws. */
export function usageLoader(fetchImpl: typeof fetch = fetch): (url: string) => Promise<UsageView> {
  let pending: Promise<UsageView> | null = null;
  return (url) =>
    (pending ??= fetchImpl(url, { credentials: 'omit', cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .then(parseSummary)
      .catch(() => parseSummary(null)));
}

/** The page's reader: the usage numbers, the download button and the download page share one fetch. */
export const loadUsage = usageLoader();
