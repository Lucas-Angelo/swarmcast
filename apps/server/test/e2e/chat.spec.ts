// The viewer chat against the real server (plan §10.3, chat.spec.ts @ui): two viewers both ways
// ("sending…" until the server's copy), slow mode waiting on the client and a server reject
// translated with the text kept (EN and pt-BR), "hide chat" remembered across a reload, a chosen
// name colour that reaches every viewer readable on both themes (set through the CSSOM, under the
// real CSP), the streamer's badge, links never clickable, still one WebSocket per viewer, and
// replies and @mentions between real pages (the quote, the @ list of people who wrote, the mark for
// the mentioned viewer only, the quote wiped when the original is deleted), reactions over the
// video between real pages (a tap floats over the other page's video, under the real CSP), and the
// chat over the video in full screen (another viewer's message over the picture, a message written
// from there).
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

/**
 * Records from now on each state of Send (disabled or not) with the status line beside it; the
 * returned function reads the record. Slow mode holds Send for 2 s from the server's ack on the
 * page's real clock, so a look after the send can come after the hold on a slow runner; the
 * record cannot miss it.
 */
async function recordSend(page: Page): Promise<() => Promise<Array<{ disabled: boolean; status: string }>>> {
  await page.evaluate(() => {
    const w = window as unknown as { __send: Array<{ disabled: boolean; status: string }> };
    const send = document.querySelector<HTMLButtonElement>('[data-testid="chat-send"]')!;
    const status = document.querySelector('[data-testid="chat-status"]')!;
    w.__send = [];
    const note = (): void => {
      const st = { disabled: send.disabled, status: status.textContent ?? '' };
      const last = w.__send.at(-1);
      if (!last || last.disabled !== st.disabled || last.status !== st.status) w.__send.push(st);
    };
    const watch = new MutationObserver(note);
    watch.observe(send, { attributes: true, attributeFilter: ['disabled'] });
    watch.observe(status, { childList: true, characterData: true, subtree: true });
  });
  return () => page.evaluate(() => (window as unknown as { __send: Array<{ disabled: boolean; status: string }> }).__send);
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
    const sendStates = await recordSend(page);
    await say(page, text);

    // Act
    await page.getByTestId('chat-input').fill(text);

    // Assert
    await expect(page.getByTestId('chat-send')).toBeEnabled({ timeout: 5_000 });
    const waited = (await sendStates()).find((st) => st.disabled && (lang === 'en' ? /send again/i : /enviar de novo/i).test(st.status));
    expect(waited, 'Send held while the status says when to send again').toBeDefined();

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

/** The reactions a page drew over its video so far (the chat's own counters, never a racing look at the screen). */
const drawn = (page: Page) => page.evaluate(() => (window as unknown as { __swarmcastChat: { stats: { reactions: { spawned: number } } } }).__swarmcastChat.stats.reactions.spawned);

test("reactions between real pages: a tap floats over the other viewer's video under the real CSP; turned off, the button goes for everyone", { tag: '@ui' }, async ({ viewers, chat }) => {
  // Arrange
  const a = await viewers.join(uid('rxA'));
  const b = await viewers.join(uid('rxB'));
  await chatReady(a.page, b.page);
  const csp: string[] = [];
  b.page.on('console', (m) => {
    if (/Content.Security.Policy/i.test(m.text())) csp.push(m.text());
  });
  const before = await drawn(b.page);

  // Act
  await a.page.getByTestId('chat-react-button').click();
  await a.page.getByTestId('chat-react-option').nth(5).click();

  // Assert
  await expect.poll(() => drawn(b.page), { timeout: 5_000 }).toBeGreaterThan(before);
  expect(await drawn(a.page)).toBeGreaterThan(0);
  await expect(b.page.locator('.player > [data-testid="reactions"]')).toBeAttached();
  expect(csp).toEqual([]);

  // Act
  await chat.change({ reactions: false });

  // Assert
  await expect(a.page.getByTestId('chat-react-button')).toBeHidden({ timeout: 5_000 });
  await expect(b.page.getByTestId('chat-react-button')).toBeHidden({ timeout: 5_000 });
});

test('the chat over the video in full screen: another viewer\'s message shows over the picture, and one written from there reaches them', { tag: '@ui' }, async ({ viewers, chat }) => {
  // Arrange
  await chat.change(FAST_CHAT);
  const a = await viewers.join(uid('ovA'));
  const b = await viewers.join(uid('ovB'));
  await chatReady(a.page, b.page);
  await a.page.getByTestId('settings-open').click();
  await a.page.getByTestId('chat-overlay-setting').check();
  await a.page.getByTestId('settings-close').click();
  await a.page.getByTestId('fullscreen').click();
  await expect.poll(() => a.page.evaluate(() => document.fullscreenElement === document.querySelector('.player'))).toBe(true);
  const fromB = `por cima do vídeo ${uid('b')}`;
  const fromA = `escrevi em tela cheia ${uid('a')}`;

  // Act
  await say(b.page, fromB);

  // Assert
  await expect(a.page.getByTestId('chat-overlay')).toBeVisible();
  await expect(a.page.getByTestId('chat-overlay-lines').locator('.ov-line').filter({ hasText: fromB })).toHaveCount(1, { timeout: 5_000 });

  // Act
  await a.page.getByTestId('chat-overlay-write').click();
  await a.page.getByTestId('chat-overlay-input').getByTestId('chat-input').fill(fromA);
  await a.page.getByTestId('chat-overlay-input').getByTestId('chat-input').press('Enter');

  // Assert
  await sees(b.page, fromA);
  await expect(a.page.getByTestId('chat-overlay-lines').locator('.ov-line').filter({ hasText: fromA })).toHaveCount(1, { timeout: 5_000 });
});
