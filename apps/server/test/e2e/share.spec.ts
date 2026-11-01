// The watch page's Share button in real browsers (viewer: share.ts; server: GET /api/share; panel:
// "Viewers can share the link"). The button sends the live link: the system share sheet where the
// browser has one, else the clipboard with a visible "Link copied", and the copied link lets a
// friend join. It goes away when the streamer turns sharing off, and, after "Generate new link",
// for everyone who joined with the old link: they keep watching, but never get the new link.
//
// The share sheet and the clipboard need a real click (user activation): the tests press the
// button with the keyboard or the mouse, never by script. The page's clipboard writes are recorded
// by an init script that still calls the browser's own writeText, so "Link copied" means the real
// clipboard took the link. Whether a page has learned what the server allows (hello) is read from
// the chat column, which shows with the same hello.
import type { BrowserContext, Page } from '@playwright/test';
import { admin, adminState, chatReady, expect, liveLink, openPanel, test, uid } from './fixtures.js';

/** The page without a share sheet (as Firefox and Chrome on Linux), its clipboard writes recorded in `__copied`. */
async function clipboardOnly(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const nav = Navigator.prototype as unknown as Record<string, unknown>;
    delete nav.share;
    delete nav.canShare;
    const w = window as unknown as { __copied: string[] };
    w.__copied = [];
    const clip = navigator.clipboard;
    const write = clip.writeText.bind(clip);
    clip.writeText = (text: string) => {
      w.__copied.push(text);
      return write(text);
    };
  });
}

/** The page with a share sheet that records what it was given in `__shared` (no system dialog in a test). */
async function shareSheet(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const w = window as unknown as { __shared: ShareData[] };
    w.__shared = [];
    Object.defineProperty(Navigator.prototype, 'canShare', { configurable: true, value: () => true });
    Object.defineProperty(Navigator.prototype, 'share', {
      configurable: true,
      value: (data: ShareData) => {
        w.__shared.push({ title: data.title, url: data.url });
        return Promise.resolve();
      },
    });
  });
}

const shareButton = (page: Page) => page.getByRole('button', { name: 'Share' });

/** GET /api/share from the page, with its session cookie: the status and the link, if any. */
function askShare(page: Page): Promise<{ status: number; url?: string }> {
  return page.evaluate(async () => {
    const res = await fetch('/api/share', { credentials: 'same-origin' });
    const body = (await res.json()) as { url?: string };
    return { status: res.status, ...(body.url ? { url: body.url } : {}) };
  });
}

test('without a share sheet, Share copies the live link and says so; the copied link lets a friend join', { tag: '@ui' }, async ({ viewers, browserName }) => {
  // Arrange
  const link = await liveLink();
  const { page } = await viewers.join(uid('copy'), {
    setup: async (c) => {
      // Only Chromium knows these permissions; the others allow writeText in a click.
      if (browserName === 'chromium') await c.grantPermissions(['clipboard-read', 'clipboard-write']);
      await clipboardOnly(c);
    },
  });
  const share = shareButton(page);
  await expect(share).toBeVisible();

  // Act: by keyboard (a labelled button in the tab order, pressed with Enter).
  await share.focus();
  await page.keyboard.press('Enter');

  // Assert
  await expect(page.getByTestId('share-status')).toHaveText('Link copied');
  await expect(page.getByTestId('share-field')).toBeHidden();
  const copied = await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
  expect(copied).toEqual([link]);

  // Act
  const friend = await viewers.join(uid('friend'), { link: copied[0]! });

  // Assert
  await expect(friend.page).toHaveURL(/\/watch$/);
});

test('with a share sheet, Share hands it the live link and the title', { tag: '@ui' }, async ({ viewers }) => {
  // Arrange
  const link = await liveLink();
  const { page } = await viewers.join(uid('sheet'), { setup: shareSheet });
  const share = shareButton(page);
  await expect(share).toBeVisible();

  // Act
  await share.click();

  // Assert
  await expect.poll(() => page.evaluate(() => (window as unknown as { __shared: ShareData[] }).__shared)).toEqual([{ title: 'Live · SwarmCast', url: link }]);
  await expect(page.getByTestId('share-status')).toHaveText('');
});

test('"Viewers can share the link" off in the panel removes the button for viewers watching and for new ones', { tag: '@ui' }, async ({ viewers }) => {
  // Arrange
  const watching = (await viewers.join(uid('swoff'))).page;
  await expect(shareButton(watching)).toBeVisible();
  const panel = await (await viewers.browserContext()).newPage();
  await openPanel(panel);
  const form = panel.locator('form', { has: panel.getByTestId('allow-viewer-share') });

  // Act
  await form.getByTestId('allow-viewer-share').uncheck();
  await form.getByRole('button', { name: 'Save' }).click();

  // Assert
  await expect(shareButton(watching)).toBeHidden();
  await expect.poll(async () => (await adminState()).settings.allowViewerShare).toBe(false);
  expect((await askShare(watching)).status).toBe(404);

  // Act
  const late = (await viewers.join(uid('swlate'))).page;
  await chatReady(late);

  // Assert
  await expect(shareButton(late)).toBeHidden();
  expect((await askShare(late)).status).toBe(404);

  // Act
  await form.getByTestId('allow-viewer-share').check();
  await form.getByRole('button', { name: 'Save' }).click();

  // Assert
  await expect(shareButton(watching)).toBeVisible();
  await expect(shareButton(late)).toBeVisible();
});

test('after "Generate new link", viewers of the old link keep watching but lose Share; viewers of the new link share it', { tag: '@ui' }, async ({ viewers }) => {
  // Arrange
  const oldLink = await liveLink();
  const old = (await viewers.join(uid('oldlink'))).page;
  await expect(shareButton(old)).toBeVisible();

  // Act
  await admin('/api/link/rotate');
  const newLink = (await adminState()).liveLink!;

  // Assert
  expect(newLink).not.toBe(oldLink);
  await expect(shareButton(old)).toBeHidden();
  const refused = await askShare(old);
  expect(refused.status).toBe(404);
  expect(JSON.stringify(refused)).not.toContain(new URL(newLink).pathname);
  await expect(old.locator('#ended')).toBeHidden();

  // Act: the old viewer reloads (the session stays; the server still says no).
  await old.reload();
  await chatReady(old);

  // Assert
  await expect(shareButton(old)).toBeHidden();

  // Act
  const fresh = (await viewers.join(uid('newlink'), { link: newLink })).page;

  // Assert
  await expect(shareButton(fresh)).toBeVisible();
  expect(await askShare(fresh)).toEqual({ status: 200, url: newLink });
});
