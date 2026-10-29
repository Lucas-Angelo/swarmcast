// The viewer chat against the real server (plan §10.3, chat.spec.ts @ui). The same UI flows run
// without a server in apps/viewer/test/chat/chat-ui.spec.ts (mock hub).
//
// SKELETON until the server chat hub (lane A, C2) lands: on a server without GET /api/chat every
// test is skipped, so this file switches itself on when C2 merges. Panel-side moderation is chat-moderation.spec.ts (C10).
import type { Page } from '@playwright/test';
import { adminApi, expect, join, test, uid } from './fixtures.js';

let hub: boolean | undefined;
/** Does this server have the chat hub (GET /api/chat answers with settings)? Asked once. */
async function hasHub(): Promise<boolean> {
  hub ??= await adminApi<{ settings?: unknown }>('GET', '/api/chat')
    .then((r) => typeof r === 'object' && r !== null && 'settings' in r)
    .catch(() => false);
  return hub;
}

test.beforeEach(async () => {
  test.skip(!(await hasHub()), 'the server has no chat hub yet (lane A, C2)');
});

/** The chat column shows (hello carried a snapshot: chat is on by default). */
async function chatOrSkip(page: Page): Promise<void> {
  await expect(page.getByTestId('chat')).toBeVisible({ timeout: 15_000 });
}

async function say(page: Page, text: string): Promise<void> {
  const input = page.getByTestId('chat-input');
  await expect(page.getByTestId('chat-send')).toBeEnabled({ timeout: 10_000 }).catch(() => {});
  await input.fill(text);
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

test('slow mode rejects are translated and keep the text (EN and pt-BR)', { tag: '@ui' }, async ({ browser }) => {
  for (const lang of ['en', 'pt-BR'] as const) {
    const v = await join(browser, uid(`slow${lang}`));
    try {
      await v.page.goto(`/watch?lang=${lang}`);
      await chatOrSkip(v.page);
      await say(v.page, 'primeira');
      // Bypass the client's own cooldown to reach the server's slow mode.
      await v.page.evaluate(() => {
        const ta = document.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')!;
        ta.value = 'segunda';
        ta.form?.requestSubmit();
      });
      await expect(v.page.getByTestId('chat-status')).not.toHaveText('');
      await expect(v.page.getByTestId('chat-input')).not.toHaveValue('');
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
      await say(a.page, 'cor nova');
      const nick = b.page.getByTestId('chat-list').locator('li.msg', { hasText: 'cor nova' }).locator('.nick');
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
