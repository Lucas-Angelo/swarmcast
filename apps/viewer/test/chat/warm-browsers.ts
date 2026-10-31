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
// once, with the same page and texts, in each engine launched as its projects launch it. Each
// worker's own browser then renders it once more before its first test (fixtures.ts). Engines
// that are not installed are skipped.
import { chromium, firefox, webkit, type BrowserType, type FullConfig } from '@playwright/test';
import { renderWatchCorpus } from './warm.js';

const TYPES: Record<string, BrowserType> = { chromium, firefox, webkit };

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
      browser = await TYPES[name]!.launch({ ...project.use.launchOptions, ...(channel ? { channel } : {}) });
    } catch (err) {
      // Not installed on this runner (its project is not run here either). Said, not swallowed: an
      // engine that is installed but cannot start fails its tests, and this line tells why.
      console.log(`not warmed ${key.replace(/:$/, '')}: ${String((err as Error).message).split('\n')[0]}`);
      continue;
    }
    try {
      await renderWatchCorpus(await browser.newPage());
    } finally {
      await browser.close();
    }
    console.log(`warmed ${key.replace(/:$/, '')} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
}
