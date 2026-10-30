// The light browser check (on by default): the first join of a browser solves it ("Checking your
// browser…" with a progress bar, then the proof is sent), and the httpOnly verified cookie
// spares that browser the check on a new tab, a new link or after "Disconnect everyone". Another
// browser solves again; under attack (level 2) a verified browser solves once more and is
// remembered at that level. A kicked device stays blocked, verified or not.
//
// The kicked device is its cookie, so the earlier tabs are closed before it opens the link: once
// a goto there never reached "load" in 150 s on WebKit (PR #14, Ubuntu) with five players still
// open in the same session. What is checked is the server's answer, which "commit" already has.
import type { BrowserContext, Page } from '@playwright/test';
import { BROWSER_CHECK_TTL_S, VERIFIED_COOKIE } from '@swarmcast/shared';
import { admin, adminState, expect, forcePowLevel, liveLink, test, uid, viewerByNick } from './fixtures.js';

/**
 * Records, in every tab of `context`, whether its join page ever showed "Checking your
 * browser…" (#check). The page keeps it up at least 600 ms (join.ts CHECK_MIN_VISIBLE_MS);
 * recording it as it happens does not depend on the test looking within that time, and the
 * tab's sessionStorage keeps the answer once the join has moved on to /watch.
 */
async function recordCheckShown(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    new MutationObserver(() => {
      const el = document.getElementById('check');
      if (el && !el.hidden) sessionStorage.setItem('e2e.checkShown', '1');
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] });
  });
}

const checkWasShown = (page: Page): Promise<boolean> => page.evaluate(() => sessionStorage.getItem('e2e.checkShown') === '1');

/**
 * Opens a link in `page` and joins; returns whether the page had to solve the browser check.
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

test('the browser check is on by default and asked once per browser', { tag: '@ui' }, async ({ viewers }) => {
  // Arrange
  expect((await adminState()).security).toMatchObject({ browserCheck: 1, settings: { requireBrowserCheck: true } });
  const ctx = await viewers.browserContext({ setup: recordCheckShown });
  const first = await ctx.newPage();
  const challenge = first.waitForResponse((r) => r.url().endsWith('/api/join/challenge'));

  // Act
  await first.goto(await liveLink());

  // Assert
  expect(((await (await challenge).json()) as { required: boolean }).required).toBe(true);
  await expect.poll(() => checkWasShown(first)).toBe(true);
  await expect(first.locator('#check')).toBeHidden();
  await expect(first.locator('#check-progress')).toHaveJSProperty('value', 1);

  // Act
  await first.fill('#nickname', uid('bc1'));
  await first.click('#join');

  // Assert
  await expect(first).toHaveURL(/\/watch$/);
  const cookie = (await ctx.cookies()).find((c) => c.name === VERIFIED_COOKIE)!;
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
  expect(cookie.value).toMatch(/^v1\.1\./);
  expect(cookie.expires * 1000).toBeGreaterThan(Date.now() + (BROWSER_CHECK_TTL_S - 300) * 1000);

  // Act
  await admin('/api/link/rotate');
  const second = await ctx.newPage();
  const onNewLink = await joinOn(second, (await adminState()).liveLink!, uid('bc2'));

  // Assert
  expect(onNewLink).toEqual({ required: false, sentProof: false });
  expect(await checkWasShown(second)).toBe(false);

  // Act
  const afterDisconnect = await joinOn(second, await liveLink(), uid('bc3'));

  // Assert
  expect(afterDisconnect).toEqual({ required: false, sentProof: false });

  // Act
  const otherBrowser = await joinOn(await (await viewers.browserContext()).newPage(), await liveLink(), uid('bc4'));

  // Assert
  expect(otherBrowser).toEqual({ required: true, sentProof: true });

  // Act
  expect(await forcePowLevel(2)).toBe(2);
  const underAttack = await joinOn(await ctx.newPage(), await liveLink(), uid('bc5'));

  // Assert
  expect(underAttack).toEqual({ required: true, sentProof: true });
  expect((await ctx.cookies()).find((c) => c.name === VERIFIED_COOKIE)!.value).toMatch(/^v1\.2\./);
  expect(await joinOn(await ctx.newPage(), await liveLink(), uid('bc6'))).toEqual({ required: false, sentProof: false });

  // Act
  await forcePowLevel(0);
  const v = await viewerByNick(uid('bc6'));
  await admin(`/api/viewers/${v!.sessionId}/kick`);
  for (const p of ctx.pages()) await p.close();
  const banned = await ctx.newPage();
  const res = await banned.goto(await liveLink(), { waitUntil: 'commit' });

  // Assert
  expect(res?.status()).toBe(403);
  await expect(banned).not.toHaveURL(/\/watch$/);
});
