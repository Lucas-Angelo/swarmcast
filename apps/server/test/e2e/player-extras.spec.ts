// The watch page's keyboard shortcuts and "stats for nerds" on a real live, in every engine (the
// layout of theater mode, the shortcut list, its off switch and typing in the chat box are checked
// against the mock hub in apps/viewer/test/chat/player-extras.spec.ts, phones included). Keys go
// through Playwright's keyboard, so they are trusted key presses like a viewer's: full screen and
// play with sound need that.
import type { Page } from '@playwright/test';
import { chatMessage, chatReady, expect, test, uid, waitPlaying } from './fixtures.js';

const video = (page: Page) =>
  page.evaluate(() => {
    const v = document.querySelector('video')!;
    return { paused: v.paused, muted: v.muted, fullscreen: document.fullscreenElement === v };
  });

/** Gives the focus to the page itself (nothing in particular), as after a click on an empty spot. */
async function focusPage(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(true);
}

test('K pauses and plays the live, M turns the sound on, F puts the video in full screen and takes it out', { tag: '@ui' }, async ({ viewers }) => {
  // Arrange
  const { page } = await viewers.join(uid('keys'));
  await waitPlaying(page);
  await focusPage(page);
  expect(await video(page)).toMatchObject({ paused: false, muted: true });

  // Act
  await page.keyboard.press('k');

  // Assert
  await expect.poll(async () => (await video(page)).paused).toBe(true);
  await expect(page.locator('#status')).toHaveText('Paused');

  // Act
  await page.keyboard.press('k');

  // Assert
  await expect.poll(async () => (await video(page)).paused).toBe(false);
  await waitPlaying(page);

  // Act
  await page.keyboard.press('m');

  // Assert: the sound is on and the "Unmute" button has gone
  await expect.poll(async () => (await video(page)).muted).toBe(false);
  await expect(page.locator('#unmute')).toBeHidden();

  // Act
  await page.keyboard.press('f');

  // Assert
  await expect.poll(async () => (await video(page)).fullscreen).toBe(true);

  // Act
  await page.keyboard.press('f');

  // Assert: out again, still playing
  await expect.poll(async () => (await video(page)).fullscreen).toBe(false);
  await expect.poll(async () => (await video(page)).paused).toBe(false);
});

test('typing "kmft ?s" in the chat box sends that text and no shortcut runs', { tag: '@ui' }, async ({ viewers }) => {
  // Arrange
  const { page, nickname } = await viewers.join(uid('typer'));
  await waitPlaying(page);
  await chatReady(page);
  const input = page.getByTestId('chat-input');
  await input.click();

  // Act
  await page.keyboard.type('kmft ?s');
  await page.keyboard.press('Enter');

  // Assert: the message went out as typed, and the player, the layout and the panels are as they were
  // (The live's chat keeps the rows of earlier tests: this viewer's own row is the one with its name.)
  await expect(chatMessage(page, 'kmft ?s').filter({ hasText: nickname })).not.toHaveClass(/\bpending\b/);
  expect(await video(page)).toEqual({ paused: false, muted: true, fullscreen: false });
  expect(await page.evaluate(() => document.body.classList.contains('theater'))).toBe(false);
  await expect(page.getByTestId('keys-help')).toBeHidden();
  await expect(page.getByTestId('stats')).toBeHidden();
});

test('stats for nerds: off at first, then the numbers of the live, refreshed while open; Esc closes it', { tag: '@ui' }, async ({ viewers, baseURL }) => {
  // Arrange
  const { page } = await viewers.join(uid('nerd'));
  await waitPlaying(page);
  const panel = page.getByTestId('stats');
  await expect(panel).toBeHidden();
  const stat = (id: string) => panel.locator(`[data-stat="${id}"] dd`);

  // Act
  await page.getByTestId('stats-open').click();

  // Assert
  await expect(panel).toBeVisible();
  await expect(stat('resolution')).toHaveText(/^\d{3,4}×\d{3,4}( at \d+ fps)?$/);
  await expect(stat('quality')).toContainText('Auto');
  await expect(stat('buffer')).toHaveText(/^\d+(\.\d)? s$/);
  await expect(stat('delay')).toHaveText(/^\d+(\.\d)? s/);
  await expect(stat('playback')).toHaveText(/^Stable · \d\.\d\d× speed$/);
  await expect(stat('frames')).toHaveText(/^\d+ of [1-9]\d*$/);
  await expect(stat('p2p')).toHaveText('Off');
  await expect(stat('engine')).toHaveText(/^hls\.js · (MediaSource|ManagedMediaSource)$/);
  await expect(stat('fromServer')).toHaveText(/^\d+(\.\d)? MB$/);
  // The numbers move while it is open: the video keeps coming from the streamer.
  const first = await stat('frames').textContent();
  await expect(stat('frames')).not.toHaveText(first!);
  // Nothing that identifies anyone or the live's address.
  const text = (await panel.textContent()) ?? '';
  expect(text).not.toContain(new URL(baseURL!).host);
  expect(text).not.toMatch(/\d+\.\d+\.\d+\.\d+|https?:/);

  // Act
  await page.keyboard.press('Escape');

  // Assert
  await expect(panel).toBeHidden();
  await expect(page.getByTestId('stats-open')).toBeFocused();
  await expect(panel.locator('dl')).toHaveCount(0);
});
