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
 * the playhead did not move while playing, since the last reset.
 */
export async function startStallMonitor(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __stall?: { last: number; at: number; max: number; timer: number } };
    if (w.__stall) clearInterval(w.__stall.timer);
    const v = document.querySelector('video')!;
    const st = { last: v.currentTime, at: performance.now(), max: 0, timer: 0 };
    st.timer = window.setInterval(() => {
      const now = performance.now();
      // The adaptive delay's hold inside a stall pauses the video, but the viewer sees a freeze.
      const held = (window as unknown as { __swarmcast?: { delay?: { holding?: boolean } | null } }).__swarmcast?.delay?.holding === true;
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

export async function stallReport(page: Page): Promise<{ maxStallMs: number; currentStallMs: number; currentTime: number }> {
  return page.evaluate(() => {
    const st = (window as unknown as { __stall: { last: number; at: number; max: number } }).__stall;
    const v = document.querySelector('video')!;
    const held = (window as unknown as { __swarmcast?: { delay?: { holding?: boolean } | null } }).__swarmcast?.delay?.holding === true;
    const current = (v.paused && !held) || v.currentTime > st.last + 0.05 ? 0 : performance.now() - st.at;
    return { maxStallMs: Math.max(st.max, current), currentStallMs: current, currentTime: v.currentTime };
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
  await page.click('#join');
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
