// GIF privacy end to end (chat plan §3.3 and §10.3, chat-privacy.spec.ts @ui): with GIFs off the
// viewer page talks to nobody but its own origin and its CSP has no provider host; with GIFs on,
// the CSP names exactly the provider's hosts, still nothing reaches KLIPY until this viewer
// agrees (one tap on the placeholder), and afterwards only the provider's own media hosts,
// without a referrer. The provider is stubbed with a route: CI never calls KLIPY.
//
// Every request of the viewer's browser is recorded from its first page on, and checked once the
// page has painted what it shows (fixtures.ts painted()). The GIF test starts from an empty chat,
// so the only GIF placeholder is the one it posts. The suite's browsers allow animation
// (reducedMotion 'no-preference', playwright.config.ts), so a GIF shows as soon as the viewer
// agrees, without a play button.
import type { BrowserContext, Page } from '@playwright/test';
import { GIF_PROVIDERS } from '@swarmcast/shared/chat';
import { admin, chatReady, expect, outsideRequests, painted, test, uid } from './fixtures.js';

/** A 1×1 WebP, what the stubbed media host answers. */
const WEBP = Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=', 'base64');
const GIF = { p: 'klipy', id: 'happy-dance', w: 220, h: 220, m: '/ii/935d7ab9d8c6202580a668421940ec81/14/af/SE72470w.webp' } as const;
const KLIPY = GIF_PROVIDERS.klipy;

/** Stubs every KLIPY host for `context` and records every request it makes to another origin. */
async function recordOutside(context: BrowserContext, origin: string): Promise<Array<{ url: string; referer?: string }>> {
  await context.route(/^https:\/\/[^/]*klipy\.com\//, (route) => route.fulfill({ status: 200, body: WEBP, headers: { 'content-type': 'image/webp', 'access-control-allow-origin': '*' } }));
  return outsideRequests(context, origin);
}

async function cspOf(page: Page): Promise<string> {
  const res = await page.request.get('/watch');
  return res.headers()['content-security-policy'] ?? '';
}

test('GIFs off: no third-party request and no provider in the CSP', { tag: '@ui' }, async ({ viewers, baseURL }) => {
  // Arrange
  const origin = new URL(baseURL!).origin;
  let seen: Array<{ url: string }> = [];

  // Act
  const { page } = await viewers.join(uid('gifoff'), {
    setup: async (c) => {
      seen = await recordOutside(c, origin);
    },
  });
  await chatReady(page);

  // Assert
  await expect(page.getByTestId('chat-gif-button')).toBeHidden();
  const csp = await cspOf(page);
  expect(csp).not.toContain('klipy');
  expect(csp).not.toContain('giphy');
  await painted(page);
  expect(seen).toEqual([]);
});

test('GIFs on: nothing reaches KLIPY before this viewer agrees; then only its media hosts, without a referrer', { tag: '@ui' }, async ({ viewers, chat, baseURL }) => {
  // Arrange
  const origin = new URL(baseURL!).origin;
  await chat.change({ content: { text: true, emotes: true, gifs: true }, gif: { provider: 'klipy', key: 'e2e_test_key_123', rating: 'pg', consent: 'ask' } });
  await chat.clear();
  let seen: Array<{ url: string; referer?: string }> = [];
  const { page } = await viewers.join(uid('gifon'), {
    setup: async (c) => {
      seen = await recordOutside(c, origin);
    },
  });
  await chatReady(page);
  const placeholder = page.getByTestId('chat-list').locator('button.gif-consent').last();

  // Assert
  const csp = await cspOf(page);
  for (const host of KLIPY.media) expect(csp).toContain(host);
  expect(csp).toContain(KLIPY.api);
  expect(csp).not.toContain('giphy');

  // Act
  await admin('/api/chat/send', { gif: GIF });

  // Assert
  await expect(placeholder).toBeVisible({ timeout: 5_000 });
  await painted(page);
  expect(seen, 'requests before consent').toEqual([]);

  // Act
  await placeholder.click();

  // Assert
  await expect(page.getByTestId('chat-list').locator('img.gif-img').last()).toBeVisible({ timeout: 5_000 });
  await expect.poll(() => seen.length).toBeGreaterThan(0);
  for (const r of seen) {
    expect(KLIPY.media.some((h) => r.url.startsWith(`${h}/`)), r.url).toBe(true);
    expect(r.referer, r.url).toBeUndefined();
  }
});
