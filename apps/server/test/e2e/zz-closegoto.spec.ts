// DIAG probe (soak/webkit-goto-diag only): close a context whose watch page plays (streamer's page with an
// avatar: lock-screen artwork as a data: URL), reset the server like the gate does, then open a fresh
// context and goto. A goto with no answer in 15 s dumps every WebKit process (gdb) into RUN_DIR.
import { execSync } from 'node:child_process';
import path from 'node:path';
import { e2ePorts } from '../../../../scripts/test/lib/ports.mjs';
import { makePng, test, uid } from './fixtures.js';

const race = <T>(p: Promise<T>, ms: number, what: string): Promise<T | string> =>
  Promise.race([p, new Promise<string>((r) => setTimeout(() => r(`${what}: NO ANSWER in ${ms} ms`), ms))]);

test('probe close then goto', async ({ viewers, branding, baseURL }) => {
  test.setTimeout(1_500_000);
  await branding.save({ enabled: true, name: 'Zebulon', theme: { preset: 'ocean', corners: 'round' } });
  await branding.upload('avatar', makePng(256, 256), 'image/png');
  const control = `http://127.0.0.1:${e2ePorts().control}`;
  if (test.info().repeatEachIndex === 0) await new Promise((r) => setTimeout(r, 40_000)); // past the stream's first segments
  for (let i = 0; i < 100; i++) {
    const { page, context } = await viewers.join(`${uid('cg')}n${i}`);
    await page.waitForFunction(() => { const v = document.querySelector('video'); return !!v && !v.paused && v.currentTime > 0; }, null, { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(800 + (i % 7) * 300);
    if (i % 3 === 0) await page.evaluate(() => document.querySelector('video')?.pause());
    const closed = await race(context.close().then(() => 'closed'), 15_000, 'close');
    await fetch(`${control}/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ test: `probe ${i}` }) });
    const c2 = await viewers.browserContext();
    const p2 = await c2.newPage();
    const target = ['/', '/join', '/healthz'][i % 3]!;
    const r = await race(p2.goto(new URL(target, baseURL).toString()).then((x) => `status ${x?.status()}`), 15_000, 'goto');
    const stuck = typeof r === 'string' && r.includes('NO ANSWER');
    if (i % 25 === 0 || stuck || closed !== 'closed') console.log(`DIAG #${i} ${new Date().toISOString()} close=${closed} goto ${target}=${r}`);
    if (stuck) {
      execSync(`bash scripts/ci/diag-dumpall.sh '${path.join(process.env.RUN_DIR ?? 'test-results', `closegoto-${Date.now()}.txt`)}' 'probe ${i}'`, { stdio: 'inherit', timeout: 300_000 });
      const c3 = await viewers.browserContext();
      const p3 = await c3.newPage();
      console.log(`DIAG third context goto /healthz -> ${await race(p3.goto(new URL('/healthz', baseURL).toString()).then((x) => String(x?.status())), 15_000, 'goto')}`);
      console.log(`DIAG stuck goto later -> ${await race(p2.waitForLoadState('load').then(() => 'loaded'), 30_000, 'stuck goto')}`);
      throw new Error(`goto ${target} in a fresh context got no answer after closing a playing watch page (#${i})`);
    }
    await c2.close();
  }
});
