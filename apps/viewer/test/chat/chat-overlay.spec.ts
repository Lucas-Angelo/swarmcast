// The chat over the video in full screen (docs/CHAT.md "Chat over the video"), against the mock hub,
// in chromium, firefox, webkit (computers: the player container goes full screen) and the phone
// projects for @mobile: off by default, the bar's "Chat on the video" button (only while full screen)
// and the Settings switch (remembered), the latest lines at the bottom left above the controls and
// taking no click, readable on any picture (both themes), the message box moved over the video and
// back (also with C), reactions beside it, hide chat and chat off, Portuguese, reduce motion, and an
// iPhone without element full screen, where the button fills the page instead. How long a line stays
// is checked on a manual clock in apps/viewer/test/unit/chat-overlay.test.ts; nothing here waits on
// a fixed time.
import { expect, test, type Page } from './fixtures.js';
import { MockHub } from './mock-hub.js';
import { openWatch, requireBuild } from './watch-page.js';

test.beforeAll(requireBuild);

const ana = { a: 'k2', n: 'Ana', c: '#3e63dd', r: 'viewer' as const };
const cris = { a: 'k3', n: 'Cris', c: '#46a758', r: 'viewer' as const };
const overlay = (page: Page) => page.getByTestId('chat-overlay');
const lines = (page: Page) => page.getByTestId('chat-overlay-lines').locator('.ov-line');
const button = (page: Page) => page.getByTestId('chat-overlay-button');
const fullscreen = (page: Page): Promise<boolean> => page.evaluate(() => document.fullscreenElement === document.querySelector('.player'));

/** Opens the watch page on a computer-sized window and puts the player in full screen with its button. */
async function openFullscreen(page: Page, hub: MockHub, lang?: 'en' | 'pt-BR'): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openWatch(page, hub, lang ? { lang } : {});
  await page.getByTestId('fullscreen').click();
  await expect.poll(() => fullscreen(page)).toBe(true);
}

/** Top, bottom, left and right of an element on screen. */
async function box(page: Page, testid: string) {
  const b = (await page.getByTestId(testid).boundingBox())!;
  return { top: b.y, bottom: b.y + b.height, left: b.x, right: b.x + b.width, width: b.width };
}

test.describe('the chat over the video in full screen (mock hub)', () => {
  test('off by default; the bar\'s "Chat on the video" button, only in full screen, turns it on: the latest lines at the bottom left, above the controls, taking no click; remembered after a reload', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia');
    await page.setViewportSize({ width: 1280, height: 800 });
    await openWatch(page, hub);
    // Said while the page is open: a line's time over the video starts when it comes (a snapshot's
    // lines only show for what is left of it: the unit test checks that on a manual clock).
    hub.say(ana, 'boa noite :hi:');

    // Assert: not in full screen, no button.
    await expect(button(page)).toBeHidden();

    // Act
    await page.getByTestId('fullscreen').click();
    await expect.poll(() => fullscreen(page)).toBe(true);

    // Assert: off by default.
    await expect(button(page)).toBeVisible();
    await expect(button(page)).toHaveAccessibleName('Chat on the video');
    await expect(button(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(overlay(page)).toBeHidden();

    // Act
    await button(page).click();
    hub.say(cris, 'que jogada!');

    // Assert
    await expect(button(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(overlay(page)).toBeVisible();
    await expect(lines(page)).toHaveText([/Ana: boa noite/, /Cris: que jogada!/]);
    await expect(lines(page).first().locator('img.emote')).toHaveCount(1);
    const ov = await box(page, 'chat-overlay');
    const bar = await box(page, 'controls');
    const player = (await page.locator('.player').boundingBox())!;
    expect(ov.bottom).toBeLessThanOrEqual(bar.top + 1);
    expect(ov.left - player.x).toBeLessThan(player.width / 4);
    expect(ov.right - player.x).toBeLessThanOrEqual(player.width / 2);
    const hit = await lines(page)
      .first()
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { self: at === el || el.contains(at), events: getComputedStyle(el).pointerEvents };
      });
    expect(hit).toEqual({ self: false, events: 'none' });
    await expect(lines(page).first()).toHaveAttribute('class', /ov-line/);
    expect(await page.getByTestId('chat-overlay-lines').getAttribute('aria-hidden')).toBe('true');

    // Act: leave full screen.
    await page.getByTestId('fullscreen').click();
    await expect.poll(() => fullscreen(page)).toBe(false);

    // Assert
    await expect(overlay(page)).toBeHidden();
    await expect(button(page)).toBeHidden();

    // Act: a reload remembers the choice.
    await page.reload();
    await expect(page.getByTestId('chat')).toBeVisible();
    hub.say(ana, 'de volta');
    await expect(page.getByTestId('chat-list').locator('li.msg').last()).toContainText('de volta');
    await page.getByTestId('fullscreen').click();
    await expect.poll(() => fullscreen(page)).toBe(true);

    // Assert
    await expect(button(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(lines(page).last()).toContainText('Ana: de volta');
  });

  test('the Settings menu has the same switch, shown once the live has a chat', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia');
    await page.setViewportSize({ width: 1280, height: 800 });
    await openWatch(page, hub);
    await page.getByTestId('settings-open').click();
    const setting = page.getByTestId('chat-overlay-setting');

    // Act
    await setting.check();
    await page.getByTestId('settings-close').click();
    await page.getByTestId('fullscreen').click();
    await expect.poll(() => fullscreen(page)).toBe(true);
    hub.say(ana, 'oi do menu');

    // Assert
    await expect(page.locator('#chat-overlay-row')).toContainText('Chat on the video in full screen');
    await expect(button(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(lines(page).last()).toContainText('oi do menu');
  });

  test('the small button opens the chat\'s own message box over the video: a message goes from there, React works there; closing it puts the box back in the chat', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia', { settings: { reactions: true } });
    await openFullscreen(page, hub);
    await button(page).click();
    const write = page.getByTestId('chat-overlay-write');

    // Act
    await write.click();

    // Assert
    await expect(write).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('chat-overlay-input').getByTestId('chat-input')).toBeFocused();
    await expect(page.getByTestId('chat-overlay-input').getByTestId('chat-send')).toBeVisible();

    // Act
    await page.keyboard.type('mandei da tela cheia');
    await page.keyboard.press('Enter');

    // Assert
    await expect.poll(() => hub.framesOf('chat.send').map((f) => f.text)).toEqual(['mandei da tela cheia']);
    await expect(lines(page).last()).toContainText('Bia: mandei da tela cheia');

    // Act: React from the box over the video.
    await page.getByTestId('chat-overlay-input').getByTestId('chat-react-button').click();
    await page.getByTestId('chat-react').getByTestId('chat-react-option').nth(5).click();

    // Assert
    await expect(page.getByTestId('chat-react')).toBeVisible();
    await expect.poll(() => hub.framesOf('chat.react')).toEqual([{ t: 'chat.react', c: [0, 0, 0, 0, 0, 1] }]);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __swarmcastChat: { stats: { reactions: { spawned: number } } } }).__swarmcastChat.stats.reactions.spawned)).toBeGreaterThan(0);

    // Act
    // Not Escape: in full screen it is the browser's (WebKit leaves full screen with it).
    await page.getByTestId('chat-overlay-input').getByTestId('chat-react-button').click();
    await write.click();

    // Assert
    await expect(write).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('chat-overlay-input')).toBeHidden();
    expect(await page.getByTestId('chat-input').evaluate((el) => !!el.closest('#chat'))).toBe(true);

    // Act: open it again, then leave full screen: the box goes back by itself.
    await write.click();
    await page.getByTestId('fullscreen').click();
    await expect.poll(() => fullscreen(page)).toBe(false);

    // Assert
    expect(await page.getByTestId('chat-input').evaluate((el) => !!el.closest('#chat'))).toBe(true);
    await expect(page.getByTestId('chat-input')).toBeVisible();
  });

  test('C opens the message box over the video while it shows', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia');
    await openFullscreen(page, hub);
    await button(page).click();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    // Act
    await page.keyboard.press('c');

    // Assert
    await expect(page.getByTestId('chat-overlay-input').getByTestId('chat-input')).toBeFocused();
    await expect(page.getByTestId('chat-input')).toHaveValue('');
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`readable on any picture (${scheme} theme): light text on a strong scrim, names at least 4.5:1 against the lightest the scrim gets`, async ({ page }) => {
      // Arrange
      await page.emulateMedia({ colorScheme: scheme });
      const hub = new MockHub('Bia');
      const dark = { a: 'k4', n: 'Escuro', c: '#1a1a1a', r: 'viewer' as const };
      await openFullscreen(page, hub);
      await button(page).click();

      // Act
      hub.say(dark, 'nome escuro');
      hub.say(ana, 'nome azul');

      // Assert
      await expect(lines(page)).toHaveCount(2);
      const result = await page.evaluate(() => {
        const lum = (css: string) => {
          const [r, g, b] = (css.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => Number(v) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
          return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
        };
        const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        const line = document.querySelector('.ov-line')!;
        const bg = getComputedStyle(line).backgroundColor;
        const alpha = Number((bg.match(/[\d.]+/g) ?? [])[3] ?? 1);
        // The lightest the line gets: its scrim over a white picture.
        const worst = (1 - alpha) * 1 + alpha * 0;
        const worstLum = lum(`rgb(${worst * 255}, ${worst * 255}, ${worst * 255})`);
        const names = [...document.querySelectorAll<HTMLElement>('.ov-line .nick')].map((n) => ratio(lum(getComputedStyle(n).color), worstLum));
        const text = ratio(lum(getComputedStyle(line).color), worstLum);
        return { alpha, names, text };
      });
      expect(result.alpha).toBeCloseTo(0.72, 2);
      for (const n of result.names) expect(n).toBeGreaterThanOrEqual(4.5);
      expect(result.text).toBeGreaterThanOrEqual(4.5);
    });
  }

  test('reduce motion: lines come and go without a fade', async ({ page }) => {
    // Arrange
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const hub = new MockHub('Bia');
    await openFullscreen(page, hub);
    await button(page).click();

    // Act
    hub.say(ana, 'sem animação');

    // Assert
    await expect(lines(page)).toHaveCount(1);
    expect(await lines(page).first().evaluate((el) => getComputedStyle(el).transitionDuration)).toMatch(/^0s/);
  });

  test('hide chat means no chat over the video either; chat off: no button', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia');
    await page.setViewportSize({ width: 1280, height: 800 });
    await openWatch(page, hub);
    await page.getByTestId('chat-hide').click();
    await page.getByTestId('fullscreen').click();
    await expect.poll(() => fullscreen(page)).toBe(true);

    // Assert
    await expect(button(page)).toBeHidden();
    await expect(overlay(page)).toBeHidden();

    // Act
    await page.getByTestId('fullscreen').click();
    await expect.poll(() => fullscreen(page)).toBe(false);
    await page.getByTestId('chat-show').click();
    hub.setSettings({ enabled: false });
    await page.getByTestId('fullscreen').click();
    await expect.poll(() => fullscreen(page)).toBe(true);

    // Assert
    await expect(button(page)).toBeHidden();
    await expect(overlay(page)).toBeHidden();
  });

  test('a deleted message leaves the video too; Clear empties it', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia');
    await openFullscreen(page, hub);
    await button(page).click();
    const s = hub.say(ana, 'apaga isso');
    hub.say(cris, 'fica');
    await expect(lines(page)).toHaveCount(2);

    // Act
    hub.remove([s]);

    // Assert
    await expect(lines(page)).toHaveText([/Cris: fica/]);

    // Act
    hub.clear();

    // Assert
    await expect(lines(page)).toHaveCount(0);
  });

  test('in Portuguese', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia');
    await openFullscreen(page, hub, 'pt-BR');

    // Act
    await button(page).click();

    // Assert
    await expect(button(page)).toHaveAccessibleName('Chat sobre o vídeo');
    await expect(page.getByTestId('chat-overlay-write')).toHaveAccessibleName('Escrever uma mensagem');
  });

  test('an iPhone without element full screen: with the chat on the video on, the full-screen button fills the page instead of opening the iPhone\'s own player; Escape leaves', async ({ page }) => {
    // Arrange: Safari on an iPhone before iOS 26 (player-caps.ts "video-native").
    await page.addInitScript(() => {
      const w = window as unknown as { __nativeFullscreen: number };
      w.__nativeFullscreen = 0;
      for (const proto of [Element.prototype, HTMLElement.prototype]) {
        delete (proto as unknown as Record<string, unknown>).requestFullscreen;
        delete (proto as unknown as Record<string, unknown>).webkitRequestFullscreen;
      }
      Object.defineProperty(HTMLVideoElement.prototype, 'webkitEnterFullscreen', { configurable: true, value: () => void w.__nativeFullscreen++ });
    });
    const hub = new MockHub('Bia');
    await openWatch(page, hub);
    hub.say(ana, 'oi do iPhone');
    const native = () => page.evaluate(() => (window as unknown as { __nativeFullscreen: number }).__nativeFullscreen);

    // Act: off, the iPhone's own player.
    await page.getByTestId('fullscreen').click();

    // Assert
    await expect.poll(native).toBe(1);
    await expect(page.locator('.player')).not.toHaveClass(/\bpc-fill\b/);

    // Act: on (Settings), then the button again.
    await page.getByTestId('settings-open').click();
    await page.getByTestId('chat-overlay-setting').check();
    await page.getByTestId('settings-close').click();
    await page.getByTestId('fullscreen').click();

    // Assert
    await expect(page.locator('.player')).toHaveClass(/\bpc-fill\b/);
    expect(await native()).toBe(1);
    await expect(page.getByTestId('fullscreen')).toHaveAccessibleName('Exit full screen');
    const player = (await page.locator('.player').boundingBox())!;
    const vp = page.viewportSize()!;
    expect(player.width).toBeGreaterThanOrEqual(vp.width - 1);
    expect(player.height).toBeGreaterThanOrEqual(vp.height - 1);
    await expect(overlay(page)).toBeVisible();
    await expect(lines(page)).toHaveText([/Ana: oi do iPhone/]);
    await expect(button(page)).toBeVisible();

    // Act
    await page.keyboard.press('Escape');

    // Assert
    await expect(page.locator('.player')).not.toHaveClass(/\bpc-fill\b/);
    await expect(overlay(page)).toBeHidden();
  });

  test('on a phone the lines keep clear of the controls and inside the screen @mobile', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia');
    await openWatch(page, hub);
    await page.getByTestId('settings-open').click();
    await page.getByTestId('chat-overlay-setting').check();
    await page.getByTestId('settings-close').click();
    hub.say(ana, 'uma mensagem bem comprida para ver se ela quebra direitinho dentro da caixa no celular');

    // Act
    await page.getByTestId('fullscreen').click();

    // Assert
    await expect(overlay(page)).toBeVisible();
    await expect(lines(page)).toHaveCount(1);
    const ov = await box(page, 'chat-overlay');
    const bar = await box(page, 'controls');
    expect(ov.bottom).toBeLessThanOrEqual(bar.top + 1);
    expect(ov.left).toBeGreaterThanOrEqual(0);
    expect(ov.right).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  });
});
