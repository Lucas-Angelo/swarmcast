import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { solveChallenge, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/web/sha';
import WebSocket from 'ws';
import { defaultChatSettings, type AdminChatState, type ChatItem, type ChatSettings, type ServerMessage } from '@swarmcast/shared';
import { translate } from '@swarmcast/shared/i18n';
import { adminApi, expect, liveLink, serverEnv, test, uid } from './fixtures.js';

/**
 * The panel's Chat card against the real server (plan chat-0.4.0 §10.3, chat-moderation.spec):
 * the streamer's badge, delete, mute (the viewer is told until when), unmute, clear, colour
 * with a lock, the modes (emotes only refuses text), blocked words, links never clickable,
 * the on/off switch, protection and the length limit. Viewers are scripted /control clients
 * (a real join, a real session, real chat frames), so the spec does not depend on the viewer
 * page's chat UI.
 */

// ---------------------------------------------------------------------------------------------
// A scripted viewer
// ---------------------------------------------------------------------------------------------

class Jar {
  private cookies = new Map<string, string>();
  constructor(private readonly base: string) {}
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async fetch(p: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(new URL(p, this.base), { ...init, redirect: 'manual', headers: { ...(init.headers as Record<string, string>), cookie: this.header() } });
    for (const sc of res.headers.getSetCookie()) {
      const pair = sc.split(';')[0]!;
      const eq = pair.indexOf('=');
      const v = pair.slice(eq + 1).trim();
      if (v) this.cookies.set(pair.slice(0, eq).trim(), v);
      else this.cookies.delete(pair.slice(0, eq).trim());
    }
    return res;
  }
}

interface Viewer {
  nickname: string;
  messages: ServerMessage[];
  items: () => ChatItem[];
  send: (text: string) => number;
  close: () => void;
  lastRejectAt?: number;
}

const sockets: WebSocket[] = [];
test.afterEach(() => {
  for (const ws of sockets.splice(0)) ws.terminate();
});

let nonce = 0;

/** Join with the live link (solving the browser check like the join page) and open /control. */
async function chatViewer(prefix: string, exact = false): Promise<Viewer> {
  const nickname = exact ? prefix : uid(prefix);
  const link = await liveLink();
  const base = new URL(link).origin;
  const jar = new Jar(base);
  expect((await jar.fetch(link)).status).toBe(303);
  const ch = (await (await jar.fetch('/api/join/challenge')).json()) as { required: boolean; challenge?: Challenge };
  const pow = ch.required ? { challenge: ch.challenge!, solution: await solveChallenge({ challenge: ch.challenge!, deriveKey }) } : undefined;
  const join = await jar.fetch('/api/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pow ? { nickname, pow } : { nickname }) });
  expect(join.status, await join.clone().text()).toBe(200);
  const ws = new WebSocket(`${base.replace('http', 'ws')}/control`, { origin: base, headers: { cookie: jar.header() } });
  sockets.push(ws);
  const messages: ServerMessage[] = [];
  ws.on('message', (d) => {
    const text = String(d);
    if (!text.startsWith('~')) messages.push(JSON.parse(text) as ServerMessage);
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  await expect.poll(() => messages.some((m) => m.t === 'hello')).toBe(true);
  return {
    nickname,
    messages,
    items: () => messages.flatMap((m) => (m.t === 'chat.batch' || m.t === 'chat.reset' ? m.items : [])),
    send: (text) => {
      const n = ++nonce;
      // `t` first: the server's cheap pre-parse check expects it.
      ws.send(JSON.stringify({ t: 'chat.send', n, text }));
      return n;
    },
    close: () => ws.terminate(),
  };
}

/** The server's answer to a nonce: the ack's seq, or the reject code. */
async function answer(v: Viewer, n: number): Promise<{ s?: number; code?: string }> {
  let found: { s?: number; code?: string } | undefined;
  await expect
    .poll(() => {
      for (const m of v.messages) {
        if (m.t === 'chat.ack' && m.n === n) found = { s: m.s };
        if (m.t === 'chat.reject' && m.n === n) found = { code: m.code };
      }
      return found !== undefined;
    }, { message: `answer to nonce ${n}; last messages: ${JSON.stringify(v.messages.slice(-6))}` })
    .toBe(true);
  return found!;
}

/**
 * Send a message the server must refuse, and return the code. The server answers at most two
 * refusals per second per socket (REJECTS_PER_S in chat/hub.ts: a flooding script gets silence),
 * so refusals are spaced like a person typing, never sent back to back.
 */
async function refused(v: Viewer, text: string): Promise<string | undefined> {
  const since = Date.now() - (v.lastRejectAt ?? 0);
  if (since < 1000) await new Promise((r) => setTimeout(r, 1000 - since));
  const a = await answer(v, v.send(text));
  v.lastRejectAt = Date.now();
  return a.code;
}

const lastYou =(v: Viewer) => v.messages.filter((m): m is Extract<ServerMessage, { t: 'chat.you' }> => m.t === 'chat.you').at(-1)?.you;

// ---------------------------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------------------------

/** Every test starts from the default chat (except slow mode and repeats, so scripted viewers can talk fast), empty and calm. */
const baseSettings = (): ChatSettings => ({ ...defaultChatSettings(), slowModeS: 0, duplicateWindowS: 0 });

test.beforeEach(async () => {
  await adminApi('PUT', '/api/chat/settings', baseSettings());
  await adminApi('POST', '/api/chat/protect', { mode: 'off' });
  await adminApi('POST', '/api/chat/clear', {});
});

// Leave the chat as the next spec expects it: default settings, calm, empty.
test.afterEach(async () => {
  await adminApi('PUT', '/api/chat/settings', defaultChatSettings());
  await adminApi('POST', '/api/chat/protect', { mode: 'off' });
  await adminApi('POST', '/api/chat/clear', {});
});

async function openPanel(page: Page, lang?: string): Promise<Locator> {
  const url = serverEnv().adminLoginUrl;
  const origin = new URL(url).origin;
  await page.goto(url);
  await expect(page).toHaveURL(`${origin}/`);
  await expect(page.getByTestId('status')).toBeVisible();
  if (lang) {
    await page.goto(`${origin}/?lang=${lang}`);
    await expect(page.getByTestId('status')).toBeVisible();
  }
  const card = page.getByTestId('chat-card');
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByTestId('chat-settings')).toBeVisible();
  return card;
}

const row = (card: Locator, text: string) => card.getByTestId('chat-msg').filter({ hasText: text });

test('the streamer posts with a badge from the role; links are never clickable; delete removes a message for everyone', { tag: '@ui' }, async ({ page }) => {
  const card = await openPanel(page);
  const ana = await chatViewer('ana');
  const sent = await answer(ana, ana.send('hello from ana https://evil.example/x'));
  expect(sent.s).toBeGreaterThan(0);

  const anaRow = row(card, 'hello from ana');
  await expect(anaRow).toBeVisible();
  await expect(anaRow).toContainText(ana.nickname);
  await expect(anaRow.getByTestId('chat-badge')).toHaveCount(0);
  // The URL is plain text: no link anywhere in the feed.
  await expect(card.getByTestId('chat-feed').locator('a')).toHaveCount(0);

  // The streamer's message: the badge is there, and viewers get the role from the server.
  await card.getByTestId('chat-input').fill('Hi everyone');
  await card.getByTestId('chat-send').click();
  const mine = row(card, 'Hi everyone');
  await expect(mine.getByTestId('chat-badge')).toHaveText(translate('en', 'chat.badge.streamer'));
  await expect(card.getByTestId('chat-input')).toHaveValue('');
  // The role is the server's: the author of that message is the streamer in the server's roster.
  const roster = (await adminApi<AdminChatState>('GET', '/api/chat')).roster;
  const streamer = roster.find((au) => au.r === 'streamer');
  expect(streamer).toBeDefined();
  expect(roster.filter((au) => au.r === 'streamer')).toHaveLength(1);
  await expect.poll(() => ana.items().some((i) => i.k === 'm' && i.x === 'Hi everyone' && i.a === streamer!.a)).toBe(true);
  // The streamer's own messages have no mute or colour actions.
  await mine.getByTestId('chat-more').click();
  await expect(mine.getByTestId('chat-delete')).toBeVisible();
  await expect(mine.getByTestId('chat-mute-10')).toHaveCount(0);
  await mine.getByTestId('chat-more').click();

  // Delete Ana's message: gone in the panel, and the viewer gets the delete.
  await anaRow.getByTestId('chat-more').click();
  await anaRow.getByTestId('chat-delete').click();
  await expect(row(card, 'hello from ana')).toHaveCount(0);
  await expect.poll(() => ana.items().some((i) => i.k === 'd' && i.s.includes(sent.s!))).toBe(true);
});

test('a viewer who joins after the streamer was first announced still gets the streamer\'s roster entry (badge)', { tag: '@ui' }, async () => {
  // An author's roster entry ('u') goes out once per live; a viewer whose join history does not
  // hold the streamer's earlier lines (here: after a clear) must still learn who the streamer
  // is, from the roster in their join snapshot (apps/server/src/chat/hub.ts rosterFor).
  await adminApi('POST', '/api/chat/send', { text: 'announced before the viewer joins' });
  await adminApi('POST', '/api/chat/clear', {});
  const fay = await chatViewer('fay');
  await adminApi('POST', '/api/chat/send', { text: 'after the clear' });
  await expect.poll(() => fay.items().some((i) => i.k === 'm' && i.x === 'after the clear')).toBe(true);
  const msg = fay.items().find((i) => i.k === 'm' && i.x === 'after the clear');
  const hello = fay.messages.find((m): m is Extract<ServerMessage, { t: 'hello' }> => m.t === 'hello')!;
  const known = [...(hello.chat?.roster ?? []), ...fay.items().flatMap((i) => (i.k === 'u' ? [i.au] : []))];
  expect(known.find((au) => msg?.k === 'm' && au.a === msg.a)?.r).toBe('streamer');
});

test('mute tells the viewer until when and refuses their messages; unmute and "until the stream ends" from the viewers table', { tag: '@ui' }, async ({ page }) => {
  const card = await openPanel(page);
  const bia = await chatViewer('bia');
  await answer(bia, bia.send('first message'));
  const biaRow = row(card, 'first message');
  await biaRow.getByTestId('chat-more').click();
  await biaRow.getByTestId('chat-mute-10').click();

  await expect.poll(() => lastYou(bia)?.mutedUntil).toEqual(expect.any(Number));
  const until = lastYou(bia)!.mutedUntil as number;
  expect(until - Date.now()).toBeGreaterThan(9 * 60_000);
  expect(await refused(bia, 'am I muted?')).toBe('chat.err.muted');

  // The viewers table shows the mute and offers Unmute.
  const viewerRow = page.getByTestId(`viewer-${bia.nickname}`);
  await expect(viewerRow.getByTestId('viewer-muted')).toBeVisible();
  await viewerRow.getByTestId('viewer-unmute').click();
  await expect.poll(() => lastYou(bia)?.mutedUntil).toBeNull();
  expect((await answer(bia, bia.send('back again'))).s).toBeGreaterThan(0);
  await expect(viewerRow.getByTestId('viewer-muted')).toHaveCount(0);

  // Until the stream ends, from the table's menu.
  await viewerRow.getByTestId('viewer-mute').selectOption({ label: translate('en', 'admin.chat.mute.live') });
  await expect.poll(() => lastYou(bia)?.mutedUntil).toBe('live');
  await expect(viewerRow.getByTestId('viewer-muted')).toHaveText(translate('en', 'admin.chat.mutedLive'));
  expect(await refused(bia, 'still here')).toBe('chat.err.mutedLive');
});

test('the streamer changes a name colour and locks it; clear empties the chat for everyone', { tag: '@ui' }, async ({ page }) => {
  const card = await openPanel(page);
  const caio = await chatViewer('caio');
  await answer(caio, caio.send('colour me'));
  const caioRow = row(card, 'colour me');
  await caioRow.getByTestId('chat-more').click();
  // A native colour input: set it like the picker does.
  await caioRow.getByTestId('chat-color-input').evaluate((el: HTMLInputElement) => {
    el.value = '#0090ff';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await caioRow.getByTestId('chat-color-lock').check();
  await caioRow.getByTestId('chat-color-apply').click();
  await expect.poll(() => lastYou(caio)).toMatchObject({ color: '#0090ff', colorLocked: true });
  await expect.poll(() => caio.items().some((i) => i.k === 'u' && i.au.c === '#0090ff')).toBe(true);
  // A locked colour cannot be changed by the viewer.
  const state = await adminApi<AdminChatState>('GET', '/api/chat');
  expect(state.sessions.find((s) => s.nickname === caio.nickname)).toMatchObject({ color: '#0090ff', colorLocked: true });

  await card.getByTestId('chat-clear').click();
  await card.getByTestId('chat-clear-yes').click();
  await expect(card.getByTestId('chat-msg')).toHaveCount(0);
  await expect(card.getByTestId('chat-sys').last()).toHaveText(new RegExp(translate('en', 'chat.sys.cleared').replace('.', '\\.')));
  await expect.poll(() => caio.items().some((i) => i.k === 'clr')).toBe(true);
});

test('modes: emotes only refuses text; text only with a blocked word; the length limit', { tag: '@ui' }, async ({ page }) => {
  const card = await openPanel(page);
  const dani = await chatViewer('dani');

  await card.getByTestId('chat-preset-emotes').click();
  await card.getByTestId('chat-save').click();
  await expect(card.getByTestId('chat-save')).toBeDisabled();
  await expect.poll(async () => (await adminApi<AdminChatState>('GET', '/api/chat')).settings.content).toEqual({ text: false, emotes: true, gifs: false });
  await expect.poll(() => dani.messages.some((m) => m.t === 'chat.settings' && m.settings.content.join() === 'emotes')).toBe(true);
  expect(await refused(dani, 'words are not emotes')).toBe('chat.err.mode');
  expect((await answer(dani, dani.send('😀🎉'))).s).toBeGreaterThan(0);

  await card.getByTestId('chat-preset-text').click();
  await card.getByTestId('chat-blocked').fill('badword\nanother one');
  await card.getByTestId('chat-max-length').fill('20');
  await card.getByTestId('chat-save').click();
  await expect.poll(async () => (await adminApi<AdminChatState>('GET', '/api/chat')).settings).toMatchObject({
    content: { text: true, emotes: false, gifs: false },
    blockedWords: ['badword', 'another one'],
    maxGraphemes: 20,
  });
  expect(await refused(dani, 'so BADWORD here')).toBe('chat.err.blocked');
  expect(await refused(dani, 'x'.repeat(21))).toBe('text.tooLong');
  expect((await answer(dani, dani.send('fine text'))).s).toBeGreaterThan(0);
  // The panel's own box counts against the same limit.
  await card.getByTestId('chat-input').fill('y'.repeat(21));
  await expect(card.getByTestId('chat-send')).toBeDisabled();
  await expect(card.getByTestId('chat-count')).toHaveText('21/20');
});

test('the switch turns the chat off and on; protection can be set and ended by hand', { tag: '@ui' }, async ({ page }) => {
  const card = await openPanel(page);
  const eli = await chatViewer('eli');
  await expect(card.getByTestId('chat-status')).toHaveText(translate('en', 'admin.chat.status.on'));

  await card.getByTestId('chat-enabled').uncheck();
  await expect(card.getByTestId('chat-status')).toHaveText(translate('en', 'admin.chat.status.off'));
  await expect.poll(async () => (await adminApi<AdminChatState>('GET', '/api/chat')).settings.enabled).toBe(false);
  expect(await refused(eli, 'anyone?')).toBe('chat.err.off');
  await card.getByTestId('chat-enabled').check();
  await expect(card.getByTestId('chat-status')).toHaveText(translate('en', 'admin.chat.status.on'));

  await card.getByTestId('chat-protect-lockdown').click();
  await expect(card.getByTestId('chat-status')).toHaveText(translate('en', 'admin.chat.status.lockdown'));
  await expect(card.getByTestId('chat-protect-state')).toContainText(translate('en', 'chat.protect.lockdown'));
  await expect(card.getByTestId('chat-protect-state')).toContainText(translate('en', 'chat.protect.reason.manual'));
  await card.getByTestId('chat-protect-off').click();
  await expect(card.getByTestId('chat-status')).toHaveText(translate('en', 'admin.chat.status.on'));
  await expect(card.getByTestId('chat-protect-state')).toContainText(translate('en', 'chat.protect.off'));
});

test('GIFs need the streamer\'s own key, show the privacy text, and the card is translated', { tag: '@ui' }, async ({ page }) => {
  const card = await openPanel(page, 'pt-BR');
  await expect(card.getByRole('heading', { level: 2 })).toContainText(translate('pt-BR', 'admin.chat.title'));
  await expect(card.getByTestId('chat-clear')).toHaveText(translate('pt-BR', 'admin.chat.clear'));
  await expect(card.getByTestId('chat-gif-privacy')).toHaveText(translate('pt-BR', 'admin.chat.gif.privacy'));
  // Off by default, and impossible without a key.
  await expect(card.getByTestId('chat-gif-enable')).not.toBeChecked();
  await expect(card.getByTestId('chat-gif-enable')).toBeDisabled();
  await card.getByTestId('chat-gif-key').fill('bad key!');
  await expect(card.getByTestId('chat-save')).toBeDisabled();
  await card.getByTestId('chat-gif-key').fill('test_key_0123456789');
  await card.getByTestId('chat-gif-enable').check();
  await card.getByTestId('chat-save').click();
  await expect.poll(async () => (await adminApi<AdminChatState>('GET', '/api/chat')).settings).toMatchObject({ content: { gifs: true }, gif: { provider: 'klipy', key: 'test_key_0123456789' } });
  // Consent is always required: the panel offers no switch for it.
  await expect(card.getByTestId('chat-gif-consent')).toHaveText(translate('pt-BR', 'admin.chat.gif.consent.tip'));
  await expect(card.locator('input[data-testid="chat-gif-consent"]')).toHaveCount(0);
});

// ---------------------------------------------------------------------------------------------
// Screenshots for the site (only when asked: SWARMCAST_SHOTS_DIR=<folder>; never in CI)
// ---------------------------------------------------------------------------------------------

const SHOTS = process.env.SWARMCAST_SHOTS_DIR;
test('screenshots of the Chat card', { tag: '@ui' }, async ({ browser }) => {
  test.skip(!SHOTS, 'set SWARMCAST_SHOTS_DIR to capture the Chat card');
  test.skip(test.info().project.name !== 'chromium', 'one engine is enough for the site');
  fs.mkdirSync(SHOTS!, { recursive: true });
  const ana = await chatViewer('Ana', true);
  const bia = await chatViewer('Bia', true);
  await answer(ana, ana.send('boa noite, chat! 😀'));
  await answer(bia, bia.send('Oi! Que jogo é esse? :gg:'));
  await adminApi('POST', '/api/chat/send', { text: 'Bem-vindos! Hoje tem Celeste.' });
  await answer(ana, ana.send('sigam https://example.com (não é clicável)'));
  const state = await adminApi<AdminChatState>('GET', '/api/chat');
  const biaSession = state.sessions.find((s) => s.nickname === bia.nickname)!.sessionId;
  await adminApi('POST', '/api/chat/mute', { sessionId: biaSession, minutes: 10 });
  for (const lang of ['en', 'pt-BR'] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: scheme });
      const page = await ctx.newPage();
      const card = await openPanel(page, lang);
      await expect(card.getByTestId('chat-msg')).toHaveCount(4);
      await card.screenshot({ path: path.join(SHOTS!, `chat-card-${lang}-${scheme}.png`) });
      await row(card, 'Que jogo').getByTestId('chat-more').click();
      await row(card, 'Que jogo').screenshot({ path: path.join(SHOTS!, `chat-menu-${lang}-${scheme}.png`) });
      await page.getByTestId('viewers').screenshot({ path: path.join(SHOTS!, `chat-viewers-${lang}-${scheme}.png`) });
      await ctx.close();
    }
  }
});
