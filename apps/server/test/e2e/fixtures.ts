import fs from 'node:fs';
import path from 'node:path';
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { AdminState, QualitySettingsUpdate, QualityState } from '@swarmcast/shared';

let adminCookie: string | null = null;
let adminUrl = '';

async function adminAuth(): Promise<string> {
  if (adminCookie) return adminCookie;
  const env = JSON.parse(fs.readFileSync(path.join('test-results', 'e2e-env.json'), 'utf8')) as { adminLoginUrl: string; adminUrl: string };
  adminUrl = env.adminUrl;
  const res = await fetch(env.adminLoginUrl, { redirect: 'manual' });
  adminCookie = res.headers.getSetCookie()[0]!.split(';')[0]!;
  return adminCookie;
}

export async function adminState(): Promise<AdminState> {
  const cookie = await adminAuth();
  const res = await fetch(`${adminUrl}/api/state`, { headers: { cookie } });
  return (await res.json()) as AdminState;
}

export async function admin(pathname: string, body: unknown = {}): Promise<unknown> {
  const cookie = await adminAuth();
  const res = await fetch(`${adminUrl}${pathname}`, {
    method: 'POST',
    headers: { cookie, origin: adminUrl, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

/** Any admin API call (GET/PUT/POST) with the panel cookie. */
export async function adminApi<T = unknown>(method: string, pathname: string, body?: unknown): Promise<T> {
  const cookie = await adminAuth();
  const res = await fetch(`${adminUrl}${pathname}`, {
    method,
    headers: { cookie, origin: adminUrl, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (await res.json()) as T;
}

/** Test-only: force the attack shield's automatic browser check level (0 = back to the settings). */
export async function forcePowLevel(level: 0 | 1 | 2): Promise<number> {
  const env = JSON.parse(fs.readFileSync(path.join('test-results', 'e2e-env.json'), 'utf8')) as { testControlUrl: string };
  const res = await fetch(`${env.testControlUrl}/pow-level/${level}`, { method: 'POST' });
  return ((await res.json()) as { browserCheck: number }).browserCheck;
}

/** Test-only: seconds every playlist keeps (40 by default; 20 emulates v0.2.0 ladder audio). */
export async function setPlaylistWindow(seconds: number): Promise<void> {
  const env = JSON.parse(fs.readFileSync(path.join('test-results', 'e2e-env.json'), 'utf8')) as { testControlUrl: string };
  await fetch(`${env.testControlUrl}/playlist-window/${seconds}`, { method: 'POST' });
}

/**
 * Start a playback monitor in the page: `stallReport()` then returns the longest time (ms)
 * the playhead did not move while playing, since the last reset, and how many seconds of media
 * played (`playedS`: forward progress only, so a source reload that restarts the timeline or a
 * seek back does not count as lost progress, and a jump forward counts at most 1 s).
 */
export async function startStallMonitor(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __stall?: { last: number; prev: number; at: number; max: number; played: number; timer: number } };
    if (w.__stall) clearInterval(w.__stall.timer);
    const v = document.querySelector('video')!;
    const st = { last: v.currentTime, prev: v.currentTime, at: performance.now(), max: 0, played: 0, timer: 0 };
    st.timer = window.setInterval(() => {
      const now = performance.now();
      // The adaptive delay's hold inside a stall pauses the video, but the viewer sees a freeze.
      const held = (window as unknown as { __swarmcast?: { delay?: { holding?: boolean } | null } }).__swarmcast?.delay?.holding === true;
      const step = v.currentTime - st.prev;
      if (step > 0) st.played += Math.min(step, 1);
      st.prev = v.currentTime;
      // Back in time (source reloaded): measure the next stall from the new position.
      if (v.currentTime < st.last) st.last = v.currentTime;
      if ((v.paused && !held) || v.currentTime > st.last + 0.05) {
        st.last = v.currentTime;
        st.at = now;
      } else {
        st.max = Math.max(st.max, now - st.at);
      }
    }, 200);
    w.__stall = st;
  });
}

export async function stallReport(page: Page): Promise<{ maxStallMs: number; currentStallMs: number; currentTime: number; playedS: number }> {
  return page.evaluate(() => {
    const st = (window as unknown as { __stall: { last: number; at: number; max: number; played: number } }).__stall;
    const v = document.querySelector('video')!;
    const held = (window as unknown as { __swarmcast?: { delay?: { holding?: boolean } | null } }).__swarmcast?.delay?.holding === true;
    const current = (v.paused && !held) || v.currentTime > st.last + 0.05 ? 0 : performance.now() - st.at;
    return { maxStallMs: Math.max(st.max, current), currentStallMs: current, currentTime: v.currentTime, playedS: st.played };
  });
}

const PUSH_FILE = path.join('test-results', 'e2e-push.json');

/** Make the fake OBS reconnect with these options (the e2e server reads the file on SIGUSR2). */
export function reconnectObs(options: { size?: string; kbps?: number } | null): void {
  if (options) fs.writeFileSync(PUSH_FILE, JSON.stringify(options));
  else fs.rmSync(PUSH_FILE, { force: true });
  process.kill(e2eServerPid(), 'SIGUSR2');
}

/** Quality settings with some ladder fields changed (body for PUT /api/quality). */
export function ladderUpdate(q: QualityState, ladder: Partial<QualitySettingsUpdate['ladder']>): QualitySettingsUpdate {
  return {
    ...q.settings,
    ladder: { ...q.settings.ladder, ...ladder },
    obsWebsocket: { enabled: q.settings.obsWebsocket.enabled, url: q.settings.obsWebsocket.url },
  };
}

/** pid of the e2e server (for test-only signals). */
export function e2eServerPid(): number {
  return (JSON.parse(fs.readFileSync(path.join('test-results', 'e2e-env.json'), 'utf8')) as { pid: number }).pid;
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
 * The viewer with this nickname. When a test is retried the first attempt's session (same
 * nickname, now disconnected) is still listed, so prefer a connected one, then the newest.
 */
export async function viewerByNick(nick: string): Promise<AdminState['viewers'][number] | undefined> {
  const matches = (await adminState()).viewers.filter((v) => v.nickname === nick);
  return matches.findLast((v) => v.connected) ?? matches.at(-1);
}
