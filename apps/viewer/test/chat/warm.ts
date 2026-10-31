// The warm-up the chat UI specs run before any test's clock: the watch page with the whole corpus
// (emoji and every script), rendered once in a browser. globalSetup (warm-browsers.ts) does it once
// per engine for the machine; the worker fixture (fixtures.ts) once in each worker's own browser.
import type { Page } from '@playwright/test';
import { NAMES, SNAPSHOT_MAX, sayCorpus } from './corpus-hub.js';
import { MockHub } from './mock-hub.js';
import { loadWatch, warmFontFallback } from './watch-page.js';

/**
 * A warm-up is not a check: it takes what the machine needs (over 30 s for a cold engine), and
 * this only bounds it, so a browser that never renders the page fails the run instead of hanging it.
 */
export const WARM_LIMIT_MS = 120_000;

/**
 * Renders in `page` what the specs render: the corpus texts on a blank page, then the watch page
 * with the whole corpus in its chat, its fonts loaded and two frames painted.
 */
export async function renderWatchCorpus(page: Page): Promise<void> {
  const hub = new MockHub('Bia');
  const sent = sayCorpus(hub);
  await warmFontFallback(page, [...NAMES, ...sent.map((e) => e.text)]);
  await loadWatch(page, hub);
  await page
    .getByTestId('chat-list')
    .locator('li.msg:not(.sys)')
    .nth(Math.min(sent.length, SNAPSHOT_MAX) - 1)
    .waitFor({ timeout: WARM_LIMIT_MS });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}
