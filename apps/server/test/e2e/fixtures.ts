import fs from 'node:fs';
import path from 'node:path';
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { AdminState } from '@swarmcast/shared';

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
export async function join(browser: Browser, nickname: string, link?: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(link ?? (await liveLink()));
  await expect(page).toHaveURL(/\/join$/);
  await page.fill('#nickname', nickname);
  await page.click('#join');
  await expect(page).toHaveURL(/\/watch$/);
  return { context, page };
}

export async function waitPlaying(page: Page, seconds = 1.5): Promise<void> {
  await page.waitForFunction((s) => {
    const v = document.querySelector('video');
    return !!v && v.currentTime > s && !v.paused;
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
  p2pEnabled: boolean;
  p2pAllowed: boolean;
}

export async function stats(page: Page): Promise<ViewerStats> {
  return page.evaluate(() => (window as unknown as { __swarmcast: { stats: ViewerStats } }).__swarmcast.stats);
}

/** Make sure P2P is on (it is on by default; `check` is a no-op when already checked). */
export async function enableP2P(page: Page): Promise<void> {
  await page.check('#p2p');
  await expect(page.locator('#p2p')).toBeChecked();
}

export async function viewerByNick(nick: string): Promise<AdminState['viewers'][number] | undefined> {
  return (await adminState()).viewers.find((v) => v.nickname === nick);
}
