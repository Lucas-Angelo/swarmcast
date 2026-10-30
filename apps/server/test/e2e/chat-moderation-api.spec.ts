// Chat moderation end to end through the panel API (chat plan §10.3): what the streamer does in
// the panel (its chat API, apps/server/src/admin/chat-routes.ts) reaches real viewer pages in
// every engine: delete, clear (a viewer who joins later gets no history from before it), mute
// for a time and until the end of the live (a reload on the same device does not lift it),
// unmute, a colour set and locked by the streamer (the viewer's colour chooser is gone and says
// why; the server also ignores chat.color while locked: chat-hub.test.ts), content presets
// (text only also refuses emoji), blocked words matched through look-alikes (fullwidth letters
// and capitals: the comparison key folds them). The `chat` fixture puts the settings back.
//
// What a viewer must never see is proven with a marker the streamer posts after it (fixtures.ts
// neverSees): the chat delivers in order, so once the marker shows, the refused text would too.
// A viewer types once its page shows the new content mode (the box's placeholder).
// Slow mode is off where one viewer sends several messages (FAST_CHAT): its client wait and its
// server reject are chat.spec.ts's subject.
import type { ChatMessageItem } from '@swarmcast/shared';
import { translate } from '@swarmcast/shared/i18n';
import { admin, adminApi, chatMessage, chatReady, expect, FAST_CHAT, neverSees, say, sees, test, uid, type ChatControl } from './fixtures.js';

async function sessionOf(chat: ChatControl, nickname: string): Promise<string> {
  let id: string | undefined;
  await expect
    .poll(async () => {
      id = (await chat.state()).sessions.find((s) => s.nickname === nickname)?.sessionId;
      return id;
    })
    .toBeTruthy();
  return id!;
}

async function seqOf(chat: ChatControl, text: string): Promise<number> {
  let seq: number | undefined;
  await expect
    .poll(async () => {
      seq = (await chat.state()).items.find((i): i is ChatMessageItem => i.k === 'm' && i.x === text)?.s;
      return seq;
    })
    .toBeTruthy();
  return seq!;
}

test('delete one message and clear the chat: gone for everyone', { tag: '@ui' }, async ({ viewers, chat }) => {
  // Arrange
  await chat.change(FAST_CHAT);
  const a = await viewers.join(uid('delA'));
  const b = await viewers.join(uid('delB'));
  await chatReady(a.page, b.page);
  const gone = `apaga isso ${uid('d')}`;
  const stays = `isso fica ${uid('s')}`;
  await say(a.page, gone);
  await sees(b.page, gone);
  await say(a.page, stays);
  await sees(b.page, stays);

  // Act
  await admin('/api/chat/delete', { seqs: [await seqOf(chat, gone)] });

  // Assert
  for (const p of [a.page, b.page]) {
    await expect(chatMessage(p, gone)).toHaveCount(0, { timeout: 5_000 });
    await expect(chatMessage(p, stays)).toBeVisible();
  }

  // Act
  await chat.clear();

  // Assert
  for (const p of [a.page, b.page]) await expect(p.getByTestId('chat-list').locator('li.msg:not(.sys)')).toHaveCount(0, { timeout: 5_000 });

  // Act
  const c = await viewers.join(uid('delC'));
  await chatReady(c.page);

  // Assert
  await neverSees(c.page, stays, `depois da limpeza ${uid('m')}`);
});

test('mute for a time, then unmute; mute until the stream ends', { tag: '@ui' }, async ({ viewers, chat }) => {
  // Arrange
  const nick = uid('muted');
  const a = await viewers.join(nick);
  const b = await viewers.join(uid('watcher'));
  await chatReady(a.page, b.page);
  const sessionId = await sessionOf(chat, nick);
  const status = a.page.getByTestId('chat-status');
  const back = `voltei ${uid('u')}`;

  // Act
  await admin('/api/chat/mute', { sessionId, minutes: 10 });

  // Assert
  await expect(status).toHaveText(/muted until/i, { timeout: 5_000 });
  await expect(a.page.getByTestId('chat-send')).toBeDisabled();

  // Act
  await admin('/api/chat/unmute', { sessionId });
  await say(a.page, back);

  // Assert
  await sees(b.page, back);

  // Act
  await admin('/api/chat/mute', { sessionId, minutes: null });

  // Assert
  await expect(status).toHaveText('You are muted until the stream ends.', { timeout: 5_000 });

  // Act
  await a.page.reload();
  await chatReady(a.page);

  // Assert
  await expect(a.page.getByTestId('chat-status')).toHaveText('You are muted until the stream ends.', { timeout: 10_000 });
});

test('the streamer sets and locks a colour: everyone sees it, the viewer cannot change it', { tag: '@ui' }, async ({ viewers, chat }) => {
  // Arrange
  await chat.change(FAST_CHAT);
  const nick = uid('painted');
  const a = await viewers.join(nick);
  const b = await viewers.join(uid('looker'));
  await chatReady(a.page, b.page);
  const sessionId = await sessionOf(chat, nick);
  const first = `vermelho ${uid('r')}`;
  const second = `ainda vermelho ${uid('r2')}`;
  const nickOf = (text: string) => chatMessage(b.page, text).locator('.nick');

  // Act
  await adminApi('PUT', '/api/chat/color', { sessionId, color: '#e5484d', lock: true });

  // Assert
  await expect.poll(async () => (await chat.state()).sessions.find((s) => s.sessionId === sessionId)?.colorLocked).toBe(true);

  // Act
  await say(a.page, first);

  // Assert
  await expect(nickOf(first)).toBeVisible({ timeout: 5_000 });
  const color = await nickOf(first).evaluate((el) => getComputedStyle(el).color);

  // Act
  await a.page.getByTestId('chat-settings-button').click();

  // Assert
  await expect(a.page.getByTestId('chat-settings').getByText('The streamer chose your colour.')).toBeVisible();
  await expect(a.page.getByTestId('chat-settings').locator('button.swatch').first()).toBeHidden();

  // Act
  await a.page.keyboard.press('Escape');
  await say(a.page, second);

  // Assert
  await expect(nickOf(second)).toBeVisible({ timeout: 5_000 });
  expect(await nickOf(second).evaluate((el) => getComputedStyle(el).color)).toBe(color);
  expect((await chat.state()).sessions.find((s) => s.sessionId === sessionId)?.color).toBe('#e5484d');
});

test('content presets: emotes only refuses text, text only refuses emoji', { tag: '@ui' }, async ({ viewers, chat }) => {
  // Arrange
  await chat.change(FAST_CHAT);
  const a = await viewers.join(uid('modeA'));
  const b = await viewers.join(uid('modeB'));
  await chatReady(a.page, b.page);
  const input = a.page.getByTestId('chat-input');
  const status = a.page.getByTestId('chat-status');
  const text = `só texto ${uid('t')}`;
  const emoji = uid('e');
  const plain = `sem emoji ${uid('p')}`;

  // Act
  await chat.change({ content: { text: false, emotes: true, gifs: false } });
  await expect(input).toHaveAttribute('placeholder', translate('en', 'chat.viewer.placeholder.emotes'), { timeout: 5_000 });
  await input.fill(text);
  await input.press('Enter');

  // Assert
  await expect(status).toHaveText(translate('en', 'chat.err.mode', { allowedKey: 'chat.content.e' }), { timeout: 5_000 });
  await neverSees(b.page, text, `só emotes ${uid('m1')}`);

  // Act
  await chat.change({ content: { text: true, emotes: false, gifs: false } });
  await expect(input).toHaveAttribute('placeholder', translate('en', 'chat.viewer.placeholder'), { timeout: 5_000 });
  await input.fill(`oi 😀 ${emoji}`);
  await input.press('Enter');

  // Assert
  await expect(status).toHaveText(translate('en', 'chat.err.mode', { allowedKey: 'chat.content.t' }), { timeout: 5_000 });
  await neverSees(b.page, emoji, `só texto ${uid('m2')}`);

  // Act
  await input.fill('');
  await say(a.page, plain);

  // Assert
  await sees(b.page, plain);
});

test('blocked words match look-alikes and never reach other viewers', { tag: '@ui' }, async ({ viewers, chat }) => {
  // Arrange
  const a = await viewers.join(uid('blkA'));
  const b = await viewers.join(uid('blkB'));
  await chatReady(a.page, b.page);
  const marker = uid('w');

  // Act
  await chat.change((s) => ({ ...s, blockedWords: [...s.blockedWords, 'abacaxi'] }));
  await a.page.getByTestId('chat-input').fill(`ＡＢＡＣＡＸＩ ${marker}`);
  await a.page.getByTestId('chat-input').press('Enter');

  // Assert
  await expect(a.page.getByTestId('chat-status')).toHaveText('This message has a word the streamer blocked.', { timeout: 5_000 });
  await neverSees(b.page, marker, `sem abacaxi ${uid('m')}`);
});
