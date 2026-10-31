// The join page with the streamer's branding (branding/loader.ts startJoinBranding, style.css): the
// streamer's header, title and tagline are taller than the stock ones, and when they came in after
// the page showed (100-300 ms after load) they moved the form down under a press in progress: a
// press on "Watch" released after the move landed on the card, and the join never went out. The
// page now shows once its branding is known, so the form never moves. Loading the branding must
// not bring the watch page's script along (a bundling slip once made it run on the join page).
//
// /api/brand is held until the test answers it; the page's timers run on page.clock and its CSS
// animations stand still (openJoin), so each step happens exactly when the test says.
import { expect, test, type Page } from '@playwright/test';
import { JOIN_BRAND_WAIT_MS } from '../../src/branding/loader.js';
import { openJoin, requireBuild } from './watch-page.js';

test.beforeAll(requireBuild);

const NAME = 'Ana Plays Games';
const BRANDING = {
  rev: 3,
  name: NAME,
  tagline: 'Chill indie games every Friday night, come hang out',
  tags: [],
  links: [],
  theme: { preset: 'forest', corners: 'round' },
  avatar: { s256: `/brand/${'a'.repeat(64)}.png`, s128: `/brand/${'b'.repeat(64)}.png` },
  showCredit: true,
};
/** CSS time at which the page shows without its script (style.css: the 3 s fallback). */
const CSS_FALLBACK_MS = 3000;
/** How many times in a row the page reloads itself when its scripts fail to load (join.html, startup guard). */
const STARTUP_RELOADS = 3;

/** An answer the test gives when it wants: `answer` settles once `release(value)` is called. */
function held<T>() {
  let release: (value: T) => void = () => {};
  const answer = new Promise<T>((resolve) => (release = resolve));
  return { answer, release };
}

/** The page's clock stands still from before it loads: its timers fire only when the test runs them. */
async function freezePageClock(page: Page): Promise<void> {
  const t0 = new Date('2026-01-01T12:00:00Z');
  await page.clock.install({ time: t0 });
  await page.clock.pauseAt(new Date(t0.getTime() + 1000));
}

/** Where "Watch" is, once the page's fonts and pictures are in. */
async function settledWatchBox(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((img) => img.decode().catch(() => undefined)));
  });
  return page.getByRole('button', { name: 'Watch' }).boundingBox();
}

test.describe('join page branding (no layout shift)', () => {
  test('the page stays hidden and untouchable until its branding is known', async ({ page }) => {
    // Arrange
    await freezePageClock(page);
    const brand = held<unknown>();

    // Act
    await openJoin(page, { brand: brand.answer });

    // Assert
    await expect(page.locator('body')).not.toHaveClass(/brand-known/);
    await expect(page.locator('main.card')).toHaveCSS('opacity', '0');
    await expect(page.locator('main.card')).toHaveCSS('pointer-events', 'none');
    await expect(page.locator('.site-head')).toHaveCSS('opacity', '0');
  });

  test('it shows with the branding already in, and "Watch" does not move after that', async ({ page }) => {
    // Arrange
    await freezePageClock(page);
    const brand = held<unknown>();
    await openJoin(page, { brand: brand.answer });

    // Act
    brand.release(BRANDING);
    await expect(page.locator('body')).toHaveClass(/brand-known/);
    const shown = await page.getByRole('button', { name: 'Watch' }).boundingBox();

    // Assert
    await expect(page.locator('main.card h1')).toContainText(NAME);
    await expect(page.locator('#brand-head .sc-brand-name')).toHaveText(NAME);
    await expect(page.locator('main.card')).toHaveCSS('opacity', '1');
    await expect(page.locator('main.card')).toHaveCSS('pointer-events', 'auto');
    expect(await settledWatchBox(page)).toEqual(shown);
  });

  test('the join page loads and runs none of the watch page (its script, its /api/config)', async ({ page }) => {
    // Arrange
    const requested: string[] = [];
    page.on('request', (r) => requested.push(new URL(r.url()).pathname));
    await freezePageClock(page);
    const brand = held<unknown>();
    await openJoin(page, { brand: brand.answer });

    // Act
    brand.release(BRANDING);
    await expect(page.locator('body')).toHaveClass(/brand-known/);

    // Assert
    expect(requested.filter((p) => /^\/assets\/watch-[\w-]+\.js$/.test(p) || p === '/api/config')).toEqual([]);
    await expect(page).toHaveTitle(`Join ${NAME}'s stream`);
  });

  test('a press on "Watch" right after the page shows sends the join', async ({ page }) => {
    // Arrange
    await freezePageClock(page);
    const brand = held<unknown>();
    const { joins } = await openJoin(page, { brand: brand.answer });
    brand.release(BRANDING);
    await expect(page.locator('body')).toHaveClass(/brand-known/);

    // Act
    await page.getByLabel('Nickname').fill('Bia');
    await page.getByRole('button', { name: 'Watch' }).click();

    // Assert
    await expect.poll(() => joins).toEqual([{ nickname: 'Bia' }]);
  });

  test(`branding later than ${JOIN_BRAND_WAIT_MS} ms: the page shows the stock layout and keeps it; only the tab title follows`, async ({ page }) => {
    // Arrange
    await freezePageClock(page);
    const brand = held<unknown>();
    await openJoin(page, { brand: brand.answer });

    // Act
    await page.clock.runFor(JOIN_BRAND_WAIT_MS);

    // Assert
    await expect(page.locator('body')).toHaveClass(/brand-known/);
    await expect(page.locator('main.card h1')).toHaveText('Join the stream');
    const shown = await settledWatchBox(page);

    // Act
    brand.release(BRANDING);

    // Assert
    await expect(page).toHaveTitle(new RegExp(NAME));
    await expect(page.locator('main.card h1')).toHaveText('Join the stream');
    await expect(page.locator('#brand-head')).toBeHidden();
    expect(await settledWatchBox(page)).toEqual(shown);
  });

  test(`without its scripts the page reloads itself three times, then still shows after ${CSS_FALLBACK_MS / 1000} s of CSS time`, async ({ page }) => {
    // Arrange
    const brand = held<unknown>();
    const { loads } = await openJoin(page, { brand: brand.answer, withoutScripts: true });
    await expect.poll(loads).toBe(1 + STARTUP_RELOADS);
    await page.waitForLoadState('load');
    await expect(page.locator('main.card')).toHaveCSS('opacity', '0');

    // Act
    await page.evaluate((ms) => {
      for (const a of document.getAnimations()) a.currentTime = ms;
    }, CSS_FALLBACK_MS);

    // Assert
    await expect(page.locator('main.card')).toHaveCSS('opacity', '1');
    await expect(page.locator('main.card')).toHaveCSS('pointer-events', 'auto');
    expect(loads()).toBe(1 + STARTUP_RELOADS);
  });
});
