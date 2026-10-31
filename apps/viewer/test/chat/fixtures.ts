// The `test` of the chat UI specs: Playwright's, plus a warm-up of each worker's browser before
// its first test (browserWarm).
//
// A new browser has first-time work of its own, on top of the machine's (globalSetup,
// warm-browsers.ts), and Firefox does it on its parent process's main thread, the one that also
// answers Playwright and passes every request of a page: it creates the new profile's history and
// bookmarks database on the first page load (SQLite writes, each flushed to disk), and builds its
// font data on the first text in each script. On the Windows runners that held the parent 0.5-3.5 s
// within the first 7 s after launch, in the worker's first test (Gecko profiles, soak 41238667927:
// `INSERT INTO moz_bookmarks` and DirectWrite on the main thread while Playwright waited), and once
// that held a page's network answers for 6 s, past openWatch's 5 s check. Here each worker's
// browser loads and renders the watch page with the whole corpus first, in a context of its own,
// so that work is done before any test starts; each test's own origin storage is done by its page
// helpers (firstVisit, watch-page.ts).
import { test as base } from '@playwright/test';
import { renderWatchCorpus, WARM_LIMIT_MS } from './warm.js';

export { expect } from '@playwright/test';
export type { Page } from '@playwright/test';

export const test = base.extend<object, { browserWarm: void }>({
  browserWarm: [
    async ({ browser }, use) => {
      // The context options the tests use (playwright.config.ts `use`).
      const context = await browser.newContext({ locale: 'en-US', timezoneId: 'UTC' });
      try {
        await renderWatchCorpus(await context.newPage());
      } finally {
        await context.close();
      }
      await use();
    },
    { scope: 'worker', auto: true, timeout: WARM_LIMIT_MS },
  ],
});
