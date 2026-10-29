// The viewer chat against the real server (plan §10.3, chat.spec.ts @ui). The same UI flows run
// without a server in apps/viewer/test/chat/chat-ui.spec.ts (mock hub).
//
// The streamer test needs the panel's chat routes (C3); it is skipped while GET /api/chat does not
// exist. Panel-side moderation is chat-moderation.spec.ts (C10).
import type { Page } from '@playwright/test';
import { adminApi, expect, join, test, uid } from './fixtures.js';

let routes: boolean | undefined;
/** Does the panel have its chat routes (GET /api/chat answers with settings)? Asked once. */
async function hasChatRoutes(): Promise<boolean> {
  routes ??= await adminApi<{ settings?: unknown }>('GET', '/api/chat')
    .then((r) => typeof r === 'object' && r !== null && 'settings' in r)
    .catch(() => false);
  return routes;
}

/** The chat column shows (hello carried a snapshot: chat is on by default). */
async function chatOrSkip(page: Page): Promise<void> {
  await expect(page.getByTestId('chat')).toBeVisible({ timeout: 15_000 });
}

async function say(page: Page, text: string): Promise<void> {
  const input = page.getByTestId('chat-input');
  await input.fill(text);
  await expect(page.getByTestId('chat-send')).toBeEnabled({ timeout: 10_000 });
  await input.press('Enter');
}

test('two viewers chat both ways; "sending…" then the server copy', { tag: '@ui' }, async ({ browser }) => {
  const a = await join(browser, uid('chatA'));
  const b = await join(browser, uid('chatB'));
  try {
    await chatOrSkip(a.page);
    await chatOrSkip(b.page);
    await say(a.page, 'oi do A :hi:');
    await expect(b.page.getByTestId('chat-list').locator('li.msg', { hasText: 'oi do A' })).toBeVisible({ timeout: 5_000 });
    await expect(b.page.getByTestId('chat-list').locator('li.msg img.emote[alt=":hi:"]')).toHaveCount(1);
    await expect(a.page.getByTestId('chat-list').locator('li.pending')).toHaveCount(0);
    await say(b.page, 'oi do B');
    await expect(a.page.getByTestId('chat-list').locator('li.msg', { hasText: 'oi do B' })).toBeVisible({ timeout: 5_000 });
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test('slow mode waits on the client; a server reject is translated and keeps the text (EN and pt-BR)', { tag: '@ui' }, async ({ browser }) => {
  for (const lang of ['en', 'pt-BR'] as const) {
    const v = await join(browser, uid(`rej${lang}`));
    try {
      await v.page.goto(`/watch?lang=${lang}`);
      await chatOrSkip(v.page);
      const text = `de novo ${uid('dup')}`;
      await say(v.page, text);
      // Slow mode (2 s by default): Send waits and says so, the box keeps working.
      await v.page.getByTestId('chat-input').fill(text);
      await expect(v.page.getByTestId('chat-send')).toBeDisabled();
      await expect(v.page.getByTestId('chat-status')).toHaveText(lang === 'en' ? /send again/i : /enviar de novo/i);
      // The same text again after the wait: the server refuses it as a repeat.
      await expect(v.page.getByTestId('chat-send')).toBeEnabled({ timeout: 5_000 });
      await v.page.getByTestId('chat-input').press('Enter');
      await expect(v.page.getByTestId('chat-status')).toHaveText(lang === 'en' ? 'You just sent that message.' : 'Você acabou de mandar essa mensagem.');
      await expect(v.page.getByTestId('chat-input')).toHaveValue(text);
      await expect(v.page.getByTestId('chat-list').locator('li.failed')).toHaveCount(1);
    } finally {
      await v.context.close();
    }
  }
});

test('hide chat is remembered across a reload', { tag: '@ui' }, async ({ browser }) => {
  const v = await join(browser, uid('hide'));
  try {
    await chatOrSkip(v.page);
    await v.page.getByTestId('chat-hide').click();
    await v.page.reload();
    await expect(v.page.getByTestId('chat-show')).toBeVisible({ timeout: 15_000 });
    await expect(v.page.getByTestId('chat')).toBeHidden();
  } finally {
    await v.context.close();
  }
});

for (const scheme of ['light', 'dark'] as const) {
  test(`a chosen colour reaches every viewer, readable on the ${scheme} theme (CSSOM under the real CSP)`, { tag: '@ui' }, async ({ browser }) => {
    const a = await join(browser, uid('colA'));
    const b = await join(browser, uid('colB'));
    try {
      await b.page.emulateMedia({ colorScheme: scheme });
      await chatOrSkip(a.page);
      await chatOrSkip(b.page);
      await a.page.getByTestId('chat-settings-button').click();
      await a.page.getByTestId('chat-settings').locator('button.swatch').nth(2).click();
      await a.page.keyboard.press('Escape');
      const text = `cor nova ${uid('cor')}`;
      await say(a.page, text);
      const nick = b.page.getByTestId('chat-list').locator('li.msg', { hasText: text }).locator('.nick');
      await expect(nick).toBeVisible({ timeout: 5_000 });
      const ratio = await nick.evaluate((el) => {
        const ch = (css: string) => (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
        const lum = (c: number[]) => {
          const [r, g, bl] = c.map((v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
          return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
        };
        const fg = lum(ch(getComputedStyle(el).color));
        const bg = lum(ch(getComputedStyle(el.closest('.chat-list')!).backgroundColor));
        return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
      });
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });
}

test('a streamer message carries the badge; links are never clickable', { tag: '@ui' }, async ({ browser }) => {
  test.skip(!(await hasChatRoutes()), 'the panel chat routes (C3) are not there yet');
  const v = await join(browser, uid('badge'));
  try {
    await chatOrSkip(v.page);
    await adminApi('POST', '/api/chat/send', { text: 'bem-vindos https://example.com' });
    const row = v.page.getByTestId('chat-list').locator('li.from-streamer', { hasText: 'bem-vindos' });
    await expect(row.locator('.badge')).toBeVisible({ timeout: 5_000 });
    await expect(v.page.getByTestId('chat-list').locator('a')).toHaveCount(0);
  } finally {
    await v.context.close();
  }
});

test('the chat adds no WebSocket: still one socket per viewer', { tag: '@ui' }, async ({ browser }) => {
  const sockets: string[] = [];
  const v = await join(browser, uid('onews'), undefined, async (context) => {
    context.on('page', (p) => p.on('websocket', (ws) => sockets.push(ws.url())));
  });
  try {
    await chatOrSkip(v.page);
    await say(v.page, 'só um socket');
    await v.page.waitForTimeout(1000);
    expect(new Set(sockets.map((u) => new URL(u).pathname))).toEqual(new Set(['/control']));
  } finally {
    await v.context.close();
  }
});
