import type { CDPSession, Page } from '@playwright/test';
import { expect, join, test, uid, viewerByNick, waitForPlaylist, waitPlaying } from './fixtures.js';

// The adaptive playback delay (apps/viewer/src/latency-controller.ts, docs/QUALITY.md), end to
// end in a real player on a real (emulated) network, on a fast clock: `?delaySpeed=10` runs the
// controller's own clocks (dwell times, quiet period, target drift) 10× faster, and
// `?delayRate=10` moves playbackRate 10× further from 1 (catch-up ≤ 1.5× instead of 1.05×,
// slow-down 0.5× instead of 0.95×), so the delay follows that clock: a 5 s change takes 10 s
// instead of 100 s. The real-time numbers are covered by latency-controller.test.ts. The page
// honours both flags only because server.ts starts SwarmCast with SWARMCAST_TEST_HOOKS=1.
const FAST = '/watch?delaySpeed=10&delayRate=10';

interface Delay {
  delay: number | null;
  target: number;
  state: string;
  rateMode: string;
  playbackRate: number;
  /** The controller's playbackRate limits on this clock. */
  rates: { max: number; slow: number };
  stalls: number;
  stalledS: number;
  holds: number;
}

const delayOf = (page: Page): Promise<Delay> => page.evaluate(() => (window as unknown as { __swarmcast: { delay: Delay } }).__swarmcast.delay);

/** Once the live playlist is long enough to start ~20 s behind live: join, then reopen the player on the fast clock. */
async function watchWithFastClock(browser: Parameters<typeof join>[0], nick: string, before?: (page: Page) => Promise<void>): Promise<Awaited<ReturnType<typeof join>>> {
  await waitForPlaylist(32);
  const joined = await join(browser, nick);
  const { page } = joined;
  if (before) await before(page);
  await page.goto(FAST);
  await waitPlaying(page);
  return joined;
}

test('on a good network the delay drifts below 15 s, the status line shows it, and Go live still works', { tag: '@media' }, async ({ browser, browserName }) => {
  test.skip(browserName === 'firefox', 'checked on Chromium and WebKit');
  test.setTimeout(240_000);
  const nick = uid('delaygood');
  const { context, page } = await watchWithFastClock(browser, nick, async (p) => {
    if (browserName !== 'chromium') return;
    // A good home connection: 30 Mbps, 20 ms.
    const cdp = await p.context().newCDPSession(p);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: 30e6 / 8, uploadThroughput: 10e6 / 8 });
  });

  await expect.poll(async () => (await delayOf(page)).delay ?? 0, { timeout: 30_000 }).toBeGreaterThan(16);
  const start = await delayOf(page);
  expect(start.target).toBe(20);

  // "~N s behind live" next to the status, with its tooltip.
  const label = page.locator('[data-testid="delay"]');
  await expect(label).toHaveText(/^~\d+ s behind live$/);
  await expect(page.locator('#delay-wrap .tip-btn')).toHaveCount(1);
  await expect(page.locator('#tip-delay')).toContainText('adjusts itself to your connection');

  // Drifts down with a gentle catch-up (≤ the profile's limit), no stalls.
  let maxRate = 1;
  await expect
    .poll(
      async () => {
        const d = await delayOf(page);
        maxRate = Math.max(maxRate, d.playbackRate);
        return d.delay ?? 99;
      },
      { timeout: 120_000, intervals: [1000] },
    )
    .toBeLessThan(15);
  const low = await delayOf(page);
  expect(low.state).toBe('firm');
  expect(low.target).toBeLessThan(15);
  console.log('good network:', JSON.stringify({ start: start.delay, low: low.delay, target: low.target, stalls: low.stalls, stalledS: low.stalledS, holds: low.holds }));
  expect(low.stalls).toBeLessThanOrEqual(3);
  expect(maxRate).toBeGreaterThan(1);
  expect(maxRate).toBeLessThanOrEqual(low.rates.max);
  // The label refreshes once a second: poll it rather than read it once.
  await expect.poll(async () => Number(/\d+/.exec((await label.textContent()) ?? '')?.[0] ?? 99), { timeout: 10_000 }).toBeLessThanOrEqual(16);

  // The panel's viewers table gets each viewer's delay.
  await expect.poll(async () => (await viewerByNick(nick))?.delayS ?? 99, { timeout: 20_000 }).toBeLessThan(17);

  // "Go live" jumps to the (adaptive) live position and keeps playing.
  const goLive = page.locator('[data-testid="go-live"]');
  await expect(goLive).toBeVisible();
  await goLive.click();
  const t0 = await page.evaluate(() => document.querySelector('video')!.currentTime);
  await page.waitForFunction((t) => {
    const v = document.querySelector('video')!;
    return v.currentTime > t + 2 && !v.paused;
  }, t0, { timeout: 30_000 });
  const after = await delayOf(page);
  expect(after.delay!).toBeLessThan(after.target + 4);
  await expect(page.locator('#status')).toHaveText('Live');
  await context.close();
});

test('on a throttled, oscillating network the delay rises and stalls stay rare', { tag: '@media' }, async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'CDP network throttling is Chromium only');
  test.setTimeout(240_000);
  let cdp: CDPSession | null = null;
  const { context, page } = await watchWithFastClock(browser, uid('delayosc'), async (p) => {
    cdp = await p.context().newCDPSession(p);
    await cdp.send('Network.enable');
  });
  // 4G that keeps changing: 10 s at 5 Mbps / 60 ms, 10 s at 0.7 Mbps / 300 ms. The test stream
  // is ~1.3 Mbps, so the bad phases are below real time and the good ones refill the buffer.
  const good = { offline: false, latency: 60, downloadThroughput: 5e6 / 8, uploadThroughput: 2e6 / 8 };
  const bad = { offline: false, latency: 300, downloadThroughput: 0.7e6 / 8, uploadThroughput: 0.5e6 / 8 };
  await expect.poll(async () => (await delayOf(page)).delay ?? 0, { timeout: 30_000 }).toBeGreaterThan(16);
  const start = await delayOf(page);

  let maxRate = 1;
  let maxTarget = start.target;
  let last = start;
  // Three bad/good cycles: on this clock, enough to raise the target to the top of its range.
  const end = Date.now() + 60_000;
  for (let i = 0; Date.now() < end; i++) {
    await cdp!.send('Network.emulateNetworkConditions', i % 2 === 0 ? bad : good);
    for (let k = 0; k < 5; k++) {
      await page.waitForTimeout(2000);
      last = await delayOf(page);
      // Before the controller has seen the network wobble it may still catch up a little; once
      // it calls the network unstable it never speeds up.
      // (Above the upper bound it does catch up, to stay inside the playlist window.)
      if (last.state === 'unstable' && last.delay !== null && last.delay < 29.5) maxRate = Math.max(maxRate, last.playbackRate);
      maxTarget = Math.max(maxTarget, last.target);
    }
  }
  console.log('oscillating network:', JSON.stringify({ start: start.delay, end: last.delay, target: last.target, maxTarget, state: last.state, stalls: last.stalls, stalledS: last.stalledS, holds: last.holds }));
  expect(maxTarget).toBeGreaterThanOrEqual(26);
  expect(last.delay!).toBeGreaterThan(start.delay! + 3);
  expect(maxRate).toBeLessThanOrEqual(1);
  expect(last.stalls).toBeLessThanOrEqual(2);
  await context.close();
});
