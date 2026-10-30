// What a viewer does in a real browser, for the system harnesses (scripts/test/windows,
// scripts/test/preflight): open the live link, join, wait for playback, read the player. These
// take Playwright pages; the harnesses own the browsers and the artifacts.
import { lookup } from 'node:dns/promises';
import { poll } from './wait.mjs';

/** Hosts of Cloudflare quick tunnels: brand-new names that may not resolve for a while. */
const QUICK_TUNNEL_HOST = /\.trycloudflare\.com$/i;
/** How often, and how long, a brand-new quick-tunnel name is looked up until it resolves. */
const NAME_LOOKUP_EVERY_MS = 5000;
const NAME_LOOKUP_TIMEOUT_MS = 90_000;

/**
 * Infra recovery, not a retry of SwarmCast: a quick tunnel's name is brand new, and the
 * resolver of the runner may still have it cached as unknown (NXDOMAIN, the zone's negative
 * TTL is 60 s). Waits until the OS resolver knows it, logging that it had to. Any other host
 * (127.0.0.1, localhost) returns at once.
 */
export async function waitForTunnelName(url, log = console.log) {
  const host = new URL(url).hostname;
  if (!QUICK_TUNNEL_HOST.test(host)) return;
  const t0 = Date.now();
  let misses = 0;
  await poll(
    async () => {
      try {
        await lookup(host);
        return true;
      } catch (err) {
        misses++;
        throw err;
      }
    },
    { timeoutMs: NAME_LOOKUP_TIMEOUT_MS, everyMs: NAME_LOOKUP_EVERY_MS, what: `the quick tunnel name ${host} to resolve` },
  );
  if (misses) log(`infra recovery: DNS: ${host} resolved after ${Math.round((Date.now() - t0) / 1000)} s (${misses} lookups said unknown: a brand-new name)`);
}

/** Opens `url` (a live link) in `page` once its name resolves (waitForTunnelName): until the response commits. */
export async function openLink(page, url, log) {
  await waitForTunnelName(url, log);
  await page.goto(url, { timeout: 60_000, waitUntil: 'commit' });
}

/**
 * Opens the join link in `page`, picks a nickname and clicks Watch (no wait for the watch page).
 * Watch is disabled until the page's script handles it, and a click waits for its button to be
 * enabled: so the click itself waits for the script, and no lifecycle event is needed. "load"
 * would also wait for every image and font through the tunnel; DOMContentLoaded was lost once
 * by Firefox on Windows for a join page on screen and running (soak run 41048049827, section 2,
 * viewer caio): its automation layer can miss the event on a navigation that switches process,
 * as the join page's COOP header does (Mozilla bug 1706353).
 */
export async function joinIn(page, link, nickname, log) {
  await openLink(page, link, log);
  await page.waitForURL(/\/join$/, { timeout: 60_000, waitUntil: 'commit' });
  await page.fill('#nickname', nickname);
  await page.click('#join');
}

/** Resolves once the video plays: past `minTime` seconds, not paused, with data to show. */
export async function waitPlaying(page, timeoutMs = 90_000, minTime = 1.5) {
  await page.waitForFunction(
    (t) => {
      const v = document.querySelector('video');
      return v && v.currentTime > t && !v.paused && v.readyState >= 2;
    },
    minTime,
    { timeout: timeoutMs },
  );
}

/** The viewer's own counters (window.__swarmcast.stats: P2P bytes, hash failures, stalls). */
export const playerStats = (page) => page.evaluate(() => window.__swarmcast.stats);

/**
 * Seconds of video the live's media playlist holds now (its #EXTINF), fetched by the viewer page
 * itself (its session cookie): /hls/index.m3u8, or its first variant when that is a
 * multivariant playlist.
 */
export function playlistSeconds(page) {
  return page.evaluate(async () => {
    const index = new URL('/hls/index.m3u8', location.href);
    const get = async (u) => (await fetch(u, { credentials: 'same-origin', cache: 'no-store' })).text();
    let text = await get(index);
    const variant = text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#') && /\.m3u8(\?|$)/.test(l));
    if (variant) text = await get(new URL(variant, index));
    return text
      .split('\n')
      .filter((l) => l.startsWith('#EXTINF:'))
      .reduce((s, l) => s + (Number.parseFloat(l.slice(8)) || 0), 0);
  });
}

/**
 * Seconds of video the live's playlist holds before a viewer who joins starts at the Stable
 * profile's full live sync distance: 20 s (PLAYER_LIVE_DELAYS.stable, packages/shared/src/
 * constants.ts) plus four 2 s segments, below which latencyFor (apps/viewer/src/player-config.ts)
 * shortens the distance to fit the window. Not the page's current liveSyncDuration: that is the
 * shortened one, and a viewer who joined a young live with it started beside the others, played
 * in step with them and never got a segment over P2P (preflight on a real Mac, 3 of 3).
 */
export const LATE_JOINER_WINDOW_S = 28;

/**
 * Waits until a viewer who joins now starts well behind the viewers already watching (they
 * started near the live edge of a young live), on segments they have played and can share over
 * P2P: the live's playlist, read from `page`, holds LATE_JOINER_WINDOW_S.
 */
export async function waitPlaylistForLateJoiners(page, timeoutMs = 120_000) {
  let held = 0;
  await poll(async () => (held = await playlistSeconds(page)) >= LATE_JOINER_WINDOW_S, {
    timeoutMs,
    everyMs: 1000,
    what: `the live's playlist to hold ${LATE_JOINER_WINDOW_S} s`,
    detail: () => `it holds ${held.toFixed(1)} s`,
  });
  return held;
}

/** Two frames after now: what the page's scripts did with an answer it already has is rendered. */
export const renderedTwice = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

/**
 * What a page had done when a check failed: its address, readyState, the navigation's timings
 * (a goto that timed out on "domcontentloaded" shows here whether the event fired at all), the
 * scripts it asked for and which of them arrived, and every resource it fetched with its time.
 * A page stuck in a navigation may never answer: after 10 s it says so instead of hanging.
 */
export async function pageState(page) {
  let timer;
  const timeout = new Promise((resolve) => (timer = setTimeout(() => resolve('page state unavailable: no answer in 10 s'), 10_000)));
  const state = page
    .evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const res = performance.getEntriesByType('resource');
      const got = new Set(res.map((r) => r.name));
      const scripts = [...document.scripts].map((s) => `${s.type || 'classic'} ${s.src || '(inline)'}${s.src ? (got.has(s.src) ? ' fetched' : ' NOT fetched') : ''}`);
      const ms = (v) => (typeof v === 'number' ? Math.round(v) : '?');
      return [
        `url: ${location.href}`,
        `readyState: ${document.readyState}`,
        nav ? `navigation: type ${nav.type}, response end ${ms(nav.responseEnd)} ms, DOMContentLoaded ${ms(nav.domContentLoadedEventEnd)} ms, load ${ms(nav.loadEventEnd)} ms (0 = not yet)` : 'navigation: no entry',
        `scripts:\n  ${scripts.join('\n  ')}`,
        `resources (${res.length}):\n  ${res.map((r) => `${ms(r.startTime)}+${ms(r.duration)} ms ${r.name}`).join('\n  ')}`,
      ].join('\n');
    })
    .catch((e) => `page state unavailable: ${e.message}`);
  return Promise.race([timeout, state]).finally(() => clearTimeout(timer));
}

/**
 * The public health check (/healthz) of a live link's base: its x-swarmcast header (or "ok"),
 * null when it does not answer. A quick tunnel's name is resolved through DNS-over-HTTPS
 * (1.1.1.1), past the negative cache of the runner's resolver, so "no answer" means the tunnel
 * is down, not that the runner forgot the name.
 */
export async function probeHealth(base) {
  const u = new URL('/healthz', base);
  let resolveHost;
  if (u.protocol === 'https:') {
    const r = await fetch(`https://1.1.1.1/dns-query?name=${u.hostname}&type=A`, { headers: { accept: 'application/dns-json' } }).then(
      (x) => x.json(),
      () => ({}),
    );
    const ip = r.Answer?.find((a) => a.type === 1)?.data;
    if (ip) resolveHost = (_h, o, cb) => (o.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4));
  }
  const mod = await import(u.protocol === 'https:' ? 'node:https' : 'node:http');
  return new Promise((resolve) => {
    const req = mod.get(u, { lookup: resolveHost, timeout: 8000, rejectUnauthorized: false }, (res) => {
      res.resume();
      resolve(res.statusCode === 200 ? (res.headers['x-swarmcast'] ?? 'ok') : null);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}
