// Usage numbers WITHOUT telemetry: SwarmCast never phones home. Everything here comes from
// GitHub's public release download counters (REST API `download_count`).
//
// 1. Downloads: the sum of `download_count` of the installer assets of every release
//    (desktop installers, the script-mode installer zips and packages). It includes the
//    updates the desktop app downloads by itself on Windows (setup .exe) and Linux (AppImage).
// 2. Apps opened this week (approximate): the desktop app downloads `latest.json` from the
//    latest release when it starts and every 6 hours while it stays open (docs/DESKTOP.md),
//    and GitHub counts each of those downloads. A daily snapshot of that counter (per release
//    tag, because a new release brings a new latest.json that starts again at 0) gives the
//    number of update checks over the last 7 days. One app makes at least one check per start;
//    we assume CHECKS_PER_APP_PER_WEEK on average (a few lives a week, each shorter than 6 h),
//    so apps ~= checks / CHECKS_PER_APP_PER_WEEK. The site explains this on its privacy page.
//
// Pure functions only (no I/O): see update.mjs for the CLI that fetches and writes files.

export const UPDATER_MANIFEST = 'latest.json';
export const CHECKS_PER_APP_PER_WEEK = 3;
export const HISTORY_VERSION = 1;
export const SUMMARY_VERSION = 1;
/** Snapshots older than this are dropped from the history file. */
export const KEEP_DAYS = 400;

const DAY = 86_400_000;

const x64 = /(x64|amd64|x86_64)/i;
const arm64 = /(arm64|aarch64)/i;

/**
 * What a release asset is.
 * kind: 'installer' (counted as a download), 'package' (script / one-line installs, counted),
 * 'updater-manifest' (latest.json), 'updater' (updater-only bundle or signature, not counted),
 * 'other' (scripts, checksums...).
 * target: download slot for the site's button (desktop installers only).
 * @param {string} name
 * @returns {{ kind: 'installer' | 'package' | 'updater-manifest' | 'updater' | 'other', os?: 'windows' | 'macos' | 'linux', target?: string }}
 */
export function classifyAsset(name) {
  const n = String(name);
  if (n === UPDATER_MANIFEST) return { kind: 'updater-manifest' };
  if (/\.(sig|minisig)$/i.test(n) || /\.app\.tar\.gz$/i.test(n)) return { kind: 'updater' };
  if (/-setup\.exe$/i.test(n)) return { kind: 'installer', os: 'windows', target: arm64.test(n) ? 'windows-arm64' : 'windows-x64' };
  if (/\.msi$/i.test(n)) return { kind: 'installer', os: 'windows' };
  if (/\.dmg$/i.test(n)) {
    const target = arm64.test(n) ? 'macos-arm64' : x64.test(n) ? 'macos-x64' : /universal/i.test(n) ? 'macos-universal' : undefined;
    return target ? { kind: 'installer', os: 'macos', target } : { kind: 'installer', os: 'macos' };
  }
  if (/\.deb$/i.test(n)) return { kind: 'installer', os: 'linux', ...(arm64.test(n) ? { target: 'linux-deb-arm64' } : x64.test(n) ? { target: 'linux-deb-x64' } : {}) };
  if (/\.appimage$/i.test(n)) return { kind: 'installer', os: 'linux', ...(arm64.test(n) ? { target: 'linux-appimage-arm64' } : x64.test(n) ? { target: 'linux-appimage-x64' } : {}) };
  if (/\.rpm$/i.test(n)) return { kind: 'installer', os: 'linux' };
  let m = /-(windows|macos|linux)-(x64|arm64)-installer\.zip$/i.exec(n);
  if (m) return { kind: 'installer', os: /** @type {'windows' | 'macos' | 'linux'} */ (m[1].toLowerCase()) };
  m = /^SwarmCast-v?\d[\w.-]*-(windows|macos|linux)-(x64|arm64)\.(zip|tar\.gz)$/i.exec(n);
  if (m) return { kind: 'package', os: /** @type {'windows' | 'macos' | 'linux'} */ (m[1].toLowerCase()) };
  return { kind: 'other' };
}

/**
 * "About" numbers for the site: exact below 20, then rounded down to a friendly step,
 * so the page never claims more than the counters say.
 * @param {number} n
 */
export function roundAbout(n) {
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n < 20) return Math.floor(n);
  if (n < 100) return Math.floor(n / 5) * 5;
  if (n < 1000) return Math.floor(n / 10) * 10;
  const step = 10 ** (Math.floor(Math.log10(n)) - 1);
  return Math.floor(n / step) * step;
}

/**
 * @typedef {{ name: string, download_count: number, browser_download_url?: string, size?: number }} Asset
 * @typedef {{ tag_name: string, draft?: boolean, prerelease?: boolean, published_at?: string | null, html_url?: string, assets: Asset[] }} Release
 * @typedef {{ at: string, downloads: number, updater: Record<string, number> }} Snapshot
 * @typedef {{ version: number, snapshots: Snapshot[] }} History
 */

/**
 * Totals of the installer downloads across all releases.
 * @param {Release[]} releases
 */
export function countDownloads(releases) {
  const byOs = { windows: 0, macos: 0, linux: 0 };
  const byKind = { installer: 0, package: 0 };
  for (const r of releases) {
    if (r.draft) continue;
    for (const a of r.assets ?? []) {
      const c = classifyAsset(a.name);
      if (c.kind !== 'installer' && c.kind !== 'package') continue;
      const count = Math.max(0, Number(a.download_count) || 0);
      byKind[c.kind] += count;
      if (c.os) byOs[c.os] += count;
    }
  }
  return { total: byKind.installer + byKind.package, byKind, byOs };
}

/**
 * Today's snapshot: total downloads and the latest.json counter of every release tag.
 * @param {Release[]} releases
 * @param {Date} now
 * @returns {Snapshot}
 */
export function takeSnapshot(releases, now) {
  /** @type {Record<string, number>} */
  const updater = {};
  for (const r of releases) {
    if (r.draft) continue;
    const manifest = (r.assets ?? []).find((a) => a.name === UPDATER_MANIFEST);
    if (manifest) updater[r.tag_name] = Math.max(0, Number(manifest.download_count) || 0);
  }
  return { at: now.toISOString(), downloads: countDownloads(releases).total, updater };
}

/**
 * Adds a snapshot. A snapshot from the same UTC day replaces the earlier one (the counters
 * only grow, so the later one carries everything), and very old ones are dropped.
 * @param {History | null | undefined} history
 * @param {Snapshot} snap
 * @returns {History}
 */
export function addSnapshot(history, snap) {
  const day = snap.at.slice(0, 10);
  const cutoff = Date.parse(snap.at) - KEEP_DAYS * DAY;
  const kept = (history?.snapshots ?? []).filter(
    (s) => s && typeof s.at === 'string' && s.at.slice(0, 10) !== day && Date.parse(s.at) >= cutoff && Date.parse(s.at) < Date.parse(snap.at),
  );
  return { version: HISTORY_VERSION, snapshots: [...kept, snap].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)) };
}

/**
 * Update checks (latest.json downloads) in the last 7 days, from the newest snapshot and the
 * newest one taken at least 7 days before it (or the oldest one, scaled to 7 days, while the
 * history is shorter than a week). Per tag: growth since the base snapshot; a tag that did
 * not exist yet starts at 0 (a new release); a counter that went down (asset replaced) counts
 * its new value. Returns null with less than 20 hours of history.
 * @param {Snapshot[]} snapshots sorted oldest first
 */
export function weeklyChecks(snapshots) {
  if (!snapshots?.length) return null;
  const last = snapshots[snapshots.length - 1];
  const lastAt = Date.parse(last.at);
  const wanted = lastAt - 7 * DAY + 3_600_000; // 1 h tolerance for the cron schedule drifting
  let base = snapshots[0];
  for (const s of snapshots) if (Date.parse(s.at) <= wanted) base = s;
  const days = (lastAt - Date.parse(base.at)) / DAY;
  if (days < 20 / 24) return null;
  let checks = 0;
  for (const [tag, count] of Object.entries(last.updater ?? {})) {
    const before = base.updater?.[tag] ?? 0;
    checks += count >= before ? count - before : count;
  }
  // Scaled to exactly 7 days: shorter histories are extrapolated (flagged `partial`), and a
  // base older than 7 days (missed daily runs) is averaged down.
  return { checks: Math.round((checks * 7) / days), days: Math.round(days * 10) / 10, partial: days < 6.5 };
}

/**
 * Picks the desktop installers of the latest stable release for the site's download button.
 * @param {Release | null | undefined} latest
 */
export function latestDownloads(latest) {
  if (!latest) return null;
  /** @type {Record<string, { name: string, url: string, size: number }>} */
  const assets = {};
  for (const a of latest.assets ?? []) {
    const c = classifyAsset(a.name);
    if (c.kind === 'installer' && c.target && !assets[c.target] && a.browser_download_url) {
      assets[c.target] = { name: a.name, url: a.browser_download_url, size: Number(a.size) || 0 };
    }
  }
  return {
    tag: latest.tag_name,
    version: latest.tag_name.replace(/^v/, ''),
    url: latest.html_url ?? '',
    publishedAt: latest.published_at ?? null,
    assets,
  };
}

/**
 * The small file the site reads (site/public/stats.json).
 * @param {{ releases: Release[], latest: Release | null, history: History, now: Date, repo: string }} input
 */
export function buildSummary({ releases, latest, history, now, repo }) {
  const downloads = countDownloads(releases);
  const week = weeklyChecks(history.snapshots);
  const apps =
    week && week.checks > 0
      ? {
          week: roundAbout(Math.max(1, week.checks / CHECKS_PER_APP_PER_WEEK)),
          checks: week.checks,
          days: week.days,
          partial: week.partial,
          checksPerApp: CHECKS_PER_APP_PER_WEEK,
        }
      : null;
  return {
    version: SUMMARY_VERSION,
    generatedAt: now.toISOString(),
    repo,
    downloads: { ...downloads, about: roundAbout(downloads.total) },
    apps,
    latest: latestDownloads(latest),
  };
}
