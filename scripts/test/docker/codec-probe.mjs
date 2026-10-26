// Prints which H.264/AAC MSE types Playwright's bundled browsers support on this machine.
// Run from the repo root (needs node_modules): node scripts/test/docker/codec-probe.mjs
import { chromium, firefox, webkit } from '@playwright/test';

const types = [
  'video/mp4; codecs="avc1.42E01E"',
  'video/mp4; codecs="avc1.64001F"',
  'audio/mp4; codecs="mp4a.40.2"',
  'video/mp4; codecs="avc1.64001F, mp4a.40.2"',
];

for (const [name, type] of [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]]) {
  let browser;
  try {
    browser = await type.launch();
    const page = await browser.newPage();
    const res = await page.evaluate((ts) => {
      const v = document.createElement('video');
      return ts.map((t) => ({
        t,
        mse: typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(t),
        canPlay: v.canPlayType(t) || 'no',
      }));
    }, types);
    console.log(`${name} ${browser.version()}`);
    for (const r of res) console.log(`  ${r.mse ? 'MSE yes' : 'MSE no '}  canPlayType=${r.canPlay.padEnd(8)} ${r.t}`);
  } catch (err) {
    console.log(`${name}: could not launch (${err.message.split('\n')[0]})`);
  } finally {
    await browser?.close();
  }
}
