// The attack shield end to end (checked on Chromium): a flood of made-up join links (~100
// requests a second for a few seconds) is detected, the panel shows it in the Protection card,
// and the shield turns on the stronger browser check (level 2), while real viewers still join:
// one who loaded the join page before the check was on (the server asks for it, the page solves
// and retries) and one who reloads (it solves proactively, "Checking your browser…"). The
// streamer ends the alert from the panel, and the security settings put back turn the light
// check on again. The always-on light check (the default) is switched off first, so the test
// sees the shield turn the check on.
//
// How long the attack-level check takes (about 0.3 s on a fast desktop, up to ~2 s on slow
// machines, docs/SECURITY_RESEARCH.md) is recorded as the `pow-ms` annotation, not asserted: a
// shared CI runner's speed is not what this test checks; the level is (counter > 0 at level 2).
// The gate (fixtures.ts) starts the test with fresh rate-limit buckets and, for the next test,
// empties the buckets this flood filled and ends the alert if an assertion failed first.
import { adminApi, adminState, expect, liveLink, openPanel, panelShows, test, uid, waitPlaying } from './fixtures.js';

test.skip(({ browserName }) => browserName !== 'chromium', 'checked on Chromium');

/** The flood: batches of made-up links, a pause between batches, at most this many requests. */
const FLOOD_BATCH = 30;
const FLOOD_PAUSE_MS = 300;
const FLOOD_MAX = 3000;

/**
 * Sends made-up join links until stop() (which resolves once the last batch is answered). The
 * flood is load, not a check: its answers and refused connections are not looked at, the
 * server's verdict is.
 */
function floodJoinLinks(baseURL: string): { stop(): Promise<number> } {
  let on = true;
  let sent = 0;
  const loop = (async () => {
    while (on && sent < FLOOD_MAX) {
      await Promise.all(
        Array.from({ length: FLOOD_BATCH }, () =>
          fetch(`${baseURL}/join/not-a-real-link-${sent++}`)
            .then((r) => r.arrayBuffer())
            .catch(() => null),
        ),
      );
      await new Promise((r) => setTimeout(r, FLOOD_PAUSE_MS));
    }
  })();
  return {
    stop: async () => {
      on = false;
      await loop;
      return sent;
    },
  };
}

test('a flood of invalid join links is detected, turns on the browser check, and real viewers still join', { tag: '@media' }, async ({ page, viewers, baseURL }) => {
  // Arrange
  test.setTimeout(180_000);
  const link = await liveLink();
  const settings = (await adminState()).security.settings;
  await adminApi('PUT', '/api/security', { ...settings, requireBrowserCheck: false });
  expect((await adminState()).security).toMatchObject({ threat: 'normal', browserCheck: 0 });
  const pageA = await viewers.atJoinPage({ link });
  await expect(pageA.locator('#check')).toBeHidden();
  const pageB = await viewers.atJoinPage({ link });
  const nickA = uid('before');
  const nickB = uid('during');

  // Act
  const flood = floodJoinLinks(baseURL!);
  await expect.poll(async () => (await adminState()).security.threat, { timeout: 30_000, intervals: [500] }).toBe('attack');
  await flood.stop();

  // Assert
  const during = await adminState();
  expect(during.warningCodes[0]).toMatchObject({ code: 'warn.attackDetected' });
  expect(during.security.browserCheck).toBe(2);
  expect(during.security.reasonCode).toMatch(/^attack\.reason\./);

  // Act
  await openPanel(page);

  // Assert
  await expect(page.getByTestId('threat')).toHaveAttribute('data-threat', 'attack');
  await expect(page.getByTestId('browser-check')).toHaveAttribute('data-level', '2');
  await expect(page.locator('.warn').first()).toContainText('Possible attack');

  // Act
  await pageA.fill('#nickname', nickA);
  const refusedA = pageA.waitForResponse((r) => r.url().endsWith('/api/join') && r.status() === 403);
  await pageA.click('#join');

  // Assert
  expect(((await (await refusedA).json()) as { code: string }).code).toBe('viewer.err.checkRequired');
  await expect(pageA).toHaveURL(/\/watch$/, { timeout: 20_000 });
  await waitPlaying(pageA);

  // Act
  const challenge = pageB.waitForResponse((r) => r.url().endsWith('/api/join/challenge'));
  await pageB.reload();

  // Assert
  expect(await (await challenge).json()).toMatchObject({ required: true });

  // Act
  await pageB.fill('#nickname', nickB);
  const request = pageB.waitForRequest((r) => r.url().endsWith('/api/join') && r.method() === 'POST');
  await pageB.click('#join');

  // Assert
  const body = (await request).postDataJSON() as { pow?: { solution?: { counter: number; time?: number } } };
  expect(body.pow?.solution?.counter).toBeGreaterThan(0);
  test.info().annotations.push({ type: 'pow-ms', description: String(body.pow?.solution?.time ?? 'unknown') });
  await expect(pageB).toHaveURL(/\/watch$/);

  // Act
  await panelShows(page, nickA);
  await panelShows(page, nickB);
  await page.getByTestId('end-alert').click();

  // Assert
  await expect(page.getByTestId('threat')).toHaveAttribute('data-threat', 'normal');
  expect((await adminState()).security).toMatchObject({ threat: 'normal', browserCheck: 0, tightened: false });

  // Act
  await adminApi('PUT', '/api/security', settings);

  // Assert
  expect((await adminState()).security.browserCheck).toBe(1);
});
