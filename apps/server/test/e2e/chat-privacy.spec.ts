// GIF privacy end to end (chat plan §3.3 and §10.3, chat-privacy.spec.ts @ui): with GIFs off the
// viewer page talks to nobody but its own origin and its CSP has no provider host; with GIFs on,
// still nobody until this viewer agrees, and afterwards only the provider's own media hosts,
// without a referrer. The provider is stubbed with page.route: CI never calls KLIPY.
import type { BrowserContext, Page } from '@playwright/test';
import type { AdminChatState, ChatSettings } from '@swarmcast/shared';
import { GIF_PROVIDERS } from '@swarmcast/shared/chat';
import { adminApi, expect, join, test, uid } from './fixtures.js';

// A 1×1 WebP, what the stubbed media host answers.
const WEBP = Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=', 'base64');
const GIF = { p: 'klipy', id: 'happy-dance', w: 220, h: 220, m: '/ii/935d7ab9d8c6202580a668421940ec81/14/af/SE72470w.webp' } as const;
const KLIPY = GIF_PROVIDERS.klipy;

/** Every request this context makes to another origin (provider calls are stubbed, never real). */
async function watchOutside(context: BrowserContext, origin: string): Promise<Array<{ url: string; referer?: string }>> {
  const seen: Array<{ url: string; referer?: string }> = [];
  await context.route(/^https:\/\/[^/]*klipy\.com\//, (route) => route.fulfill({ status: 200, body: WEBP, headers: { 'content-type': 'image/webp', 'access-control-allow-origin': '*' } }));
  context.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol.startsWith('http') && u.origin !== origin) seen.push({ url: r.url(), referer: r.headers()['referer'] });
  });
  return seen;
}

async function cspOf(page: Page): Promise<string> {
  const res = await page.request.get('/watch');
  return res.headers()['content-security-policy'] ?? '';
}

async function withChat(change: Partial<ChatSettings>, fn: () => Promise<void>): Promise<void> {
  const before = (await adminApi<AdminChatState>('GET', '/api/chat')).settings;
  await adminApi('PUT', '/api/chat/settings', { ...before, ...change });
  try {
    await fn();
  } finally {
    await adminApi('PUT', '/api/chat/settings', before);
  }
}

test('GIFs off: no third-party request and no provider in the CSP', { tag: '@ui' }, async ({ browser, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  let seen: Array<{ url: string }> = [];
  const v = await join(browser, uid('gifoff'), undefined, async (c) => {
    seen = await watchOutside(c, origin);
  });
  try {
    await expect(v.page.getByTestId('chat')).toBeVisible({ timeout: 15_000 });
    await expect(v.page.getByTestId('chat-gif-button')).toBeHidden();
    const csp = await cspOf(v.page);
    expect(csp).not.toContain('klipy');
    expect(csp).not.toContain('giphy');
    await v.page.waitForTimeout(1000);
    expect(seen).toEqual([]);
  } finally {
    await v.context.close();
  }
});

test('GIFs on: nothing reaches KLIPY before this viewer agrees; then only its media hosts, without a referrer', { tag: '@ui' }, async ({ browser, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  await withChat({ content: { text: true, emotes: true, gifs: true }, gif: { provider: 'klipy', key: 'e2e_test_key_123', rating: 'pg', consent: 'ask' } }, async () => {
    let seen: Array<{ url: string; referer?: string }> = [];
    const v = await join(browser, uid('gifon'), undefined, async (c) => {
      seen = await watchOutside(c, origin);
    });
    try {
      await expect(v.page.getByTestId('chat')).toBeVisible({ timeout: 15_000 });
      // The CSP names exactly the provider's hosts while GIFs are on.
      const csp = await cspOf(v.page);
      for (const host of KLIPY.media) expect(csp).toContain(host);
      expect(csp).toContain(KLIPY.api);
      expect(csp).not.toContain('giphy');

      await adminApi('POST', '/api/chat/send', { gif: GIF });
      const placeholder = v.page.getByTestId('chat-list').locator('button.gif-consent').last();
      await expect(placeholder).toBeVisible({ timeout: 5_000 });
      await v.page.waitForTimeout(1000);
      expect(seen, 'requests before consent').toEqual([]);

      // One tap: this viewer agrees; the image comes from KLIPY's media host only.
      await placeholder.click();
      const play = v.page.getByTestId('chat-list').locator('button.gif-play').last();
      if (await play.isVisible().catch(() => false)) await play.click();
      await expect(v.page.getByTestId('chat-list').locator('img.gif-img').last()).toBeVisible({ timeout: 5_000 });
      await expect.poll(() => seen.length).toBeGreaterThan(0);
      for (const r of seen) {
        expect(KLIPY.media.some((h) => r.url.startsWith(`${h}/`)), r.url).toBe(true);
        expect(r.referer, r.url).toBeUndefined();
      }
    } finally {
      await v.context.close();
    }
  });
});
