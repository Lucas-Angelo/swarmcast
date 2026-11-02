// The player's own controls on the built watch page against the mock hub (no stream plays here, so
// the video stays paused and the bar shown): the browser's controls are gone, the bar lies across
// the bottom of the video with every control a named button of at least 44 x 44 px (phones too,
// @mobile), nothing overflows a phone's width, theater mode and the volume slider are left out on
// a phone, F and the button put the player container in full screen with the bar on the screen
// (computers), and the page's CSP refuses nothing (no <select> any more: WebKit's own parts of one
// broke it). The player's side (play, sound, fading, picture-in-picture, the quality menu on a real
// stream): apps/server/test/e2e/player-controls.spec.ts.
// Run: npm run build -w @swarmcast/viewer && npx playwright test -c apps/viewer/test/chat/playwright.config.ts player-controls
import { expect, test, type Page } from './fixtures.js';
import { MockHub } from './mock-hub.js';
import { openWatch, requireBuild } from './watch-page.js';

test.beforeAll(requireBuild);

/** Records every refusal of the page's CSP from its first script on (no screenshot before reading it: Playwright's own style would count). */
async function recordCsp(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => w.__csp.push(`${e.effectiveDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`));
  });
  return () => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
}

/** Each shown control of the bar: its test id, its accessible name and its size. */
function shownControls(page: Page) {
  return page.getByTestId('controls').evaluate((bar) =>
    [...bar.querySelectorAll<HTMLElement>('button, input')]
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => {
        const r = el.getBoundingClientRect();
        const label = el.getAttribute('aria-label') ?? el.querySelector('.pc-sr')?.textContent ?? el.textContent ?? '';
        return { id: el.dataset.testid ?? el.id, label: label.trim(), tag: el.tagName, w: r.width, h: r.height };
      }),
  );
}

test('the bar replaces the browser controls: across the bottom of the video, named buttons, 44 px targets; no CSP refusal', async ({ page }) => {
  // Arrange
  await page.setViewportSize({ width: 1280, height: 800 });
  const csp = await recordCsp(page);

  // Act
  await openWatch(page, new MockHub('Bia'));

  // Assert
  expect(await page.locator('video').getAttribute('controls')).toBeNull();
  const player = (await page.locator('.player').boundingBox())!;
  const bar = (await page.getByTestId('controls').boundingBox())!;
  expect(Math.round(bar.y + bar.height)).toBe(Math.round(player.y + player.height));
  expect(Math.round(bar.x)).toBe(Math.round(player.x));
  expect(Math.round(bar.width)).toBe(Math.round(player.width));
  await expect(page.getByTestId('controls')).toHaveAttribute('role', 'group');
  await expect(page.getByTestId('controls')).toHaveAccessibleName('Video controls');
  const controls = await shownControls(page);
  expect(controls.map((c) => c.id)).toEqual(expect.arrayContaining(['play', 'mute', 'volume', 'theater', 'fullscreen']));
  for (const c of controls) {
    expect(c.label, `${c.id} has a name`).not.toBe('');
    if (c.tag === 'BUTTON') expect(Math.min(c.w, c.h), `${c.id} is a 44 px target`).toBeGreaterThanOrEqual(44);
  }
  // The paused video's big Play button waits for the first picture (none behind the mock).
  await expect(page.getByTestId('big-play')).toBeHidden();
  expect(await page.locator('select').count()).toBe(0);
  expect(await csp()).toEqual([]);
});

test('F and the full-screen button put the player container in full screen, the bar on the screen with it', async ({ page }) => {
  // Arrange
  await page.setViewportSize({ width: 1280, height: 800 });
  await openWatch(page, new MockHub('Bia'));
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const containerFullscreen = (): Promise<boolean> => page.evaluate(() => document.fullscreenElement === document.querySelector('.player'));

  // Act
  await page.keyboard.press('f');

  // Assert
  await expect.poll(containerFullscreen).toBe(true);
  await expect(page.getByTestId('controls')).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId('fullscreen')).toHaveAccessibleName('Exit full screen');
  await expect(page.locator('.player')).toHaveClass(/\bis-fullscreen\b/);

  // Act
  await page.getByTestId('fullscreen').click();

  // Assert
  await expect.poll(containerFullscreen).toBe(false);
  await expect(page.getByTestId('fullscreen')).toHaveAccessibleName('Full screen');
});

test('pt-BR: the controls are named in Portuguese', async ({ page }) => {
  // Act
  await openWatch(page, new MockHub('Bia'), { lang: 'pt-BR' });

  // Assert
  await expect(page.getByTestId('controls')).toHaveAccessibleName('Controles do vídeo');
  await expect(page.getByTestId('play')).toHaveAccessibleName('Reproduzir');
  await expect(page.getByTestId('mute')).toHaveAccessibleName('Ativar som');
  await expect(page.getByTestId('fullscreen')).toHaveAccessibleName('Tela cheia');
  await expect(page.getByTestId('volume')).toHaveAccessibleName('Volume');
});

test('a phone: one row across the video, 44 px targets, no theater mode or volume slider, nothing wider than the screen @mobile', async ({ page }) => {
  // Arrange
  const csp = await recordCsp(page);

  // Act
  await openWatch(page, new MockHub('Bia'));

  // Assert
  const width = page.viewportSize()!.width;
  const player = (await page.locator('.player').boundingBox())!;
  const bar = (await page.getByTestId('controls').boundingBox())!;
  expect(Math.round(bar.y + bar.height)).toBe(Math.round(player.y + player.height));
  // One row: no taller than its tallest control and its padding.
  expect(bar.height).toBeLessThanOrEqual(56);
  const controls = await shownControls(page);
  for (const c of controls) expect(Math.min(c.w, c.h), `${c.id} is a 44 px target`).toBeGreaterThanOrEqual(44);
  expect(controls.map((c) => c.id)).not.toContain('theater');
  expect(controls.map((c) => c.id)).not.toContain('volume');
  expect(controls.map((c) => c.id)).toEqual(expect.arrayContaining(['play', 'mute', 'fullscreen']));
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  expect(await csp()).toEqual([]);
});
