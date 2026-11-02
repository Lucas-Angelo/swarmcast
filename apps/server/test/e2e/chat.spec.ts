// The viewer chat against the real server (plan §10.3, chat.spec.ts @ui): two viewers both ways
// ("sending…" until the server's copy), slow mode waiting on the client and a server reject
// translated with the text kept (EN and pt-BR), "hide chat" remembered across a reload, a chosen
// name colour that reaches every viewer readable on both themes (set through the CSSOM, under the
// real CSP), the streamer's badge, links never clickable, still one WebSocket per viewer, and
// replies and @mentions between real pages (the quote, the @ list of people who wrote, the mark for
// the mentioned viewer only, the quote wiped when the original is deleted).
// The same UI flows run without a server in apps/viewer/test/chat/chat-ui.spec.ts (mock hub);
// panel-side moderation is chat-moderation.spec.ts and chat-moderation-api.spec.ts.
//
// Chat history outlives a test (and the other browsers' runs): every text is unique (uid). Slow
// mode is 2 s by default: after a send, Send waits and says so while the box keeps working.
import type { Page } from '@playwright/test';
import type { ChatMessageItem } from '@swarmcast/shared';
import { admin, adminApi, chatMessage, chatReady, expect, FAST_CHAT, say, sees, test, uid, webSockets } from './fixtures.js';

/** WCAG contrast of a chat nickname against the chat list's background, as the page renders them. */
function nickContrast(page: Page, text: string): Promise<number> {
  return chatMessage(page, text)
    .locator('.nick')
    .evaluate((el) => {
      const ch = (css: string) => (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const lum = (c: number[]) => {
        const [r, g, bl] = c.map((v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
      };
      const fg = lum(ch(getComputedStyle(el).color));
      const bg = lum(ch(getComputedStyle(el.closest('.chat-list')!).backgroundColor));
      return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
    });
}

test('two viewers chat both ways; "sending…" then the server copy', { tag: '@ui' }, async ({ viewers }) => {
  // Arrange
  const a = await viewers.join(uid('chatA'));
  const b = await viewers.join(uid('chatB'));
  await chatReady(a.page, b.page);
  const fromA = `oi do A ${uid('a')}`;
  const fromB = `oi do B ${uid('b')}`;

  // Act
  await say(a.page, `${fromA} :hi:`, fromA);

  // Assert
  const rowA = chatMessage(b.page, fromA);
  await expect(rowA).toBeVisible({ timeout: 5_000 });
  await expect(rowA.locator('img.emote[alt=":hi:"]')).toHaveCount(1);
  await expect(a.page.getByTestId('chat-list').locator('li.pending')).toHaveCount(0);

  // Act
  await say(b.page, fromB);

  // Assert
  await expect(chatMessage(a.page, fromB)).toBeVisible({ timeout: 5_000 });
});

test('slow mode waits on the client; a server reject is translated and keeps the text (EN and pt-BR)', { tag: '@ui' }, async ({ viewers }) => {
  for (const lang of ['en', 'pt-BR'] as const) {
    // Arrange
    const { page } = await viewers.join(uid(`rej${lang}`));
    await page.goto(`/watch?lang=${lang}`);
    await chatReady(page);
    const text = `de novo ${uid('dup')}`;
    await say(page, text);

    // Act
    await page.getByTestId('chat-input').fill(text);

    // Assert
    await expect(page.getByTestId('chat-send')).toBeDisabled();
    await expect(page.getByTestId('chat-status')).toHaveText(lang === 'en' ? /send again/i : /enviar de novo/i);
    await expect(page.getByTestId('chat-send')).toBeEnabled({ timeout: 5_000 });

    // Act
    await page.getByTestId('chat-input').press('Enter');

    // Assert
    await expect(page.getByTestId('chat-status')).toHaveText(lang === 'en' ? 'You just sent that message.' : 'Você acabou de mandar essa mensagem.');
    await expect(page.getByTestId('chat-input')).toHaveValue(text);
    await expect(page.getByTestId('chat-list').locator('li.failed')).toHaveCount(1);
  }
});

test('hide chat is remembered across a reload', { tag: '@ui' }, async ({ viewers }) => {
  // Arrange
  const { page } = await viewers.join(uid('hide'));
  await chatReady(page);

  // Act
  await page.getByTestId('chat-hide').click();
  await page.reload();

  // Assert
  await expect(page.getByTestId('chat-show')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('chat')).toBeHidden();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`a chosen colour reaches every viewer, readable on the ${scheme} theme (CSSOM under the real CSP)`, { tag: '@ui' }, async ({ viewers }) => {
    // Arrange
    const a = await viewers.join(uid('colA'));
    const b = await viewers.join(uid('colB'), { context: { colorScheme: scheme } });
    await chatReady(a.page, b.page);
    const text = `cor nova ${uid('cor')}`;

    // Act
    await a.page.getByTestId('chat-settings-button').click();
    await a.page.getByTestId('chat-settings').locator('button.swatch').nth(2).click();
    await a.page.keyboard.press('Escape');
    await say(a.page, text);

    // Assert
    await expect(chatMessage(b.page, text).locator('.nick')).toBeVisible({ timeout: 5_000 });
    expect(await nickContrast(b.page, text)).toBeGreaterThanOrEqual(4.5);
  });
}

test('a streamer message carries the badge; links are never clickable', { tag: '@ui' }, async ({ viewers }) => {
  // Arrange
  const { page } = await viewers.join(uid('badge'));
  await chatReady(page);
  const text = `bem-vindos ${uid('st')} https://example.com`;

  // Act
  await admin('/api/chat/send', { text });

  // Assert
  await expect(page.getByTestId('chat-list').locator('li.from-streamer', { hasText: text }).locator('.badge')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('chat-list').locator('a')).toHaveCount(0);
});

test('the chat adds no WebSocket: still one socket per viewer', { tag: '@ui' }, async ({ viewers }) => {
  // Arrange
  let sockets: string[] = [];
  const { page } = await viewers.join(uid('onews'), {
    setup: async (context) => {
      sockets = webSockets(context);
    },
  });
  await chatReady(page);

  // Act
  await say(page, `só um socket ${uid('ws')}`);

  // Assert
  expect(new Set(sockets)).toEqual(new Set(['/control']));
});

test('a reply with a mention between real pages: the quote for everyone, the mark for the mentioned viewer only; deleting the original wipes the quote', { tag: '@ui' }, async ({ viewers, chat }) => {
  // Arrange
  await chat.change(FAST_CHAT);
  const a = await viewers.join(uid('repA'));
  const b = await viewers.join(uid('repB'));
  const c = await viewers.join(uid('repC'));
  await chatReady(a.page, b.page, c.page);
  const question = `qual a música? ${uid('q')}`;
  await say(a.page, question);
  await sees(b.page, question);
  await sees(c.page, question);
  const answer = `é a do começo ${uid('r')}`;

  // Act: B replies from the row's Reply button and mentions A from the @ list.
  const asked = chatMessage(b.page, question);
  await asked.hover();
  await asked.getByTestId('chat-reply').click();
  await expect(b.page.getByTestId('chat-replying')).toContainText(a.nickname);
  await b.page.getByTestId('chat-input').pressSequentially(`@${a.nickname.slice(0, 4)}`);
  await expect(b.page.getByTestId('chat-mention-option').filter({ hasText: a.nickname })).toBeVisible();
  await b.page.getByTestId('chat-mention-option').filter({ hasText: a.nickname }).click();
  await expect(b.page.getByTestId('chat-input')).toHaveValue(`@${a.nickname} `);
  await say(b.page, `@${a.nickname} ${answer}`, answer);

  // Assert
  for (const p of [a.page, b.page, c.page]) {
    await sees(p, answer);
    await expect(chatMessage(p, answer).getByTestId('chat-reply-quote')).toContainText(question);
    await expect(chatMessage(p, answer).getByTestId('chat-reply-quote')).toContainText(a.nickname);
    await expect(chatMessage(p, answer).locator('.mention')).toHaveText(`@${a.nickname}`);
  }
  await expect(chatMessage(a.page, answer)).toHaveClass(/mentions-me/);
  await expect(chatMessage(a.page, answer).locator('.mention.me')).toHaveCount(1);
  await expect(chatMessage(b.page, answer)).not.toHaveClass(/mentions-me/);
  await expect(chatMessage(c.page, answer)).not.toHaveClass(/mentions-me/);

  // Act
  const seq = (await adminApi<{ items: ChatMessageItem[] }>('GET', '/api/chat')).items.find((i) => i.k === 'm' && i.x === question)!.s;
  await admin('/api/chat/delete', { seqs: [seq] });

  // Assert
  for (const p of [a.page, b.page, c.page]) {
    await expect(chatMessage(p, question)).toHaveCount(0, { timeout: 5_000 });
    await expect(chatMessage(p, answer).getByTestId('chat-reply-quote')).toContainText('Original message deleted');
  }
  const d = await viewers.join(uid('repD'));
  await chatReady(d.page);
  await expect(chatMessage(d.page, answer).getByTestId('chat-reply-quote')).toContainText('Original message deleted');
  await expect(d.page.getByTestId('chat-list')).not.toContainText(question);
});
