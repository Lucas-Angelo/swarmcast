import fs from 'node:fs';
import path from 'node:path';
import { expect, test as base, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import type { AdminState, QualitySettingsUpdate, QualityState } from '@swarmcast/shared';
import { NICKNAME_MAX } from '@swarmcast/shared';
import { currentStall, stallTick, type StallState } from './stall-monitor.js';

export { expect };

function e2eEnv(): { adminLoginUrl: string; dataDir: string; downloadsDir: string } {
  return JSON.parse(fs.readFileSync(path.join('test-results', 'e2e-env.json'), 'utf8')) as ReturnType<typeof e2eEnv>;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The base of a URL on this machine (http, 127.0.0.1 / localhost / ::1, a numeric port),
 * rebuilt from those checked parts; anything else throws. Every request the fixtures send goes
 * to such a base, never to a URL taken as it is from a file or an answer.
 */
export function loopbackBase(raw: string): URL {
  const u = new URL(raw);
  if (u.protocol !== 'http:' || !LOOPBACK.has(u.hostname) || !/^\d{1,5}$/.test(u.port)) throw new Error(`not a loopback http URL: ${raw}`);
  return new URL(`http://${u.hostname}:${Number(u.port)}/`);
}

// The test control port of apps/server/test/e2e/server.ts (keep in sync: 38082 moved by
// SWARMCAST_E2E_PORT_OFFSET, like the other e2e ports).
const CONTROL = loopbackBase(`http://127.0.0.1:${38082 + Number(process.env.SWARMCAST_E2E_PORT_OFFSET ?? 0)}`);

/** What GET /health on the test control port answers (apps/server/test/e2e/server.ts). */
export interface StreamHealth {
  ok: boolean;
  problems: string[];
  phase: string;
  variants: number[];
  sinceSegmentMs: number | null;
  playlistS: number;
  previousTest: string;
  [k: string]: unknown;
}

async function control<T>(method: 'GET' | 'POST', pathname: string, body?: unknown): Promise<T> {
  const res = await fetch(new URL(pathname, CONTROL), {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`test control ${method} ${pathname}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** Test-only: back to the server's starting state (see reset() in server.ts). */
export function resetServer(o: { hard?: boolean; test?: string } = {}): Promise<{ previous: string; did: string[] }> {
  return control('POST', `/reset${o.hard ? '?hard=1' : ''}`, o.test === undefined ? {} : { test: o.test });
}

/**
 * Test-only: the stream's health, waiting up to `waitMs` for it: `qualities` variants (default
 * 1, the ladder off) and every media playlist holding `minPlaylistS`.
 */
export function streamHealth(o: { waitMs?: number; minPlaylistS?: number; qualities?: number } = {}): Promise<StreamHealth> {
  return control('GET', `/health?waitMs=${o.waitMs ?? 0}&minPlaylistS=${o.minPlaylistS ?? 0}&qualities=${o.qualities ?? 1}`);
}

/**
 * Wait until the live playlist covers `seconds` (viewers normally join a stream that has run
 * for a while: right after OBS starts the playlist is short and players sit at the live edge).
 */
export async function waitForPlaylist(seconds: number, o: { qualities?: number; timeoutMs?: number } = {}): Promise<void> {
  const h = await streamHealth({ waitMs: o.timeoutMs ?? 90_000, minPlaylistS: seconds, qualities: o.qualities ?? 1 });
  if (!h.ok) throw new Error(`the stream is not ready: ${h.problems.join('; ')} (${JSON.stringify(h)})`);
}

/**
 * Every test starts on a server in its starting state with a healthy stream: the gate resets
 * what earlier tests changed (viewers, bans, rate limits, the attack shield, settings, the
 * ladder and the fake OBS options), then waits for the stream. If it stays unhealthy, OBS
 * reconnects and the gate waits once more; still unhealthy, the test fails at once, naming the
 * test before it, instead of every later test timing out in waitPlaying.
 */
export const test = base.extend<{ streamGate: void }>({
  streamGate: [
    // eslint-disable-next-line no-empty-pattern -- Playwright reads the fixtures a function uses from its first argument
    async ({}, use, testInfo) => {
      const title = `${testInfo.project.name} › ${testInfo.titlePath.slice(1).join(' › ')}${testInfo.retry ? ` (retry ${testInfo.retry})` : ''}`;
      const r = await resetServer({ test: title });
      let h = await streamHealth({ waitMs: r.did.includes('fake OBS reconnected') ? 30_000 : 10_000 });
      if (!h.ok) {
        testInfo.annotations.push({ type: 'stream-unhealthy', description: `after "${r.previous}": ${h.problems.join('; ')}` });
        await resetServer({ hard: true });
        h = await streamHealth({ waitMs: 45_000 });
        if (!h.ok) throw new Error(`stream unhealthy after "${r.previous}" (OBS reconnected, still: ${h.problems.join('; ')}): ${JSON.stringify(h)}`);
      }
      await use();
    },
    { auto: true },
  ],
});

const PROJECT_LETTER: Record<string, string> = { chromium: 'c', firefox: 'f', webkit: 'w' };

/**
 * A nickname unique to this attempt (project, retry and --repeat-each index), so a retry or a
 * repeat never finds an earlier attempt's viewer. Nicknames are at most 24 characters.
 */
export function uid(prefix: string, info: TestInfo = base.info()): string {
  const project = PROJECT_LETTER[info.project.name] ?? info.project.name.slice(0, 2);
  const id = `${prefix}-${project}${info.retry}x${info.repeatEachIndex}`;
  if (id.length > NICKNAME_MAX) throw new Error(`nickname "${id}" is longer than ${NICKNAME_MAX} characters: shorten the prefix "${prefix}"`);
  return id;
}

let adminCookie: string | null = null;
let adminBase: URL | null = null;

/** The panel's base URL and a session cookie, from the control port (`GET /env`). */
async function adminAuth(): Promise<{ cookie: string; base: URL }> {
  if (adminCookie && adminBase) return { cookie: adminCookie, base: adminBase };
  const env = await control<{ adminUrl: string; adminLoginPath: string }>('GET', '/env');
  const base = loopbackBase(env.adminUrl);
  if (!/^\/auth\/[\w-]+$/.test(env.adminLoginPath)) throw new Error(`unexpected panel login path: ${env.adminLoginPath}`);
  const res = await fetch(new URL(env.adminLoginPath, base), { redirect: 'manual' });
  adminCookie = res.headers.getSetCookie()[0]!.split(';')[0]!;
  adminBase = base;
  return { cookie: adminCookie, base };
}

export async function adminState(): Promise<AdminState> {
  const { cookie, base } = await adminAuth();
  const res = await fetch(new URL('/api/state', base), { headers: { cookie } });
  return (await res.json()) as AdminState;
}

export async function admin(pathname: string, body: unknown = {}): Promise<unknown> {
  const { cookie, base } = await adminAuth();
  const res = await fetch(new URL(pathname, base), {
    method: 'POST',
    headers: { cookie, origin: base.origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

/** Any admin API call (GET/PUT/POST) with the panel cookie. */
export async function adminApi<T = unknown>(method: string, pathname: string, body?: unknown): Promise<T> {
  const { cookie, base } = await adminAuth();
  const res = await fetch(new URL(pathname, base), {
    method,
    headers: { cookie, origin: base.origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (await res.json()) as T;
}

/** Test-only: force the attack shield's automatic browser check level (0 = back to the settings). */
export async function forcePowLevel(level: 0 | 1 | 2): Promise<number> {
  return (await control<{ browserCheck: number }>('POST', `/pow-level/${level}`)).browserCheck;
}

/** Test-only: seconds every playlist keeps (40 by default; 20 emulates v0.2.0 ladder audio). */
export async function setPlaylistWindow(seconds: number): Promise<void> {
  await control('POST', `/playlist-window/${seconds}`);
}

/**
 * Start a playback monitor in the page: `stallReport()` then returns the longest time (ms)
 * the playhead did not play while not paused, since the last reset, and how many seconds of
 * media played (`playedS`). Only playback steps count: a jump (the stall watchdog's seeks, a
 * source reload) is neither playback nor lost progress (stall-monitor.ts).
 */
export async function startStallMonitor(page: Page): Promise<void> {
  // stall-monitor.ts, in the page (its source, so the spec and the unit test share the logic).
  await page.evaluate(`window.__stallTick = ${stallTick.toString()}; window.__currentStall = ${currentStall.toString()};`);
  await page.evaluate(() => {
    type W = { __stall?: StallState & { timer: number }; __stallTick: typeof stallTick; __swarmcast?: { delay?: { holding?: boolean } | null } };
    const w = window as unknown as W;
    if (w.__stall) clearInterval(w.__stall.timer);
    const v = document.querySelector('video')!;
    const st = { prev: v.currentTime, prevNow: performance.now(), at: performance.now(), max: 0, played: 0, frozen: false, timer: 0 };
    st.timer = window.setInterval(() => {
      w.__stallTick(st, { now: performance.now(), currentTime: v.currentTime, paused: v.paused, held: w.__swarmcast?.delay?.holding === true });
    }, 200);
    w.__stall = st;
  });
}

export async function stallReport(page: Page): Promise<{ maxStallMs: number; currentStallMs: number; currentTime: number; playedS: number }> {
  return page.evaluate(() => {
    const w = window as unknown as { __stall: StallState; __currentStall: typeof currentStall };
    const current = w.__currentStall(w.__stall, performance.now());
    return { maxStallMs: Math.max(w.__stall.max, current), currentStallMs: current, currentTime: document.querySelector('video')!.currentTime, playedS: w.__stall.played };
  });
}

/**
 * Make the fake OBS reconnect with these options (null = the defaults: 640x360 at 1.2 Mbps; a
 * pre-encoded clip either way). The next test's gate puts the defaults back by itself.
 */
export async function reconnectObs(options: { size?: string; kbps?: number } | null): Promise<void> {
  await control('POST', '/obs', options);
}

/** Quality settings with some ladder fields changed (body for PUT /api/quality). */
export function ladderUpdate(q: QualityState, ladder: Partial<QualitySettingsUpdate['ladder']>): QualitySettingsUpdate {
  return {
    ...q.settings,
    ladder: { ...q.settings.ladder, ...ladder },
    obsWebsocket: { enabled: q.settings.obsWebsocket.enabled, url: q.settings.obsWebsocket.url },
  };
}

/** What the e2e server wrote at start (panel login URL, data and downloads folders). */
export function serverEnv(): { adminLoginUrl: string; dataDir: string; downloadsDir: string } {
  return e2eEnv();
}

/** Wait until OBS (ffmpeg) is live, then return the current link. */
export async function liveLink(): Promise<string> {
  await expect.poll(async () => (await adminState()).phase, { timeout: 60_000 }).toBe('live');
  return (await adminState()).liveLink!;
}

/** Make the link point at the test base URL (it already does without a tunnel). */
export async function join(browser: Browser, nickname: string, link?: string, setup?: (context: BrowserContext) => Promise<void>): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await setup?.(context);
  const page = await context.newPage();
  await page.goto(link ?? (await liveLink()));
  await expect(page).toHaveURL(/\/join$/);
  await page.fill('#nickname', nickname);
  // The answer to POST /api/join, so a refused join fails with the server's status and reason
  // instead of a bare toHaveURL timeout. A 403 "check required" is not final: the page solves
  // the browser check and posts again.
  const answer = page.waitForResponse(async (r) => {
    if (r.request().method() !== 'POST' || new URL(r.url()).pathname !== '/api/join') return false;
    if (r.status() !== 403) return true;
    const body = (await r.json().catch(() => ({}))) as { code?: string };
    return body.code !== 'viewer.err.checkRequired';
  }, { timeout: 0 });
  // The page shows an error without a final answer when the browser check fails.
  const shownError = page.locator('#error').waitFor({ state: 'visible', timeout: 0 }).then(() => null);
  answer.catch(() => {});
  shownError.catch(() => {});
  await page.click('#join');
  const res = await Promise.race([answer, shownError]);
  if (!res) throw new Error(`join as "${nickname}" failed without a final POST /api/join answer; the page says: ${await page.locator('#error').textContent()}`);
  expect(res.status(), `POST /api/join as "${nickname}" answered ${res.status()}: ${await res.text().catch(() => '(no body)')}`).toBe(200);
  await expect(page).toHaveURL(/\/watch$/);
  return { context, page };
}

/**
 * Wait until the video has really played `seconds` (summed `played` ranges, not currentTime:
 * hls.js seeks to the live start position before the first frame plays, so a large
 * currentTime alone does not mean playback started).
 */
export async function waitPlaying(page: Page, seconds = 1.5): Promise<void> {
  await page.waitForFunction((s) => {
    const v = document.querySelector('video');
    if (!v || v.paused) return false;
    let played = 0;
    for (let i = 0; i < v.played.length; i++) played += v.played.end(i) - v.played.start(i);
    return played > s;
  }, seconds, { timeout: 60_000 });
}

/**
 * Turn the sound on, as a viewer does with the Unmute button (the video autoplays muted). For
 * the scenarios that time playback: Chrome clocks muted, video-only playback by the frames it
 * gets on screen, and on the 3-vCPU macOS runner, which composites about 15 frames a second,
 * muted video then plays at about half speed. Measured there (probe in PR #21): 0.55x muted,
 * 1.02x with sound, its audio output clocking playback; 1.0x both ways on Ubuntu.
 */
export async function unmute(page: Page): Promise<void> {
  const button = page.locator('#unmute');
  if (await button.isVisible()) await button.click();
  await expect.poll(() => page.evaluate(() => document.querySelector('video')!.muted)).toBe(false);
}

export async function currentTime(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector('video')!.currentTime);
}

export interface ViewerStats {
  httpBytes: number;
  p2pDownBytes: number;
  p2pUpBytes: number;
  peers: string[];
  hashFailures: number;
  httpFallbacks: number;
  peersDropped: number;
  stallRecoveries: number;
  /** Times the player loaded the source again (watch.ts), and why the last time. */
  reloads: number;
  lastReload: string | null;
  p2pEnabled: boolean;
  p2pAllowed: boolean;
}

export async function stats(page: Page): Promise<ViewerStats> {
  return page.evaluate(() => (window as unknown as { __swarmcast: { stats: ViewerStats } }).__swarmcast.stats);
}

/** Turn P2P on (it is off by default, opt-in; `check` is a no-op when already checked). */
export async function enableP2P(page: Page): Promise<void> {
  await page.check('#p2p');
  await expect(page.locator('#p2p')).toBeChecked();
}

/**
 * The viewer with this nickname (nicknames come from uid(), so they are unique to the attempt).
 * If one ever appears twice, prefer a connected one, then the newest.
 */
export async function viewerByNick(nick: string): Promise<AdminState['viewers'][number] | undefined> {
  const matches = (await adminState()).viewers.filter((v) => v.nickname === nick);
  return matches.findLast((v) => v.connected) ?? matches.at(-1);
}
