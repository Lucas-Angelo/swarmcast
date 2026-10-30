// Chat moderation end to end through the panel API (chat plan §10.3): what the streamer does in the
// panel (its chat API, apps/server/src/admin/chat-routes.ts) reaches real viewer pages
// in every engine: delete, clear, mute for a time and until the end of the live, unmute, a colour
// set and locked by the streamer, content presets (text only also refuses emoji), blocked words.
// Every test restores the chat settings it changed: the e2e server is shared by the whole run.
import type { Page } from '@playwright/test';
import type { AdminChatState, ChatMessageItem, ChatSettings } from '@swarmcast/shared';
import { adminApi, expect, join, test, uid } from './fixtures.js';

async function say(page: Page, text: string): Promise<void> {
  const input = page.getByTestId('chat-input');
  await input.fill(text);
  await expect(page.getByTestId('chat-send')).toBeEnabled({ timeout: 10_000 });
  await input.press('Enter');
}

const chatState = (): Promise<AdminChatState> => adminApi<AdminChatState>('GET', '/api/chat');

async function sessionOf(nickname: string): Promise<string> {
  let id: string | undefined;
  await expect
    .poll(async () => {
      id = (await chatState()).sessions.find((s) => s.nickname === nickname)?.sessionId;
      return id;
    })
    .toBeTruthy();
  return id!;
}

async function seqOf(text: string): Promise<number> {
  let seq: number | undefined;
  await expect
    .poll(async () => {
      seq = (await chatState()).items.find((i): i is ChatMessageItem => i.k === 'm' && i.x === text)?.s;
      return seq;
    })
    .toBeTruthy();
  return seq!;
}

/** Applies `change` to the chat settings for the duration of `fn`, then puts them back. */
async function withSettings(change: (s: ChatSettings) => ChatSettings, fn: () => Promise<void>): Promise<void> {
  const before = (await chatState()).settings;
  await adminApi('PUT', '/api/chat/settings', change(structuredClone(before)));
  try {
    await fn();
  } finally {
    await adminApi('PUT', '/api/chat/settings', before);
  }
}

async function chatReady(...pages: Page[]): Promise<void> {
  for (const p of pages) await expect(p.getByTestId('chat')).toBeVisible({ timeout: 15_000 });
}

test('delete one message and clear the chat: gone for everyone', { tag: '@ui' }, async ({ browser }) => {
  const a = await join(browser, uid('delA'));
  const b = await join(browser, uid('delB'));
  try {
    await chatReady(a.page, b.page);
    const gone = `apaga isso ${uid('d')}`;
    const stays = `isso fica ${uid('s')}`;
    await say(a.page, gone);
    await expect(b.page.getByTestId('chat-list').locator('li.msg', { hasText: gone })).toBeVisible({ timeout: 5_000 });
    await say(a.page, stays);
    await expect(b.page.getByTestId('chat-list').locator('li.msg', { hasText: stays })).toBeVisible({ timeout: 5_000 });

    await adminApi('POST', '/api/chat/delete', { seqs: [await seqOf(gone)] });
    for (const p of [a.page, b.page]) {
      await expect(p.getByTestId('chat-list').locator('li.msg', { hasText: gone })).toHaveCount(0, { timeout: 5_000 });
      await expect(p.getByTestId('chat-list').locator('li.msg', { hasText: stays })).toBeVisible();
    }

    await adminApi('POST', '/api/chat/clear', {});
    for (const p of [a.page, b.page]) await expect(p.getByTestId('chat-list').locator('li.msg:not(.sys)')).toHaveCount(0, { timeout: 5_000 });
    // A viewer who joins now gets no history from before the clear.
    const c = await join(browser, uid('delC'));
    try {
      await chatReady(c.page);
      await expect(c.page.getByTestId('chat-list').locator('li.msg', { hasText: stays })).toHaveCount(0);
    } finally {
      await c.context.close();
    }
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test('mute for a time, then unmute; mute until the stream ends', { tag: '@ui' }, async ({ browser }) => {
  const nick = uid('muted');
  const a = await join(browser, nick);
  const b = await join(browser, uid('watcher'));
  try {
    await chatReady(a.page, b.page);
    const sessionId = await sessionOf(nick);
    const status = a.page.getByTestId('chat-status');

    await adminApi('POST', '/api/chat/mute', { sessionId, minutes: 10 });
    await expect(status).toHaveText(/muted until/i, { timeout: 5_000 });
    await expect(a.page.getByTestId('chat-send')).toBeDisabled();

    await adminApi('POST', '/api/chat/unmute', { sessionId });
    const back = `voltei ${uid('u')}`;
    await say(a.page, back);
    await expect(b.page.getByTestId('chat-list').locator('li.msg', { hasText: back })).toBeVisible({ timeout: 5_000 });

    await adminApi('POST', '/api/chat/mute', { sessionId, minutes: null });
    await expect(status).toHaveText('You are muted until the stream ends.', { timeout: 5_000 });
    // A reload (same device) does not lift it.
    await a.page.reload();
    await chatReady(a.page);
    await expect(a.page.getByTestId('chat-status')).toHaveText('You are muted until the stream ends.', { timeout: 10_000 });
    await adminApi('POST', '/api/chat/unmute', { sessionId });
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test('the streamer sets and locks a colour: everyone sees it, the viewer cannot change it', { tag: '@ui' }, async ({ browser }) => {
  const nick = uid('painted');
  const a = await join(browser, nick);
  const b = await join(browser, uid('looker'));
  try {
    await chatReady(a.page, b.page);
    const sessionId = await sessionOf(nick);
    await adminApi('PUT', '/api/chat/color', { sessionId, color: '#e5484d', lock: true });
    await expect.poll(async () => (await chatState()).sessions.find((s) => s.sessionId === sessionId)?.colorLocked).toBe(true);
    const first = `vermelho ${uid('r')}`;
    await say(a.page, first);
    const nickEl = b.page.getByTestId('chat-list').locator('li.msg', { hasText: first }).locator('.nick');
    await expect(nickEl).toBeVisible({ timeout: 5_000 });
    const color = await nickEl.evaluate((el) => getComputedStyle(el).color);

    // The viewer's colour chooser is gone and says why (the server also ignores chat.color
    // while locked: chat-hub.test.ts).
    await a.page.getByTestId('chat-settings-button').click();
    await expect(a.page.getByTestId('chat-settings').getByText('The streamer chose your colour.')).toBeVisible();
    await expect(a.page.getByTestId('chat-settings').locator('button.swatch').first()).toBeHidden();
    await a.page.keyboard.press('Escape');
    await a.page.waitForTimeout(2100); // the slow-mode wait before the next message
    const second = `ainda vermelho ${uid('r2')}`;
    await say(a.page, second);
    const nick2 = b.page.getByTestId('chat-list').locator('li.msg', { hasText: second }).locator('.nick');
    await expect(nick2).toBeVisible({ timeout: 5_000 });
    expect(await nick2.evaluate((el) => getComputedStyle(el).color)).toBe(color);
    expect((await chatState()).sessions.find((s) => s.sessionId === sessionId)?.color).toBe('#e5484d');
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test('content presets: emotes only refuses text, text only refuses emoji', { tag: '@ui' }, async ({ browser }) => {
  const a = await join(browser, uid('modeA'));
  const b = await join(browser, uid('modeB'));
  try {
    await chatReady(a.page, b.page);
    await withSettings(
      (s) => ({ ...s, content: { text: false, emotes: true, gifs: false } }),
      async () => {
        await expect(a.page.getByTestId('chat-mode')).not.toBeEmpty({ timeout: 5_000 });
        const text = `só texto ${uid('t')}`;
        await a.page.getByTestId('chat-input').fill(text);
        await a.page.getByTestId('chat-input').press('Enter');
        await expect(a.page.getByTestId('chat-status')).not.toBeEmpty({ timeout: 5_000 });
        await a.page.waitForTimeout(1000);
        await expect(b.page.getByTestId('chat-list').locator('li.msg', { hasText: text })).toHaveCount(0);
      },
    );
    await a.page.getByTestId('chat-input').fill('');
    await withSettings(
      (s) => ({ ...s, content: { text: true, emotes: false, gifs: false } }),
      async () => {
        const marker = uid('e');
        await a.page.waitForTimeout(2100); // slow mode
        await a.page.getByTestId('chat-input').fill(`oi 😀 ${marker}`);
        await a.page.getByTestId('chat-input').press('Enter');
        await expect(a.page.getByTestId('chat-status')).not.toBeEmpty({ timeout: 5_000 });
        await a.page.waitForTimeout(1000);
        await expect(b.page.getByTestId('chat-list').locator('li.msg', { hasText: marker })).toHaveCount(0);
        // Plain text still goes through.
        await a.page.getByTestId('chat-input').fill('');
        await a.page.waitForTimeout(2100);
        const plain = `sem emoji ${uid('p')}`;
        await say(a.page, plain);
        await expect(b.page.getByTestId('chat-list').locator('li.msg', { hasText: plain })).toBeVisible({ timeout: 5_000 });
      },
    );
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test('blocked words match look-alikes and never reach other viewers', { tag: '@ui' }, async ({ browser }) => {
  const a = await join(browser, uid('blkA'));
  const b = await join(browser, uid('blkB'));
  try {
    await chatReady(a.page, b.page);
    await withSettings(
      (s) => ({ ...s, blockedWords: [...s.blockedWords, 'abacaxi'] }),
      async () => {
        const marker = uid('w');
        // Fullwidth letters and capitals: the comparison key folds them.
        await a.page.getByTestId('chat-input').fill(`ＡＢＡＣＡＸＩ ${marker}`);
        await a.page.getByTestId('chat-input').press('Enter');
        await expect(a.page.getByTestId('chat-status')).toHaveText('This message has a word the streamer blocked.', { timeout: 5_000 });
        await a.page.waitForTimeout(1000);
        await expect(b.page.getByTestId('chat-list').locator('li.msg', { hasText: marker })).toHaveCount(0);
      },
    );
  } finally {
    await a.context.close();
    await b.context.close();
  }
});
