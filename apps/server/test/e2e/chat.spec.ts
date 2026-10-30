// The viewer chat against the real server (plan §10.3, chat.spec.ts @ui): two viewers both ways
// ("sending…" until the server's copy), slow mode waiting on the client and a server reject
// translated with the text kept (EN and pt-BR), "hide chat" remembered across a reload, a chosen
// name colour that reaches every viewer readable on both themes (set through the CSSOM, under the
// real CSP), the streamer's badge, links never clickable, and still one WebSocket per viewer.
// The same UI flows run without a server in apps/viewer/test/chat/chat-ui.spec.ts (mock hub);
// panel-side moderation is chat-moderation.spec.ts and chat-moderation-api.spec.ts.
//
// Chat history outlives a test (and the other browsers' runs): every text is unique (uid). Slow
// mode is 2 s by default: after a send, Send waits and says so while the box keeps working.
import type { Page } from '@playwright/test';
import { admin, chatMessage, chatReady, expect, say, test, uid, webSockets } from './fixtures.js';

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
