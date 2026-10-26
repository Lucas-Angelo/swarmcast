import { expect, test, type Page } from '@playwright/test';
import { BROWSER_CHECK_TTL_S, VERIFIED_COOKIE } from '@swarmcast/shared';
import { admin, adminState, forcePowLevel, liveLink, viewerByNick } from './fixtures.js';

test.describe.configure({ mode: 'serial' });

/**
 * Open a link in `page` and join; returns whether the page had to solve the browser check.
 * Everyone is disconnected first, so a session cookie from an earlier join does not skip /join.
 */
async function joinOn(page: Page, link: string, nickname: string): Promise<{ required: boolean; sentProof: boolean }> {
  await admin('/api/viewers/disconnect-all');
  const challenge = page.waitForResponse((r) => r.url().endsWith('/api/join/challenge'));
  await page.goto(link);
  await expect(page).toHaveURL(/\/join$/);
  const { required } = (await (await challenge).json()) as { required: boolean };
  await page.fill('#nickname', nickname);
  const post = page.waitForRequest((r) => r.url().endsWith('/api/join') && r.method() === 'POST');
  await page.click('#join');
  const body = (await post).postDataJSON() as { pow?: unknown };
  await expect(page).toHaveURL(/\/watch$/);
  return { required, sentProof: body.pow !== undefined };
}

test.afterEach(async () => {
  await forcePowLevel(0);
});

test('the browser check is on by default and asked once per browser', async ({ browser, browserName }) => {
  expect((await adminState()).security).toMatchObject({ browserCheck: 1, settings: { requireBrowserCheck: true } });
  const ctx = await browser.newContext();

  // First join: "Checking your browser…" with a progress bar, then the proof is sent.
  const first = await ctx.newPage();
  const challenge = first.waitForResponse((r) => r.url().endsWith('/api/join/challenge'));
  await first.goto(await liveLink());
  expect(((await (await challenge).json()) as { required: boolean }).required).toBe(true);
  await expect(first.locator('#check')).toBeVisible();
  await expect(first.locator('#check-progress')).toBeAttached();
  await expect(first.locator('#check')).toBeHidden();
  await expect(first.locator('#check-progress')).toHaveJSProperty('value', 1);
  await first.fill('#nickname', `bc1-${browserName}`);
  await first.click('#join');
  await expect(first).toHaveURL(/\/watch$/);
  const cookie = (await ctx.cookies()).find((c) => c.name === VERIFIED_COOKIE)!;
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
  expect(cookie.value).toMatch(/^v1\.1\./);
  expect(cookie.expires * 1000).toBeGreaterThan(Date.now() + (BROWSER_CHECK_TTL_S - 300) * 1000);

  // A new tab of the same browser, on a brand-new link: no challenge, no proof.
  await admin('/api/link/rotate');
  const second = await ctx.newPage();
  expect(await joinOn(second, (await adminState()).liveLink!, `bc2-${browserName}`)).toEqual({ required: false, sentProof: false });
  await expect(second.locator('#check')).toBeHidden();
  // "Disconnect everyone" and joining again later: still nothing to solve.
  expect(await joinOn(second, await liveLink(), `bc3-${browserName}`)).toEqual({ required: false, sentProof: false });

  // Another browser (fresh context) solves.
  const other = await browser.newContext();
  expect(await joinOn(await other.newPage(), await liveLink(), `bc4-${browserName}`)).toEqual({ required: true, sentProof: true });

  // Under attack (level 2), the verified browser solves again and is remembered at that level.
  expect(await forcePowLevel(2)).toBe(2);
  const third = await ctx.newPage();
  expect(await joinOn(third, await liveLink(), `bc5-${browserName}`)).toEqual({ required: true, sentProof: true });
  expect((await ctx.cookies()).find((c) => c.name === VERIFIED_COOKIE)!.value).toMatch(/^v1\.2\./);
  expect(await joinOn(await ctx.newPage(), await liveLink(), `bc6-${browserName}`)).toEqual({ required: false, sentProof: false });
  await forcePowLevel(0);

  // A kicked device stays blocked, verified or not.
  const v = await viewerByNick(`bc6-${browserName}`);
  await admin(`/api/viewers/${v!.sessionId}/kick`);
  const banned = await ctx.newPage();
  const res = await banned.goto(await liveLink());
  expect(res?.status()).toBe(403);
  await expect(banned).not.toHaveURL(/\/watch$/);

  await ctx.close();
  await other.close();
  await admin('/api/viewers/disconnect-all');
});
