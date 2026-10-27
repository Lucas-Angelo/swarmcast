import { test } from '@playwright/test';
import { join, liveLink, reconnectObs } from './fixtures.js';

// WP1 CANARY (throwaway, reverted before the gate): fails on the first attempt and passes on the
// retry, so the job is flaky-green. The first attempt kills the fake OBS with a bad picture size
// (stderr in fake-obs.log) and joins with a nickname the server refuses (400 in the message).
test('WP1 canary: flaky join failure and a dead fake OBS', async ({ browser }, testInfo) => {
  if (testInfo.retry === 0) {
    reconnectObs({ size: 'bogus' });
    await new Promise((r) => setTimeout(r, 3000));
    reconnectObs(null);
    await liveLink();
    await join(browser, 'bad<>nick');
  }
  await liveLink();
});
