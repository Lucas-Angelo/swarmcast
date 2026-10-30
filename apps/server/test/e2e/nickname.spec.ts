import type { Browser, Page } from '@playwright/test';
import { translate } from '@swarmcast/shared/i18n';
import { expect, join, liveLink, test, uid } from './fixtures.js';

/**
 * Nickname rules v2 on the join page (docs/CHAT.md): nicknames are visible to everyone in the
 * chat, so the page refuses invalid names as they are typed (the same shared rules as the
 * server), and the server refuses look-alikes of someone watching.
 */

async function joinPage(browser: Browser, lang: 'en' | 'pt-BR' = 'en'): Promise<Page> {
  const ctx = await browser.newContext({ locale: lang === 'pt-BR' ? 'pt-BR' : 'en-US' });
  const page = await ctx.newPage();
  await page.goto(await liveLink());
  await expect(page).toHaveURL(/\/join$/);
  return page;
}

test('invalid nicknames are refused as they are typed, before anything is sent', { tag: '@ui' }, async ({ browser }) => {
  const page = await joinPage(browser);
  const posts: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/join') posts.push(r.url());
  });
  const error = page.locator('#error');
  for (const [name, code] of [
    ['Ana\u{1F600}', 'nickname.chars'],
    ['\u{3164}\u{3164}', 'nickname.chars'],
    ['Ana\u{202E}x', 'nickname.chars'],
    ['Z\u{300}\u{301}\u{302}algo', 'nickname.marks'],
    ['\u{405}treamer', 'nickname.mixed'],
    ['Streamer', 'nickname.reserved'],
    ['a'.repeat(25), 'nickname.tooLong'],
  ] as const) {
    await page.fill('#nickname', name);
    await expect(error, name).toBeVisible();
    await expect(error, name).toHaveText(translate('en', code, { max: 24, min: 2 }));
    await expect(page.locator('#nickname')).toHaveAttribute('aria-invalid', 'true');
    await page.click('#join');
    await expect(page).toHaveURL(/\/join$/);
  }
  // A valid name clears the message.
  await page.fill('#nickname', 'Nguyễn');
  await expect(error).toBeHidden();
  expect(posts).toEqual([]);
  await page.context().close();
});

test('one character: no complaint while typing the first letter, a clear reason on submit', { tag: '@ui' }, async ({ browser }) => {
  const page = await joinPage(browser);
  const error = page.locator('#error');
  await page.locator('#nickname').pressSequentially('A');
  await expect(error).toBeHidden();
  await page.click('#join');
  await expect(error).toHaveText(translate('en', 'nickname.tooShort', { min: 2 }));
  await expect(page).toHaveURL(/\/join$/);
  await page.context().close();
});

test('the reasons are in Portuguese for pt-BR browsers', { tag: '@ui' }, async ({ browser }) => {
  const page = await joinPage(browser, 'pt-BR');
  await page.fill('#nickname', 'Ana\u{1F600}');
  await expect(page.locator('#error')).toHaveText(translate('pt-BR', 'nickname.chars'));
  await page.fill('#nickname', 'Admin');
  await expect(page.locator('#error')).toHaveText(translate('pt-BR', 'nickname.reserved'));
  await page.context().close();
});

test('the server refuses a look-alike of someone watching and suggests a free name', { tag: '@ui' }, async ({ browser }) => {
  const name = uid('nk');
  const first = await join(browser, name);
  const page = await joinPage(browser);
  await page.fill('#nickname', name.toUpperCase());
  const answer = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/join');
  await page.click('#join');
  const res = await answer;
  expect(res.status()).toBe(400);
  const body = (await res.json()) as { code: string; params: { suggestion: string } };
  expect(body.code).toBe('nickname.taken');
  await expect(page.locator('#error')).toHaveText(translate('en', 'nickname.taken', body.params));
  await expect(page).toHaveURL(/\/join$/);
  // The suggestion is free and valid.
  await page.fill('#nickname', body.params.suggestion);
  await page.click('#join');
  await expect(page).toHaveURL(/\/watch$/);
  await first.context.close();
  await page.context().close();
});
