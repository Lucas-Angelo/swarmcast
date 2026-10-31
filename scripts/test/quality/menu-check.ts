// Browser check of the new viewer modules against the quality server: bundles
// player-config + quality-menu + latency-toggle with hls.js (esbuild), plays the ladder and
// exercises the menu and the Stable/Lower-delay switch.
//   node --import tsx scripts/test/quality/menu-check.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { loopbackBase, panelLogin } from '../lib/loopback.mjs';
import { FIXED_PORTS } from '../lib/ports.mjs';

type W = Window & {
  __hls: { levels: Array<{ height: number }>; currentLevel: number; autoLevelEnabled: boolean; latency: number; targetLatency: number };
  __swarm(h: number): string;
};

const root = path.resolve(import.meta.dirname, '../../..');
// The quality server's test control port (FIXED_PORTS.quality.control, as in server.ts): GET /env gives the
// panel's address and login path, checked by panelLogin().
const env = (await (await fetch(new URL('/env', loopbackBase(`http://127.0.0.1:${FIXED_PORTS.quality.control}`)))).json()) as { adminUrl: string; adminLoginPath: string; base: string; readyAt: number };
const admin = panelLogin(env);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-menu-'));
const entry = path.join(tmp, 'entry.ts');
fs.writeFileSync(
  entry,
  `import Hls from 'hls.js';
import { hlsConfigFor, streamSwarmIdBuilder } from ${JSON.stringify(path.join(root, 'apps/viewer/src/player-config.ts'))};
import { createQualityMenu } from ${JSON.stringify(path.join(root, 'apps/viewer/src/quality-menu.ts'))};
import { createLatencyToggle } from ${JSON.stringify(path.join(root, 'apps/viewer/src/latency-toggle.ts'))};
(async () => {
  const conf = await (await fetch('/api/config')).json();
  const video = document.querySelector('video')!;
  const hls = new Hls(hlsConfigFor('stable', { isMobile: false, initialEstimate: 20_000_000 }));
  const box = document.getElementById('controls')!;
  createQualityMenu(hls, box, Hls.Events);
  createLatencyToggle(box, { hls, engine: null }, { isMobile: false });
  (window as unknown as W).__hls = hls;
  (window as unknown as W).__swarm = (h: number) => streamSwarmIdBuilder({ swarmId: 'x', streamType: 'main', properties: { height: h } } as never);
  hls.loadSource(conf.playlistUrl);
  hls.attachMedia(video);
  hls.on(Hls.Events.MANIFEST_PARSED, () => void video.play().catch(() => {}));
})();`,
);
const bundle = await build({ entryPoints: [entry], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'chrome120', nodePaths: [path.join(root, 'node_modules')], loader: { '.css': 'css' }, outdir: tmp });
const js = bundle.outputFiles.find((f) => f.path.endsWith('.js'))!.text;
const css = bundle.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '';

const cookie = (await fetch(admin.loginUrl, { redirect: 'manual' })).headers.getSetCookie()[0]!.split(';')[0]!;
const state = (await (await fetch(new URL('/api/state', admin.base), { headers: { cookie } })).json()) as { liveLink: string };
const browser = await chromium.launch({ channel: process.env.PW_CHROMIUM_CHANNEL ?? 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext();
const page = await context.newPage();
await page.route('**/__menu', (r) => r.fulfill({ contentType: 'text/html', body: `<!doctype html><style>${css}</style><video muted playsinline style="width:960px;height:540px"></video><div id="controls" class="player-controls"></div><script src="/__menu.js"></script>` }));
await page.route('**/__menu.js', (r) => r.fulfill({ contentType: 'text/javascript', body: js }));
await page.goto(state.liveLink);
await context.request.post(`${env.base}/api/join`, { data: { nickname: 'menu-check' } });
await page.goto(`${env.base}/__menu`);
await page.waitForFunction(() => (document.querySelector('video') as HTMLVideoElement).currentTime > 1, null, { timeout: 60_000 });

await page.waitForTimeout(3000);
const options = await page.$$eval('.quality-menu option', (os) => os.map((o) => o.textContent));
const result: Record<string, unknown> = { options };
await page.selectOption('.quality-menu', { label: '480p' });
await page.waitForFunction(() => {
  const h = (window as unknown as W).__hls;
  return h.levels[h.currentLevel]?.height === 480;
}, null, { timeout: 30_000 });
result.after480 = await page.evaluate(() => ({ height: (window as unknown as W).__hls.levels[(window as unknown as W).__hls.currentLevel].height, auto: (window as unknown as W).__hls.autoLevelEnabled, saved: localStorage.getItem('sc.quality-height') }));
await page.selectOption('.quality-menu', { value: '-1' });
result.backToAuto = await page.evaluate(() => (window as unknown as W).__hls.autoLevelEnabled);
result.latencyStable = await page.evaluate(() => Math.round((window as unknown as W).__hls.latency));
await page.check('.latency-toggle input[value="low-delay"]');
await page.waitForTimeout(8000);
result.lowDelay = await page.evaluate(() => ({ target: (window as unknown as W).__hls.targetLatency, latency: Math.round((window as unknown as W).__hls.latency), saved: localStorage.getItem('sc.playback-profile') }));
result.swarmIds = await page.evaluate(() => [(window as unknown as W).__swarm(1080), (window as unknown as W).__swarm(480)]);
console.log(JSON.stringify(result, null, 2));
await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });
