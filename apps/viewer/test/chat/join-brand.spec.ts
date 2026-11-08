// The join page with the streamer's branding (branding/loader.ts startJoinBranding, style.css): the
// streamer's header, title and tagline are taller than the stock ones, and when they came in after
// the page showed (100-300 ms after load) they moved the form down under a press in progress: a
// press on "Watch" released after the move landed on the card, and the join never went out. The
// page now shows once its branding is known, so the form never moves. Loading the branding must
// not bring the watch page's script along (a bundling slip once made it run on the join page).
//
// style.css also shows the page by itself after 3 s of CSS time, for when the script is late (a
// slow phone runs it seconds after the styles) or never runs. A page shown that way already takes
// taps, so branding that comes after it only changes the tab title, as after JOIN_BRAND_WAIT_MS: it
// used to put the streamer's taller header in then, moving the form under a press, and on iOS a
// change under a tap can turn the tap into a hover with no click. The fallback must also work when
// the visitor asks for reduced motion (the brand layer turns every animation off then).
//
// /api/brand is held until the test answers it; the page's timers run on page.clock and its CSS
// animations stand still (openJoin), so each step happens exactly when the test says.
import { expect, test, type Page } from './fixtures.js';
import { JOIN_BRAND_WAIT_MS } from '../../src/branding/loader.js';
import { freezePageClock, openJoin, requireBuild } from './watch-page.js';

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
/** How many times in a row the page reloads itself when its scripts fail to load (its startup guard, @swarmcast/shared/web/startup-guard). */
const STARTUP_RELOADS = 3;

/** An answer the test gives when it wants: `answer` settles once `release(value)` is called. */
function held<T>() {
  let release: (value: T) => void = () => {};
  const answer = new Promise<T>((resolve) => (release = resolve));
  return { answer, release };
}

/** Runs style.css's fallback: sets the page's paused CSS animations to the time it shows the page by itself. */
async function runCssFallback(page: Page): Promise<void> {
  await page.evaluate((ms) => {
    for (const a of document.getAnimations()) a.currentTime = ms;
  }, CSS_FALLBACK_MS);
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

  for (const reducedMotion of ['no-preference', 'reduce'] as const) {
    test(`without its scripts the page reloads itself three times, then still shows after ${CSS_FALLBACK_MS / 1000} s of CSS time (reduced motion: ${reducedMotion})`, async ({ page }) => {
      // Arrange
      await page.emulateMedia({ reducedMotion });
      const brand = held<unknown>();
      const { loads } = await openJoin(page, { brand: brand.answer, withoutScripts: true });
      await expect.poll(loads).toBe(1 + STARTUP_RELOADS);
      await page.waitForLoadState('load');
      await expect(page.locator('main.card')).toHaveCSS('opacity', '0');

      // Act
      await runCssFallback(page);

      // Assert
      await expect(page.locator('main.card')).toHaveCSS('opacity', '1');
      await expect(page.locator('main.card')).toHaveCSS('pointer-events', 'auto');
      expect(loads()).toBe(1 + STARTUP_RELOADS);
    });
  }
});

test.describe('join page shown by style.css before its branding is known', () => {
  test('branding that comes after keeps the stock layout; only the tab title follows', async ({ page }) => {
    // Arrange
    await freezePageClock(page);
    const brand = held<unknown>();
    await openJoin(page, { brand: brand.answer });
    await expect(page.locator('main.card')).toHaveCSS('opacity', '0');
    await runCssFallback(page);
    await expect(page.locator('main.card')).toHaveCSS('pointer-events', 'auto');
    const shown = await settledWatchBox(page);

    // Act
    brand.release(BRANDING);

    // Assert
    await expect(page).toHaveTitle(new RegExp(NAME));
    await expect(page.locator('main.card h1')).toHaveText('Join the stream');
    await expect(page.locator('#brand-head')).toBeHidden();
    expect(await settledWatchBox(page)).toEqual(shown);
  });

  test('"Watch" takes the press as soon as the page shows, and the join goes out', async ({ page }) => {
    // Arrange
    await freezePageClock(page);
    const brand = held<unknown>();
    const { joins } = await openJoin(page, { brand: brand.answer });
    await expect(page.locator('main.card')).toHaveCSS('opacity', '0');

    // Act
    await runCssFallback(page);
    await page.getByLabel('Nickname').fill('Bia');
    await page.getByRole('button', { name: 'Watch' }).click();

    // Assert
    await expect.poll(() => joins).toEqual([{ nickname: 'Bia' }]);
  });

  test('a page shown before its script ran (a slow phone) keeps the stock layout when the script and the branding come', async ({ page }) => {
    // Arrange
    await freezePageClock(page);
    const script = held<void>();
    const brand = held<unknown>();
    await openJoin(page, { brand: brand.answer, script: script.answer });
    await expect(page.locator('main.card')).toHaveCSS('opacity', '0');
    await runCssFallback(page);
    await expect(page.locator('main.card')).toHaveCSS('pointer-events', 'auto');

    // Act
    script.release();
    await page.waitForLoadState('load');
    const shown = await settledWatchBox(page);
    brand.release(BRANDING);

    // Assert
    await expect(page).toHaveTitle(new RegExp(NAME));
    await expect(page.locator('main.card h1')).toHaveText('Join the stream');
    await expect(page.locator('#brand-head')).toBeHidden();
    expect(await settledWatchBox(page)).toEqual(shown);
    await expect(page.getByRole('button', { name: 'Watch' })).toBeEnabled();
  });
});
