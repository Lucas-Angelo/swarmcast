// The panel's chat against the real server (plan chat-0.4.0 §10.3, chat-moderation.spec): the
// live chat at the top of the panel while live (feed, moderation, "Send as …", protection; on
// screen without scrolling, in the desktop window and on a narrow one), the Chat card further
// down (on/off switch, settings), the streamer's badge (the role is the server's, from its roster), delete, mute (the viewer is
// told until when), unmute and "until the stream ends" from the viewers table, clear, colour
// with a lock, the modes (emotes only refuses text), blocked words, links never clickable, the
// on/off switch, protection by hand, the length limit (the panel's own box counts against it
// too), and GIFs, which need the streamer's own key, show the privacy text and always ask each
// viewer's consent (the panel offers no switch for that). Viewers are scripted /control clients
// (fixtures.ts ScriptedViewer: a real join, a real session, real chat frames), so the spec does
// not depend on the viewer page's chat UI.
//
// Every test starts from the default chat, empty and calm, except slow mode and repeats
// (FAST_CHAT), so scripted viewers can talk fast; the `chat` fixture puts the settings back. A
// scripted viewer's join adds a row to the panel's viewers table, right above the Chat card,
// and the same snapshot tells the panel which session wrote which message: the test waits for
// that row (panelShows) before it moderates or clicks anything in the Chat card.
//
// An author's roster entry ('u') goes out once per live; a viewer whose join history does not
// hold the streamer's earlier lines (here: after a clear) must still learn who the streamer is,
// from the roster in their join snapshot (apps/server/src/chat/hub.ts rosterFor).
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import type { AdminChatState, ServerMessage } from '@swarmcast/shared';
import { translate } from '@swarmcast/shared/i18n';
import { admin, adminApi, expect, FAST_CHAT, openPanel, panelShows, test, uid } from './fixtures.js';

/** The desktop app's window (apps/desktop/src-tauri/src/window.rs) and a phone-sized one. */
const APP_WINDOW = { width: 1200, height: 820 };
const NARROW_WINDOW = { width: 420, height: 860 };

test.beforeEach(async ({ chat }) => {
  await chat.change(FAST_CHAT);
  await chat.clear();
});

/**
 * The panel (English or `lang`) while live: `live` is the live chat at the top (feed, protection,
 * "Send as …"), `card` the Chat card further down (switch, settings), loaded.
 */
async function openChat(page: Page, lang?: 'en' | 'pt-BR'): Promise<{ live: Locator; card: Locator }> {
  await openPanel(page, lang);
  const live = page.getByTestId('chat-live');
  const card = page.getByTestId('chat-card');
  await expect(live.getByTestId('chat-input')).toBeVisible();
  await expect(card.getByTestId('chat-settings')).toBeAttached();
  return { live, card };
}

const row = (card: Locator, text: string): Locator => card.getByTestId('chat-msg').filter({ hasText: text });

const chatSettings = async (): Promise<AdminChatState['settings']> => (await adminApi<AdminChatState>('GET', '/api/chat')).settings;

test('the streamer posts with a badge from the role; links are never clickable; delete removes a message for everyone', { tag: '@ui' }, async ({ page, bots }) => {
  // Arrange
  const { live } = await openChat(page);
  const ana = await bots.join(uid('ana'));
  await panelShows(page, ana.nickname);

  // Act
  const sent = await ana.answer(ana.send('hello from ana https://evil.example/x'));

  // Assert
  expect(sent.s).toBeGreaterThan(0);
  const anaRow = row(live, 'hello from ana');
  await expect(anaRow).toBeVisible();
  await expect(anaRow).toContainText(ana.nickname);
  await expect(anaRow.getByTestId('chat-badge')).toHaveCount(0);
  await expect(live.getByTestId('chat-feed').locator('a')).toHaveCount(0);

  // Act
  await live.getByTestId('chat-input').fill('Hi everyone');
  await live.getByTestId('chat-send').click();

  // Assert
  const mine = row(live, 'Hi everyone');
  await expect(mine.getByTestId('chat-badge')).toHaveText(translate('en', 'chat.badge.streamer'));
  await expect(live.getByTestId('chat-input')).toHaveValue('');
  const roster = (await adminApi<AdminChatState>('GET', '/api/chat')).roster;
  const streamer = roster.find((au) => au.r === 'streamer');
  expect(streamer).toBeDefined();
  expect(roster.filter((au) => au.r === 'streamer')).toHaveLength(1);
  await expect.poll(() => ana.items().some((i) => i.k === 'm' && i.x === 'Hi everyone' && i.a === streamer!.a)).toBe(true);

  // Act
  await mine.getByTestId('chat-more').click();

  // Assert
  await expect(mine.getByTestId('chat-delete')).toBeVisible();
  await expect(mine.getByTestId('chat-mute-10')).toHaveCount(0);

  // Act
  await mine.getByTestId('chat-more').click();
  await anaRow.getByTestId('chat-more').click();
  await anaRow.getByTestId('chat-delete').click();

  // Assert
  await expect(row(live, 'hello from ana')).toHaveCount(0);
  await expect.poll(() => ana.items().some((i) => i.k === 'd' && i.s.includes(sent.s!))).toBe(true);
});

for (const [name, size] of [
  ['the desktop window', APP_WINDOW],
  ['a narrow window', NARROW_WINDOW],
] as const) {
  test(`while live, the chat is on screen without scrolling in ${name}; Settings goes to the Chat card`, { tag: '@ui' }, async ({ page }) => {
    // Arrange
    await page.setViewportSize(size);
    const { live, card } = await openChat(page);
    await admin('/api/chat/send', { text: 'on screen right away' });

    // Assert
    await expect(row(live, 'on screen right away')).toBeInViewport();
    await expect(live.getByTestId('chat-input')).toBeInViewport();
    await expect(live.getByTestId('chat-send')).toBeInViewport();
    await expect(live.getByTestId('chat-protect-slow')).toBeInViewport();
    expect(await page.evaluate(() => scrollY)).toBe(0);
    await expect(card.getByTestId('chat-enabled')).not.toBeInViewport();

    // Act
    await live.getByTestId('chat-settings-link').click();

    // Assert
    await expect(card.getByTestId('chat-enabled')).toBeInViewport();
  });
}

test("a viewer who joins after the streamer was first announced still gets the streamer's roster entry (badge)", { tag: '@ui' }, async ({ bots, chat }) => {
  // Arrange
  await admin('/api/chat/send', { text: 'announced before the viewer joins' });
  await chat.clear();
  const fay = await bots.join(uid('fay'));

  // Act
  await admin('/api/chat/send', { text: 'after the clear' });

  // Assert
  await expect.poll(() => fay.items().some((i) => i.k === 'm' && i.x === 'after the clear')).toBe(true);
  const msg = fay.items().find((i) => i.k === 'm' && i.x === 'after the clear');
  const hello = fay.messages.find((m): m is Extract<ServerMessage, { t: 'hello' }> => m.t === 'hello')!;
  const known = [...(hello.chat?.roster ?? []), ...fay.items().flatMap((i) => (i.k === 'u' ? [i.au] : []))];
  expect(known.find((au) => msg?.k === 'm' && au.a === msg.a)?.r).toBe('streamer');
});

test('mute tells the viewer until when and refuses their messages; unmute and "until the stream ends" from the viewers table', { tag: '@ui' }, async ({ page, bots }) => {
  // Arrange
  const { live } = await openChat(page);
  const bia = await bots.join(uid('bia'));
  await panelShows(page, bia.nickname);
  await bia.answer(bia.send('first message'));
  const biaRow = row(live, 'first message');
  const viewerRow = page.getByTestId(`viewer-${bia.nickname}`);

  // Act
  await biaRow.getByTestId('chat-more').click();
  await biaRow.getByTestId('chat-mute-10').click();

  // Assert
  await expect.poll(() => bia.you()?.mutedUntil).toEqual(expect.any(Number));
  expect((bia.you()!.mutedUntil as number) - Date.now()).toBeGreaterThan(9 * 60_000);
  expect(await bia.refused('am I muted?')).toBe('chat.err.muted');
  await expect(viewerRow.getByTestId('viewer-muted')).toBeVisible();

  // Act
  await viewerRow.getByTestId('viewer-unmute').click();

  // Assert
  await expect.poll(() => bia.you()?.mutedUntil).toBeNull();
  expect((await bia.answer(bia.send('back again'))).s).toBeGreaterThan(0);
  await expect(viewerRow.getByTestId('viewer-muted')).toHaveCount(0);

  // Act
  await viewerRow.getByTestId('viewer-mute').selectOption({ label: translate('en', 'admin.chat.mute.live') });

  // Assert
  await expect.poll(() => bia.you()?.mutedUntil).toBe('live');
  await expect(viewerRow.getByTestId('viewer-muted')).toHaveText(translate('en', 'admin.chat.mutedLive'));
  expect(await bia.refused('still here')).toBe('chat.err.mutedLive');
});

test('the streamer changes a name colour and locks it; clear empties the chat for everyone', { tag: '@ui' }, async ({ page, bots }) => {
  // Arrange
  const { live } = await openChat(page);
  const caio = await bots.join(uid('caio'));
  await panelShows(page, caio.nickname);
  await caio.answer(caio.send('colour me'));
  const caioRow = row(live, 'colour me');

  // Act
  await caioRow.getByTestId('chat-more').click();
  await caioRow.getByTestId('chat-color-input').fill('#0090ff');
  await caioRow.getByTestId('chat-color-lock').check();
  await caioRow.getByTestId('chat-color-apply').click();

  // Assert
  await expect.poll(() => caio.you()).toMatchObject({ color: '#0090ff', colorLocked: true });
  await expect.poll(() => caio.items().some((i) => i.k === 'u' && i.au.c === '#0090ff')).toBe(true);
  const state = await adminApi<AdminChatState>('GET', '/api/chat');
  expect(state.sessions.find((s) => s.nickname === caio.nickname)).toMatchObject({ color: '#0090ff', colorLocked: true });

  // Act
  await live.getByTestId('chat-clear').click();
  await live.getByTestId('chat-clear-yes').click();

  // Assert
  await expect(live.getByTestId('chat-msg')).toHaveCount(0);
  await expect(live.getByTestId('chat-sys').last()).toHaveText(new RegExp(translate('en', 'chat.sys.cleared').replace('.', '\\.')));
  await expect.poll(() => caio.items().some((i) => i.k === 'clr')).toBe(true);
});

test('modes: emotes only refuses text; text only with a blocked word; the length limit', { tag: '@ui' }, async ({ page, bots }) => {
  // Arrange
  const { live, card } = await openChat(page);
  const dani = await bots.join(uid('dani'));
  const dora = await bots.join(uid('dora'));
  await panelShows(page, dani.nickname);
  await panelShows(page, dora.nickname);

  // Act
  await card.getByTestId('chat-preset-emotes').click();
  await card.getByTestId('chat-save').click();

  // Assert
  await expect(card.getByTestId('chat-save')).toBeDisabled();
  await expect.poll(async () => (await chatSettings()).content).toEqual({ text: false, emotes: true, gifs: false });
  await expect.poll(() => dani.messages.some((m) => m.t === 'chat.settings' && m.settings.content.join() === 'emotes')).toBe(true);
  expect(await dani.refused('words are not emotes')).toBe('chat.err.mode');
  expect((await dani.answer(dani.send('😀🎉'))).s).toBeGreaterThan(0);

  // Act
  await card.getByTestId('chat-preset-text').click();
  await card.getByTestId('chat-blocked').fill('badword\nanother one');
  await card.getByTestId('chat-max-length').fill('20');
  await card.getByTestId('chat-save').click();

  // Assert
  await expect.poll(chatSettings).toMatchObject({ content: { text: true, emotes: false, gifs: false }, blockedWords: ['badword', 'another one'], maxGraphemes: 20 });
  expect(await dora.refused('so BADWORD here')).toBe('chat.err.blocked');
  expect(await dora.refused('x'.repeat(21))).toBe('text.tooLong');
  expect((await dora.answer(dora.send('fine text'))).s).toBeGreaterThan(0);

  // Act
  await live.getByTestId('chat-input').fill('y'.repeat(21));

  // Assert
  await expect(live.getByTestId('chat-send')).toBeDisabled();
  await expect(live.getByTestId('chat-count')).toHaveText('21/20');
});

test('the switch turns the chat off (the live chat goes away) and on; protection can be set and ended by hand', { tag: '@ui' }, async ({ page, bots }) => {
  // Arrange
  const { live, card } = await openChat(page);
  const eli = await bots.join(uid('eli'));
  await panelShows(page, eli.nickname);
  const status = card.getByTestId('chat-status');
  await expect(status).toHaveText(translate('en', 'admin.chat.status.on'));

  // Act
  await card.getByTestId('chat-enabled').uncheck();

  // Assert
  await expect(status).toHaveText(translate('en', 'admin.chat.status.off'));
  await expect(live).toHaveCount(0);
  await expect.poll(async () => (await chatSettings()).enabled).toBe(false);
  expect(await eli.refused('anyone?')).toBe('chat.err.off');

  // Act
  await card.getByTestId('chat-enabled').check();

  // Assert
  await expect(status).toHaveText(translate('en', 'admin.chat.status.on'));
  await expect(live.getByTestId('chat-status')).toHaveText(translate('en', 'admin.chat.status.on'));

  // Act
  await live.getByTestId('chat-protect-lockdown').click();

  // Assert
  await expect(live.getByTestId('chat-status')).toHaveText(translate('en', 'admin.chat.status.lockdown'));
  await expect(status).toHaveText(translate('en', 'admin.chat.status.lockdown'));
  await expect(live.getByTestId('chat-protect-state')).toContainText(translate('en', 'chat.protect.lockdown'));
  await expect(live.getByTestId('chat-protect-state')).toContainText(translate('en', 'chat.protect.reason.manual'));

  // Act
  await live.getByTestId('chat-protect-off').click();

  // Assert
  await expect(live.getByTestId('chat-status')).toHaveText(translate('en', 'admin.chat.status.on'));
  await expect(live.getByTestId('chat-protect-state')).toContainText(translate('en', 'chat.protect.off'));
});

test("GIFs need the streamer's own key, show the privacy text, and the card is translated", { tag: '@ui' }, async ({ page }) => {
  // Arrange
  const { live, card } = await openChat(page, 'pt-BR');
  await card.scrollIntoViewIfNeeded();

  // Assert
  await expect(live.getByRole('heading', { level: 2 })).toContainText(translate('pt-BR', 'admin.chat.live.title'));
  await expect(live.getByTestId('chat-clear')).toHaveText(translate('pt-BR', 'admin.chat.clear'));
  await expect(card.getByRole('heading', { level: 2 })).toContainText(translate('pt-BR', 'admin.chat.title'));
  await expect(card.getByTestId('chat-gif-privacy')).toHaveText(translate('pt-BR', 'admin.chat.gif.privacy'));
  await expect(card.getByTestId('chat-gif-enable')).not.toBeChecked();
  await expect(card.getByTestId('chat-gif-enable')).toBeDisabled();

  // Act
  await card.getByTestId('chat-gif-key').fill('bad key!');

  // Assert
  await expect(card.getByTestId('chat-save')).toBeDisabled();

  // Act
  await card.getByTestId('chat-gif-key').fill('test_key_0123456789');
  await card.getByTestId('chat-gif-enable').check();
  await card.getByTestId('chat-save').click();

  // Assert
  await expect.poll(chatSettings).toMatchObject({ content: { gifs: true }, gif: { provider: 'klipy', key: 'test_key_0123456789' } });
  await expect(card.getByTestId('chat-gif-consent')).toHaveText(translate('pt-BR', 'admin.chat.gif.consent.tip'));
  await expect(card.locator('input[data-testid="chat-gif-consent"]')).toHaveCount(0);
});

const SHOTS = process.env.SWARMCAST_SHOTS_DIR;

/** Screenshots of the live chat for the site, only when asked: SWARMCAST_SHOTS_DIR=<folder> (never in CI). */
test('screenshots of the live chat', { tag: '@ui' }, async ({ viewers, bots }) => {
  // Arrange
  test.skip(!SHOTS, 'set SWARMCAST_SHOTS_DIR to capture the live chat');
  test.skip(test.info().project.name !== 'chromium', 'one engine is enough for the site');
  fs.mkdirSync(SHOTS!, { recursive: true });
  const ana = await bots.join('Ana');
  const bia = await bots.join('Bia');
  await ana.answer(ana.send('boa noite, chat! 😀'));
  await bia.answer(bia.send('Oi! Que jogo é esse? :gg:'));
  await admin('/api/chat/send', { text: 'Bem-vindos! Hoje tem Celeste.' });
  await ana.answer(ana.send('sigam https://example.com (não é clicável)'));
  const biaSession = (await adminApi<AdminChatState>('GET', '/api/chat')).sessions.find((s) => s.nickname === bia.nickname)!.sessionId;
  await admin('/api/chat/mute', { sessionId: biaSession, minutes: 10 });

  for (const lang of ['en', 'pt-BR'] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      // Arrange
      const page = await (await viewers.browserContext({ context: { viewport: { width: 1280, height: 900 }, colorScheme: scheme } })).newPage();
      const { live } = await openChat(page, lang);
      await expect(live.getByTestId('chat-msg')).toHaveCount(4);

      // Act
      await live.screenshot({ path: path.join(SHOTS!, `chat-card-${lang}-${scheme}.png`) });
      await row(live, 'Que jogo').getByTestId('chat-more').click();
      await row(live, 'Que jogo').screenshot({ path: path.join(SHOTS!, `chat-menu-${lang}-${scheme}.png`) });
      await page.getByTestId('viewers').screenshot({ path: path.join(SHOTS!, `chat-viewers-${lang}-${scheme}.png`) });
    }
  }
});
