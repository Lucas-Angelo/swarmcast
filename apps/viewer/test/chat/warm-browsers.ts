// Playwright globalSetup for the chat UI specs: start every engine of the config once and render
// in it what the specs render (the watch page with the whole corpus, emoji and every script),
// before any test's clock runs. The first start of a browser on a fresh CI runner is slow far
// beyond the page under test (Windows scans the new binary and builds its font caches: Firefox
// there took over 30 s to load the first page, and the next tests 17-19 s instead of under one).
// The machine's first load of a system font is slow too, and it holds up every process that asks
// for a font meanwhile: on a fresh Windows runner, Chrome's renderers lay text out with a blocking
// call to the browser process's font service (FontDataService, over DirectWrite), so while the
// corpus spec's first page loaded the CJK, Indic and other fallback fonts, a watch page in another
// worker's browser stood still in layout for 2-7 s (a Chrome trace showed one font match for Arial
// taking 1.8 s), long enough to miss openWatch's 5 s check. Only the first run on a runner did
// that, never later runs on the same machine, with fresh browsers each time: so it is done here,
// once, with the same page and texts. Each test's own browser is then warm except for its
// per-process font fallback, which openWatch handles (watch-page.ts). Engines that are not
// installed are skipped.
import { chromium, firefox, webkit, type BrowserType, type FullConfig } from '@playwright/test';
import { NAMES, SNAPSHOT_MAX, sayCorpus } from './corpus-hub.js';
import { MockHub } from './mock-hub.js';
import { loadWatch, warmFontFallback } from './watch-page.js';

const TYPES: Record<string, BrowserType> = { chromium, firefox, webkit };
/**
 * The warm-up is not a check: it takes what the machine needs (over 30 s for a cold engine), and
 * this only bounds it, so an engine that never renders the page fails the run instead of hanging it.
 */
const WARM_LIMIT_MS = 120_000;

export default async function warmBrowsers(config: FullConfig): Promise<void> {
  const seen = new Set<string>();
  for (const project of config.projects) {
    const name = project.use.browserName ?? project.use.defaultBrowserType ?? 'chromium';
    const channel = project.use.channel;
    const key = `${name}:${channel ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const t0 = Date.now();
    let browser;
    try {
      browser = await TYPES[name]!.launch(channel ? { channel } : {});
    } catch (err) {
      // Not installed on this runner (its project is not run here either). Said, not swallowed: an
      // engine that is installed but cannot start fails its tests, and this line tells why.
      console.log(`not warmed ${key.replace(/:$/, '')}: ${String((err as Error).message).split('\n')[0]}`);
      continue;
    }
    try {
      const page = await browser.newPage();
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
    } finally {
      await browser.close();
    }
    console.log(`warmed ${key.replace(/:$/, '')} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
}
