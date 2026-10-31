// Nickname rules v2 on the join page (docs/CHAT.md): nicknames are visible to everyone in the
// chat, so the page refuses invalid names as they are typed (the same shared rules as the
// server) and sends nothing, and the server refuses look-alikes of someone watching, with a
// free name to use instead. A single first letter is not a complaint yet; Join explains it.
import { translate } from '@swarmcast/shared/i18n';
import { expect, test, uid } from './fixtures.js';

const INVALID_NAMES = [
  ['Ana\u{1F600}', 'nickname.chars'],
  ['\u{3164}\u{3164}', 'nickname.chars'],
  ['Ana\u{202E}x', 'nickname.chars'],
  ['Z\u{300}\u{301}\u{302}algo', 'nickname.marks'],
  ['\u{405}treamer', 'nickname.mixed'],
  ['Streamer', 'nickname.reserved'],
  ['a'.repeat(25), 'nickname.tooLong'],
] as const;

test('invalid nicknames are refused as they are typed, before anything is sent', { tag: '@ui' }, async ({ viewers }) => {
  // Arrange
  const page = await viewers.atJoinPage();
  const posts: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/join') posts.push(r.url());
  });
  const error = page.locator('#error');

  for (const [name, code] of INVALID_NAMES) {
    // Act
    await page.fill('#nickname', name);

    // Assert
    await expect(error, name).toBeVisible();
    await expect(error, name).toHaveText(translate('en', code, { max: 24, min: 2 }));
    await expect(page.locator('#nickname')).toHaveAttribute('aria-invalid', 'true');

    // Act
    await page.click('#join');

    // Assert
    await expect(page).toHaveURL(/\/join$/);
  }

  // Act
  await page.fill('#nickname', 'Nguyễn');

  // Assert
  await expect(error).toBeHidden();
  expect(posts).toEqual([]);
});

test('one character: no complaint while typing the first letter, a clear reason on submit', { tag: '@ui' }, async ({ viewers }) => {
  // Arrange
  const page = await viewers.atJoinPage();
  const error = page.locator('#error');

  // Act
  await page.locator('#nickname').pressSequentially('A');

  // Assert
  await expect(error).toBeHidden();

  // Act
  await page.click('#join');

  // Assert
  await expect(error).toHaveText(translate('en', 'nickname.tooShort', { min: 2 }));
  await expect(page).toHaveURL(/\/join$/);
});

test('the reasons are in Portuguese for pt-BR browsers', { tag: '@ui' }, async ({ viewers }) => {
  // Arrange
  const page = await viewers.atJoinPage({ context: { locale: 'pt-BR' } });

  // Act
  await page.fill('#nickname', 'Ana\u{1F600}');

  // Assert
  await expect(page.locator('#error')).toHaveText(translate('pt-BR', 'nickname.chars'));

  // Act
  await page.fill('#nickname', 'Admin');

  // Assert
  await expect(page.locator('#error')).toHaveText(translate('pt-BR', 'nickname.reserved'));
});

test('the server refuses a look-alike of someone watching and suggests a free name', { tag: '@ui' }, async ({ viewers }) => {
  // Arrange
  const name = uid('nk');
  await viewers.join(name);
  const page = await viewers.atJoinPage();
  await page.fill('#nickname', name.toUpperCase());
  const answer = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/join');

  // Act
  await page.click('#join');
  const res = await answer;

  // Assert
  expect(res.status()).toBe(400);
  const body = (await res.json()) as { code: string; params: { suggestion: string } };
  expect(body.code).toBe('nickname.taken');
  await expect(page.locator('#error')).toHaveText(translate('en', 'nickname.taken', body.params));
  await expect(page).toHaveURL(/\/join$/);

  // Act
  await page.fill('#nickname', body.params.suggestion);
  await page.click('#join');

  // Assert
  await expect(page).toHaveURL(/\/watch$/);
});
