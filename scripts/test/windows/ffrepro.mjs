#!/usr/bin/env node
// Reproduction harness (soak branches only): app.mjs section 1's Firefox viewer, many rounds.
// A Chrome viewer plays with P2P on; each round launches a fresh Firefox, joins, waits for
// playback, turns P2P on and waits for P2P bytes, then closes Firefox. The first round that
// fails aborts the section, so the failure dump shows the pages and processes as it left them,
// plus (cleanup, before Firefox closes) the thread stacks of Firefox's processes when cdb exists.
//
// Usage: node scripts/test/windows/ffrepro.mjs --work <dir from make-release.mjs> [--rounds 30]
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  ART, check, info, installerResult, joinAndPlay, killUnder, launchBrowser, log, must, onCleanup, openPanel, opt, processes, ps, pushStream, repoRoot,
  runInstaller, section, serve, finish, stats, until, waitLiveLink, waitPhase, waitPlaylistForLateJoiners, startApp,
} from './lib.mjs';

const work = path.resolve(opt('work', path.join(repoRoot, 'release', 'win-e2e')));
const rounds = Number(opt('rounds', '30'));
/** Seconds a round's Firefox is up before it joins (app.mjs section 1: about 60). */
const ageS = Number(opt('age', '0'));
/** Whether an Edge viewer joins, gets P2P bytes from Chrome and leaves while Firefox waits (as in app.mjs). */
const withEdge = opt('edge', 'no') === 'yes';
/** Busy-loop processes kept running from Firefox's launch to the end of the round (CPU starvation, to expose races). */
const stressN = Number(opt('stress', '0'));
const burn = () => Array.from({ length: stressN }, () => spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore', windowsHide: true }));
const relDir = path.join(work, 'rel');
const home = path.join(process.env.LOCALAPPDATA, 'SwarmCast');
const srv = await serve(relDir);
const CDB = ['C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x64\\cdb.exe', 'C:\\Program Files\\Windows Kits\\10\\Debuggers\\x64\\cdb.exe'].find((f) => fs.existsSync(f));

/** Thread stacks of every Firefox child under `browserPid` (noninvasive cdb attach), into the artifacts. */
function firefoxStacks(tag) {
  if (!CDB) {
    log('no cdb.exe on this runner: no thread stacks');
    return;
  }
  const kids = processes().filter((p) => /^firefox\.exe$/i.test(p.name));
  for (const p of kids) {
    const role = /-contentproc/.test(p.cmd) ? (/\s(\d+ \w+)\s*$/.exec(p.cmd)?.[1] ?? 'child') : 'parent';
    const r = spawnSync(CDB, ['-pv', '-p', String(p.pid), '-c', '.symfix+ C:\\sym; .reload; !runaway 7; ~*kn 40; q'], { encoding: 'utf8', timeout: 240_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    const file = path.join(ART, `ffrepro-stacks-${tag}-${p.pid}-${role.replace(/\s+/g, '_')}.txt`);
    fs.writeFileSync(file, `${p.pid} ${role}\n${r.stdout ?? ''}\n${r.stderr ?? ''}${r.error ? `\nerror: ${r.error.message}` : ''}`);
    log(`stacks of firefox ${p.pid} (${role}): ${path.basename(file)}`);
  }
}

await section('0. install into the default data folder', async () => {
  fs.rmSync(home, { recursive: true, force: true });
  const r = await installerResult(runInstaller({ entry: 'ps', dir: relDir, releaseUrl: srv.url, args: ['-Yes', '-SkipSpeedtest', '-InstallOnly'], label: 'install' }));
  must('installed', r.code === 0, `exit ${r.code}`);
  info('cdb', CDB ?? 'none');
  info('cpu', ps('(Get-CimInstance Win32_Processor | Select-Object -First 1).Name', { allowFail: true }));
});

await section('1. Firefox joins next to a Chrome viewer, round after round', async () => {
  const chrome = await launchBrowser('chrome');
  const app = await startApp({ entry: 'ps', dir: relDir, releaseUrl: srv.url, home: undefined, args: ['-Yes', '-SkipSpeedtest', '-NoTunnel'], label: 'local' });
  onCleanup(() => killUnder(home));
  const s0 = await waitLiveLink(app);
  pushStream(s0.rtmpUrl, s0.streamKey);
  await waitPhase(app, 'live');
  const early = await joinAndPlay(chrome, s0.liveLink, 'early-chrome');
  await openPanel(chrome, app.loginUrl);
  await early.page.check('#p2p');
  await waitPlaylistForLateJoiners(early.page);
  for (let i = 1; i <= rounds; i++) {
    const burners = burn();
    onCleanup(() => burners.forEach((b) => b.kill()));
    const firefox = await launchBrowser('firefox');
    const launchedAt = Date.now();
    if (withEdge) {
      const edge = await launchBrowser('msedge');
      const e = await joinAndPlay(edge, s0.liveLink, `edge${i}`);
      await e.page.check('#p2p');
      await until(async () => {
        const s = await stats(e.page);
        return s.p2pDownBytes + s.p2pUpBytes > 0;
      }, 150_000, 'P2P bytes Chrome<->Edge');
      await e.context.close();
      await edge.close();
    }
    const left = launchedAt + ageS * 1000 - Date.now();
    if (left > 0) await new Promise((r) => setTimeout(r, left));
    let f = null;
    let failed = true;
    onCleanup(async () => {
      if (!failed) return;
      firefoxStacks(`round${i}`);
      if (f) {
        const later = await Promise.race([f.page.evaluate(() => `${location.href} t=${document.querySelector('video')?.currentTime}`), new Promise((r) => setTimeout(() => r('no answer in 10 s'), 10_000))]).catch((e) => e.message);
        log(`round ${i}: the Firefox page after the dump: ${later}`);
      }
      const c0 = Date.now();
      await firefox.close().catch((e) => log(`round ${i}: closing Firefox: ${e.message}`));
      log(`round ${i}: closing the failed Firefox took ${((Date.now() - c0) / 1000).toFixed(1)} s`);
    });
    const t0 = Date.now();
    f = await joinAndPlay(firefox, s0.liveLink, `ff${i}`);
    const played = Date.now();
    await f.page.check('#p2p');
    const sf = await until(async () => {
      const s = await stats(f.page);
      return s.p2pDownBytes + s.p2pUpBytes > 0 ? s : null;
    }, 150_000, 'P2P bytes Chrome<->Firefox');
    failed = false;
    check('Firefox joins, plays, turns P2P on and gets P2P bytes', true, `round ${i}: Firefox up ${((t0 - launchedAt) / 1000).toFixed(0)} s, plays after ${((played - t0) / 1000).toFixed(1)} s, P2P down ${Math.round(sf.p2pDownBytes / 1e3)} KB`);
    burners.forEach((b) => b.kill());
    const c0 = Date.now();
    await f.context.close();
    await firefox.close();
    if (Date.now() - c0 > 10_000) log(`round ${i}: closing Firefox took ${((Date.now() - c0) / 1000).toFixed(1)} s`);
  }
});

await srv.close();
finish();
