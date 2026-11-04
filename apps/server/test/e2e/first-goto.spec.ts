// A new page's first navigation to the server always commits. The answer carries
// Cross-Origin-Opener-Policy, so in WebKit that navigation moves to a new web process when the
// answer arrives, and Linux WebKit used to lose it now and then: `goto` waited until the test
// timed out (the first goto of a test, after any other test; fixtures.ts, routeFirstRequestOfEachPage).
// Here many fresh browsers open the server one after the other, as the specs do.
import { expect, test } from './fixtures.js';

/** Fresh browsers per run: without the route, Linux WebKit lost about one first navigation in 500-3000. */
const FRESH_BROWSERS = 100;

test('a new browser\'s first navigation to the server always commits', { tag: '@ui' }, async ({ viewers }) => {
  for (let i = 0; i < FRESH_BROWSERS; i++) {
    // Arrange
    const context = await viewers.browserContext();
    const page = await context.newPage();

    // Act
    const answer = await page.goto('/', { waitUntil: 'commit' });

    // Assert
    expect(answer?.headers()['cross-origin-opener-policy'], `browser ${i + 1}: the answer that moves the page to a new process`).toBe('same-origin');
    await context.close();
  }
});
