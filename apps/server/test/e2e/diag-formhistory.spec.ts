// DIAG (soak only, not for merge): Firefox form history across the contexts of one browser, with
// the harness's preferences and with form history off, on a page of its own (no server).
import { firefox, test } from '@playwright/test';
import { firefoxEnv } from '../../../../scripts/test/lib/firefox.mjs';

const PAGE = `<!doctype html><meta charset="utf-8"><body style="margin:40px;font:16px sans-serif">
<form id="f" novalidate>
<input id="nickname" name="nickname" maxlength="64" autocomplete="nickname" required autofocus style="display:block;width:354px;height:48px;box-sizing:border-box">
<button id="join" type="submit" style="display:block;width:354px;height:48px;margin-top:16px">Watch</button>
</form><script>
window.__ev = [];
for (const t of ['pointerdown', 'pointerup', 'click', 'submit']) addEventListener(t, () => window.__ev.push(t), true);
document.getElementById('f').addEventListener('submit', (e) => e.preventDefault());
</script>`;

test('DIAG FH form history across contexts, with and without browser.formfill.enable', async ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'firefox');
  test.setTimeout(240_000);
  for (const formfill of [true, false]) {
    const browser = await firefox.launch({ env: firefoxEnv(), firefoxUserPrefs: { 'browser.formfill.enable': formfill } });
    const open = async () => {
      const c = await browser.newContext();
      await c.route('http://fh.test/**', (r) => r.fulfill({ contentType: 'text/html', body: PAGE }));
      const p = await c.newPage();
      await p.goto('http://fh.test/');
      return { c, p };
    };
    // Seed: one context types names and presses Watch (the page cancels the submit).
    const seed = await open();
    for (const name of ['Ana\u{1F600}', 'Alice-probe', 'aaaaaaaaaaaaaaaaaaaaaaaaa']) {
      await seed.p.fill('#nickname', name);
      await seed.p.click('#join');
    }
    await seed.c.close();
    // 1. ArrowDown in a new context: does Firefox offer what the other context typed?
    const probe = await open();
    await probe.p.locator('#nickname').pressSequentially('A');
    await probe.p.waitForTimeout(1500);
    await probe.p.keyboard.press('ArrowDown');
    await probe.p.waitForTimeout(300);
    const v1 = await probe.p.inputValue('#nickname');
    await probe.p.keyboard.press('ArrowDown');
    await probe.p.waitForTimeout(300);
    const v2 = await probe.p.inputValue('#nickname');
    await probe.c.close();
    // 2. Type "A" and press Watch at once, as nickname.spec does: how many presses are lost?
    let lost = 0;
    const N = 20;
    for (let i = 0; i < N; i++) {
      const { c, p } = await open();
      await p.locator('#nickname').pressSequentially('A');
      await p.click('#join');
      await p.waitForTimeout(200);
      const ev = (await p.evaluate(() => (window as unknown as { __ev: string[] }).__ev)) as string[];
      if (!ev.includes('submit')) lost++;
      if (!ev.includes('submit')) console.log(`DIAGFH2 formfill=${formfill} run ${i} events ${JSON.stringify(ev)}`);
      await c.close();
    }
    console.log(`DIAGFH2 ${process.platform} formfill=${formfill}: ArrowDown -> ${JSON.stringify(v1)}, again -> ${JSON.stringify(v2)}; lost presses ${lost}/${N}`);
    await browser.close();
  }
});
