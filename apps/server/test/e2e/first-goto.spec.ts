// A new page's first navigation to the server always commits. The answer carries
// Cross-Origin-Opener-Policy, so in WebKit that navigation moves to a new web process when the
// answer arrives, and Linux WebKit used to lose it now and then: `goto` waited until the test
// timed out (the first goto of a test, after any other test; fixtures.ts, routeFirstRequestOfEachPage).
// Here many fresh browsers open the server one after the other, as the specs do.
//
// Their work has to fit the slowest runner, not a normal one. A new browser costs what the
// engine needs to open a page (0.3-1.2 s), so a hundred in one test took 25-97 s of its 150 s on
// macOS runners, and all of it on a runner where every other test ran 1.4-2x slower too (run
// 43357329045: Firefox had opened 84 and WebKit 93, no step took more than 2.4 s, the last
// navigation started 0.1 s before the end). Nothing was lost there, yet the failure named no
// browser. So the browsers are split over a few tests, each a small part of its budget, and a
// navigation that does not commit fails in COMMIT_MS, naming its browser.
import { expect, test } from './fixtures.js';

/** Fresh browsers per run: without the route, Linux WebKit lost about one first navigation in 500-3000. */
const FRESH_BROWSERS = 100;

/**
 * Fresh browsers per test, so that each test is a small part of its budget wherever it runs: 25
 * are about 25 s on the slowest normal macOS runner, 45 s on the slow one of run 43357329045, and
 * 60 s in a Linux container with four busy processes per CPU (where a hundred in one test failed).
 */
const BROWSERS_PER_TEST = 25;

/**
 * A first navigation commits within this, or it was lost: the server answers on loopback at
 * once, the slowest commit took 0.9 s on a slow macOS runner and 5.7 s in that busy container,
 * and a lost one never commits.
 */
const COMMIT_MS = 30_000;

// Playwright screenshots every page as its context closes (kept only if the test fails): here a
// hundred copies of the same "link not valid" page, which cost each browser up to half of its
// time. The trace keeps what a failure needs (each page's navigation and its network).
test.use({ screenshot: 'off' });

for (let first = 1; first <= FRESH_BROWSERS; first += BROWSERS_PER_TEST) {
  const last = first + BROWSERS_PER_TEST - 1;
  test(`a new browser's first navigation to the server always commits (browsers ${first}-${last})`, { tag: '@ui' }, async ({ viewers }) => {
    for (let n = first; n <= last; n++) {
      await test.step(`browser ${n}`, async () => {
        // Arrange
        const context = await viewers.browserContext();
        const page = await context.newPage();

        // Act
        const answer = await page.goto('/', { waitUntil: 'commit', timeout: COMMIT_MS });

        // Assert
        expect(answer?.headers()['cross-origin-opener-policy'], `browser ${n}: the answer that moves the page to a new process`).toBe('same-origin');
        await context.close();
      });
    }
  });
}
