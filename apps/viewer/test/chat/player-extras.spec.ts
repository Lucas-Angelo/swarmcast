// Theater mode, keyboard shortcuts and "stats for nerds" on the built watch page, in chromium,
// firefox and webkit (and phones for @mobile), against the mock hub: no stream plays here, so these
// are the layout, the keys and the panel's open / close; the player's side (play / pause, the
// panel's numbers from a real stream) is in apps/server/test/e2e/player-extras.spec.ts.
// Run: npm run build -w @swarmcast/viewer && npx playwright test -c apps/viewer/test/chat/playwright.config.ts player-extras
import { expect, test, type Page } from './fixtures.js';
import { MockHub } from './mock-hub.js';
import { openWatch, requireBuild } from './watch-page.js';

test.beforeAll(requireBuild);

const box = async (page: Page, selector: string): Promise<{ x: number; y: number; width: number; height: number }> => {
  const b = await page.locator(selector).boundingBox();
  if (!b) throw new Error(`${selector} is not laid out`);
  return b;
};

/** The page in theater mode (the class the styles widen the player with). */
const inTheater = (page: Page): Promise<boolean> => page.evaluate(() => document.body.classList.contains('theater'));
const muted = (page: Page): Promise<boolean> => page.evaluate(() => document.querySelector('video')!.muted);

/** Gives the focus to the page itself (nothing in particular), as after a click on an empty spot. */
async function focusPage(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(true);
}

test.describe('theater mode', () => {
  test('a laptop (1280 px): the player takes the whole width, the chat goes under it; remembered', async ({ page }) => {
    // Arrange
    await page.setViewportSize({ width: 1280, height: 720 });
    await openWatch(page, new MockHub('Bia'));
    const button = page.getByTestId('theater');
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    const before = await box(page, '.player');
    expect((await box(page, '[data-testid="chat"]')).x).toBeGreaterThanOrEqual(before.x + before.width - 1);

    // Act
    await button.click();

    // Assert
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await box(page, '.player')).width).toBeGreaterThan(before.width + 200);
    const player = await box(page, '.player');
    const bar = await box(page, '.bar');
    // The bar stays right under the video and in view; the video keeps its own controls; the
    // chat is under the bar.
    expect(player.x + player.width).toBeLessThanOrEqual(1280);
    expect(bar.y).toBeGreaterThanOrEqual(player.y + player.height - 1);
    expect(bar.y + bar.height).toBeLessThanOrEqual(720);
    expect((await box(page, '[data-testid="chat"]')).y).toBeGreaterThanOrEqual(bar.y + bar.height - 1);
    expect(await page.locator('video').getAttribute('controls')).not.toBeNull();

    // Act
    await page.reload();

    // Assert
    await expect(page.getByTestId('theater')).toHaveAttribute('aria-pressed', 'true');
    expect(await inTheater(page)).toBe(true);

    // Act
    await page.getByTestId('theater').click();

    // Assert
    await expect(page.getByTestId('theater')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => Math.round((await box(page, '.player')).width)).toBe(Math.round(before.width));
  });

  test('a wide screen (1800 px): a wider player with the chat still beside it', async ({ page }) => {
    // Arrange
    await page.setViewportSize({ width: 1800, height: 1000 });
    await openWatch(page, new MockHub('Bia'));
    const before = await box(page, '.player');

    // Act
    await page.getByTestId('theater').click();

    // Assert
    await expect.poll(async () => (await box(page, '.player')).width).toBeGreaterThan(before.width + 100);
    const player = await box(page, '.player');
    const chat = await box(page, '[data-testid="chat"]');
    const bar = await box(page, '.bar');
    expect(chat.x).toBeGreaterThanOrEqual(player.x + player.width - 1);
    expect(chat.x + chat.width).toBeLessThanOrEqual(1800);
    expect(Math.round(chat.height)).toBe(Math.round(player.height));
    expect(bar.y + bar.height).toBeLessThanOrEqual(1000);
  });

  test('works with the chat hidden: the player takes the width the chat had, and more', async ({ page }) => {
    // Arrange
    await openWatch(page, new MockHub('Bia'));
    await page.getByTestId('chat-hide').click();
    await expect(page.getByTestId('chat')).toBeHidden();
    const before = await box(page, '.player');

    // Act
    await page.getByTestId('theater').click();

    // Assert
    await expect.poll(async () => (await box(page, '.player')).width).toBeGreaterThan(before.width + 40);
    const player = await box(page, '.player');
    expect(player.x + player.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await expect(page.getByTestId('chat-show')).toBeVisible();
  });

  test('a phone has no theater button and its layout does not change @mobile', async ({ page }) => {
    // Arrange
    await openWatch(page, new MockHub('Bia'));
    const before = await box(page, '.player');

    // Assert
    await expect(page.getByTestId('theater')).toBeHidden();

    // Act: a keyboard on a tablet or a phone still has T
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true, cancelable: true })));

    // Assert
    expect(await inTheater(page)).toBe(true);
    expect(await box(page, '.player')).toEqual(before);
  });
});

test.describe('keyboard shortcuts', () => {
  test('T and M work from the page; typing "kmft" in the chat box only types', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia');
    await openWatch(page, hub);
    await focusPage(page);
    expect(await muted(page)).toBe(true);

    // Act
    await page.keyboard.press('t');
    await page.keyboard.press('m');

    // Assert
    expect(await inTheater(page)).toBe(true);
    expect(await muted(page)).toBe(false);
    await expect(page.getByTestId('theater')).toHaveAttribute('aria-pressed', 'true');

    // Act
    const input = page.getByTestId('chat-input');
    await input.click();
    await page.keyboard.type('kmft ?s');

    // Assert: the text is in the box, nothing toggled, no panel, no list
    await expect(input).toHaveValue('kmft ?s');
    expect(await inTheater(page)).toBe(true);
    expect(await muted(page)).toBe(false);
    await expect(page.getByTestId('keys-help')).toBeHidden();
    await expect(page.getByTestId('stats')).toBeHidden();

    // Act: C from the page goes to the chat box without typing a "c"
    await input.fill('');
    await focusPage(page);
    await page.keyboard.press('c');

    // Assert
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('');
  });

  test('? opens the list; its switch turns the shortcuts off, remembered after a reload; Esc closes it', async ({ page }) => {
    // Arrange
    await openWatch(page, new MockHub('Bia'));
    await focusPage(page);

    // Act
    await page.keyboard.press('?');

    // Assert
    const help = page.getByTestId('keys-help');
    await expect(help).toBeVisible();
    await expect(help.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible();
    await expect(help.locator('dd')).toContainText(['Play or pause', 'Sound on or off', 'Full screen (Esc leaves it)', 'Theater mode (a bigger video)', 'Go live']);
    const toggle = help.getByLabel('Use keyboard shortcuts');
    await expect(toggle).toBeChecked();

    // Act
    await toggle.uncheck();
    await page.keyboard.press('Escape');

    // Assert
    await expect(help).toBeHidden();

    // Act
    await page.reload();
    await focusPage(page);
    await page.keyboard.press('t');
    await page.keyboard.press('m');
    await page.keyboard.press('?');

    // Assert: off, so nothing happened, not even the list
    expect(await inTheater(page)).toBe(false);
    expect(await muted(page)).toBe(true);
    await expect(help).toBeHidden();

    // Act: the link is the way back
    await page.getByTestId('keys-open').click();

    // Assert
    await expect(help).toBeVisible();
    await expect(help.getByLabel('Use keyboard shortcuts')).not.toBeChecked();

    // Act
    await help.getByLabel('Use keyboard shortcuts').check();
    await help.getByRole('button', { name: 'Close' }).click();
    await focusPage(page);
    await page.keyboard.press('t');

    // Assert
    await expect(help).toBeHidden();
    expect(await inTheater(page)).toBe(true);
  });

  test('pt-BR: the list and the buttons in Portuguese', async ({ page }) => {
    // Arrange
    await openWatch(page, new MockHub('Bia'), { lang: 'pt-BR' });

    // Act
    await page.getByTestId('keys-open').click();

    // Assert
    const help = page.getByTestId('keys-help');
    await expect(help.getByRole('heading', { name: 'Atalhos de teclado' })).toBeVisible();
    await expect(help.locator('kbd').first()).toHaveText('Espaço');
    await expect(help.getByLabel('Usar atalhos de teclado')).toBeChecked();
    await expect(page.getByTestId('theater')).toHaveText('Modo cinema');
    await expect(page.getByTestId('stats-open')).toHaveText('Estatísticas para nerds');
  });
});

test.describe('stats for nerds', () => {
  test('closed by default and not loaded; opens from its link, S toggles it, Esc closes it and the focus goes back', async ({ page }) => {
    // Arrange
    const statsChunks: string[] = [];
    page.on('request', (r) => {
      if (/\/assets\/stats-overlay-[\w-]+\.(js|css)$/.test(r.url())) statsChunks.push(r.url());
    });
    await openWatch(page, new MockHub('Bia'));
    const link = page.getByTestId('stats-open');
    const panel = page.getByTestId('stats');

    // Assert
    await expect(panel).toBeHidden();
    await expect(link).toHaveAttribute('aria-expanded', 'false');
    expect(statsChunks).toEqual([]);

    // Act
    await link.click();

    // Assert
    await expect(panel).toBeVisible();
    await expect(link).toHaveAttribute('aria-expanded', 'true');
    await expect(panel.getByRole('heading', { name: 'Stats for nerds' })).toBeVisible();
    await expect(panel.locator('dt')).toHaveText(['Resolution', 'Quality', 'Internet speed (estimate)', 'Video loaded ahead', 'Behind live', 'Playback', 'Dropped frames', 'P2P', 'Received from other viewers', 'Sent to other viewers', 'Received from the streamer', 'Connection', 'Player']);
    await expect(panel.locator('[data-stat="p2p"] dd')).toHaveText('Off');
    await expect(page.getByRole('button', { name: 'Close stats for nerds' })).toBeFocused();
    expect(statsChunks.some((u) => u.endsWith('.js'))).toBe(true);
    // It sits over the top of the video, in view (the link is further down the page), and
    // leaves the bottom of the video (the controls) free.
    await expect(panel).toBeInViewport();
    const player = await box(page, '.player');
    const over = await box(page, '[data-testid="stats"]');
    expect(over.y).toBeGreaterThanOrEqual(player.y);
    expect(over.y + over.height).toBeLessThan(player.y + player.height - 40);

    // Act
    await page.keyboard.press('Escape');

    // Assert
    await expect(panel).toBeHidden();
    await expect(link).toBeFocused();
    await expect(link).toHaveAttribute('aria-expanded', 'false');

    // Act
    await focusPage(page);
    await page.keyboard.press('s');

    // Assert
    await expect(panel).toBeVisible();

    // Act
    await page.getByRole('button', { name: 'Close stats for nerds' }).click();

    // Assert
    await expect(panel).toBeHidden();
  });

  test('on a phone it fits over the video and closes @mobile', async ({ page }) => {
    // Arrange
    await openWatch(page, new MockHub('Bia'));

    // Act
    await page.getByTestId('stats-open').click();

    // Assert
    const panel = page.getByTestId('stats');
    await expect(panel).toBeVisible();
    const player = await box(page, '.player');
    const over = await box(page, '[data-testid="stats"]');
    expect(over.x).toBeGreaterThanOrEqual(player.x);
    expect(over.x + over.width).toBeLessThanOrEqual(player.x + player.width);
    expect(over.y + over.height).toBeLessThanOrEqual(player.y + player.height);

    // Act
    await page.getByRole('button', { name: 'Close stats for nerds' }).click();

    // Assert
    await expect(panel).toBeHidden();
  });
});
