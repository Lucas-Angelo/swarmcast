// The streamer's banner above the player (branding/brand.ts banner(), brand.css): its 4:1 slot
// shows as soon as the branding is known, and the picture, which waits for the first fragment so
// it never delays the first frame, fills that slot. It used to appear only with the picture, after
// the first fragment, and push the player down while the viewer was about to use it.
//
// The page runs its branding alone (openBrandedStage): the test calls the page's firstFrame() the
// way the player does on its first fragment. Window sizes where the 25vh cap and where the 4:1
// ratio decide the slot's height.
import { expect, test, type Page } from '@playwright/test';
import { openBrandedStage, requireBuild } from './watch-page.js';

test.beforeAll(requireBuild);

const picture = (c: string) => `/brand/${c.repeat(64)}.webp`;
const BRANDING = {
  rev: 3,
  name: 'Ana Plays',
  tags: [],
  links: [],
  theme: { preset: 'forest', corners: 'round' },
  banner: { s1280: picture('e'), s640: picture('f'), alt: 'Ana at her desk' },
  showCredit: true,
};

/** The box of `selector` once the page's fonts and pictures are in. */
async function settledBox(page: Page, selector: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((img) => img.decode().catch(() => undefined)));
  });
  return page.locator(selector).boundingBox();
}

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 1280, height: 560 },
  { width: 390, height: 844 },
]) {
  test.describe(`banner at ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport });

    test('the slot is there, empty, as soon as the branding is known', async ({ page }) => {
      // Act
      await openBrandedStage(page, { brand: BRANDING });

      // Assert
      await expect(page.locator('#brand-banner')).toBeVisible();
      await expect(page.locator('#brand-banner img')).toHaveCount(0);
      const slot = await page.locator('#brand-banner').boundingBox();
      expect(slot!.height).toBeCloseTo(Math.min(slot!.width / 4, viewport.height / 4), 0);
    });

    test('the picture comes after the first fragment and moves neither the player nor its slot', async ({ page }) => {
      // Arrange
      await openBrandedStage(page, { brand: BRANDING });
      const player = await settledBox(page, '.player');
      const slot = await settledBox(page, '#brand-banner');

      // Act
      await page.evaluate(() => (window as unknown as { __stage: { firstFrame(): void } }).__stage.firstFrame());
      await expect(page.locator('#brand-banner img')).toHaveJSProperty('complete', true);

      // Assert
      await expect(page.locator('#brand-banner img')).toHaveAttribute('alt', 'Ana at her desk');
      expect(await settledBox(page, '.player')).toEqual(player);
      expect(await settledBox(page, '#brand-banner')).toEqual(slot);
    });
  });
}

test('without a banner in the branding there is no slot', async ({ page }) => {
  // Act
  await openBrandedStage(page, { brand: { ...BRANDING, banner: undefined } });

  // Assert
  await expect(page.locator('#brand-banner')).toBeHidden();
});
