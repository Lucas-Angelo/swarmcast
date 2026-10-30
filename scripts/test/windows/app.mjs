#!/usr/bin/env node
// SwarmCast on Windows, installed by the real start script into the DEFAULT data folder
// (%LOCALAPPDATA%\SwarmCast) and always started through it with a bare-OS PATH:
//  - local mode with Google Chrome, Microsoft Edge and Firefox viewers, P2P Chrome<->Edge and
//    Chrome<->Firefox, viewer joining before the stream, viewer count, Go-live, kick, new link,
//    "Stop everything" (API and panel button), Quit from the panel, tray helper, loopback-only sockets
//  - pt-BR UI, session cap (maxViewers=2 -> "full"), auto-stop
//  - real Cloudflare quick tunnel with the three browsers
//  - taskkill /F of the app (reaper), console window close (a real click on its X), Ctrl+C, Ctrl+Break
//
// Usage: node scripts/test/windows/app.mjs --work <dir from make-release.mjs> [--out results.json]
//        [--close-method auto|click|uia|post] (how section 5 closes the console window; default auto)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  ART, appLog, appProcess, check, copyAppLogs, describeProcs, editConfig, environmentFacts, finish, here, info, installerResult, isLoopback, join, joinAndPlay,
  killTree, killUnder, launchBrowser, listening, must, onCleanup, openPanel, opt, orTimeout, peSubsystem, pkgVersion, powershellExe, probe, processes, processesUnder,
  ps, pushStream, quitAndVerify, readText, record, renderedTwice, uninstallAndVerify, uploadCapCheck, repoRoot, runInstaller, section, serve, socketsOf, startApp, stats, ui, until,
  waitLiveLink, waitPhase, waitPlaying, waitPlaylistForLateJoiners, bareEnv,
} from './lib.mjs';

const work = path.resolve(opt('work', path.join(repoRoot, 'release', 'win-e2e')));
const V = opt('version', pkgVersion());
const relDir = path.join(work, 'rel');
const home = path.join(process.env.LOCALAPPDATA, 'SwarmCast');
const srv = await serve(relDir);
const start = (args = ['-Yes', '-SkipSpeedtest', '-NoTunnel'], label = 'start') => startApp({ entry: 'ps', dir: relDir, releaseUrl: srv.url, home: undefined, args, label });
/**
 * How far a paused viewer falls behind hls.js' live target before the Go-live check resumes it:
 * the viewer offers "Go live" from 4 s (two segments) behind, and the two seconds more keep it
 * offered while playback resumes. Far inside MediaMTX's window and hls.js' 36 s maximum, past
 * which hls.js would jump back to live by itself.
 */
const GO_LIVE_BEHIND_S = 6;
const resetConfig = (fn) =>
  editConfig(home, (c) => {
    delete c.maxViewers;
    delete c.autoStopMinutes;
    fn?.(c);
  });

await section('0. environment + install into the default data folder', async () => {
  for (const [k, v] of Object.entries(environmentFacts())) info(k, v);
  fs.rmSync(home, { recursive: true, force: true });
  const r = await installerResult(runInstaller({ entry: 'ps', dir: relDir, releaseUrl: srv.url, args: ['-Yes', '-SkipSpeedtest', '-InstallOnly'], label: 'install' }));
  must('installed into %LOCALAPPDATA%\\SwarmCast (no SWARMCAST_HOME)', r.code === 0 && fs.existsSync(path.join(home, 'app', 'current', 'swarmcast.exe')), `exit ${r.code}`);
  const tray = path.join(home, 'app', 'current', 'bin', 'swarmcast-tray.exe');
  if (fs.existsSync(tray)) {
    const sub = peSubsystem(tray);
    check('tray helper is a GUI-subsystem exe (no console window flashes)', sub === 2, `PE subsystem ${sub} (2 = GUI, 3 = console)`);
  } else record('tray helper shipped in the package', 'fail', tray);
  info('swarmcast.exe PE subsystem', `${peSubsystem(path.join(home, 'app', 'current', 'swarmcast.exe'))} (3 = console: it runs in the start script's window)`);
});

await section('1. local mode: Chrome, Edge, Firefox, P2P, Go-live, kick, new link, stop, quit, tray', async () => {
  resetConfig();
  const chrome = await launchBrowser('chrome');
  const edge = await launchBrowser('msedge');
  const firefox = await launchBrowser('firefox');
  const startedAt = Date.now();
  const app = await start(undefined, 'local');
  onCleanup(() => killUnder(home));
  const s0 = await waitLiveLink(app);
  check('live link is local (-NoTunnel)', /^http:\/\/127\.0\.0\.1:\d+\/join\//.test(s0.liveLink));
  check('installed version runs', s0.version === V, s0.version);

  // Viewer joins BEFORE OBS sends anything.
  const early = await join(chrome, s0.liveLink, 'early-chrome');
  await early.page.waitForURL(/\/watch$/, { timeout: 60_000 });
  const waitingText = ui('en', 'watch.waiting');
  await early.page.waitForFunction((t) => document.getElementById('overlay')?.textContent?.includes(t), waitingText, { timeout: 30_000 });
  check('viewer who joined before the stream sees "Waiting for the stream…"', true);

  const feed = pushStream(s0.rtmpUrl, s0.streamKey);
  await waitPhase(app, 'live');
  check('OBS-like RTMP stream accepted (phase live)', true);
  await waitPlaying(early.page, 90_000);
  check('early viewer starts playing by itself once the stream starts (Chrome)', true);

  const panel = await openPanel(chrome, app.loginUrl);
  // First-run setup tutorial (modal): opens by itself on a fresh install, walk it to the end.
  const onb = panel.page.locator('[data-testid=onboarding]');
  const hasOnb = fs.existsSync(path.join(repoRoot, 'apps', 'admin', 'src', 'onboarding'));
  if (hasOnb) {
    const opened = await onb.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false);
    check('first-run setup tutorial opens by itself on a fresh install', opened);
    if (opened) {
      let n = 1;
      while ((await panel.page.locator('[data-testid=onb-finish]').count()) === 0 && n < 20) {
        await panel.page.click('[data-testid=onb-next]');
        n++;
      }
      await panel.page.click('[data-testid=onb-finish]');
      const closed = await onb.waitFor({ state: 'hidden', timeout: 10_000 }).then(() => true, () => false);
      const done = (await app.api('/api/onboarding')).done === true;
      check('setup tutorial can be walked to the end and is remembered', closed && done, `${n} steps`);
    }
  }
  await panel.page.waitForFunction(() => /Mbps|sending|enviando/i.test(document.querySelector('[data-testid=obs-status]')?.textContent ?? ''), null, { timeout: 30_000 });
  check('panel shows OBS sending', true, await panel.page.textContent('[data-testid=obs-status]'));

  // Loopback only: nothing SwarmCast runs should trigger a Windows Firewall prompt in secure mode.
  const pids = processesUnder(home).map((p) => p.pid);
  const socks = socketsOf(pids);
  const exposed = socks.tcp.filter((t) => !isLoopback(t.LocalAddress));
  check('every TCP listener of SwarmCast/MediaMTX is on 127.0.0.1 (no firewall prompt)', exposed.length === 0, socks.tcp.map((t) => `${t.LocalAddress}:${t.LocalPort}`).join(' '));
  info('UDP endpoints of SwarmCast processes', socks.udp.map((t) => `${t.LocalAddress}:${t.LocalPort}`).join(' ') || 'none');

  // Tray helper (needs the runner's interactive desktop). The server logs "tray icon ready" when
  // the helper reports its icon up (apps/server/src/tray/tray.ts), well within a second of the
  // start; "tray helper exited" when it died (restarted once, then panel only). Only this run's
  // lines count (pino's "time", against the start: --repeat runs this section again).
  const trayProc = processesUnder(home).find((p) => /swarmcast-tray/i.test(p.name));
  check('tray helper running next to the app', !!trayProc, describeProcs(processesUnder(home)));
  const trayLines = () => appLog(home).split('\n').filter((l) => /tray/.test(l) && Number(/"time":(\d+)/.exec(l)?.[1]) >= startedAt);
  const trayReady = await until(() => trayLines().some((l) => l.includes('"msg":"tray icon ready"')), 30_000, '"tray icon ready" in the app log').then(() => true, () => false);
  const trayExits = trayLines().filter((l) => l.includes('tray helper exited'));
  check('tray helper reports "tray icon ready" and never exited', trayReady && trayExits.length === 0, trayReady && !trayExits.length ? 'icon up in the runner session' : `tray lines: ${trayLines().slice(-4).join(' ') || 'none'}`);

  await uploadCapCheck(app, 'panel with one viewer');

  // Edge + Chrome P2P (Firefox not joined yet): Edge must start on segments Chrome already played.
  await waitPlaylistForLateJoiners(early.page);
  const e = await joinAndPlay(edge, s0.liveLink, 'edge');
  check('viewer plays in Microsoft Edge', true, edge.version());
  await early.page.check('#p2p');
  await e.page.check('#p2p');
  const p2pEdge = await until(async () => {
    const se = await stats(e.page);
    return se.p2pDownBytes + se.p2pUpBytes > 0 ? se : null;
  }, 150_000, 'P2P bytes Chrome<->Edge').catch((err) => err);
  const sc = await stats(early.page);
  check('P2P Chrome<->Edge (hash-verified)', !(p2pEdge instanceof Error) && p2pEdge.hashFailures + sc.hashFailures === 0, p2pEdge instanceof Error ? p2pEdge.message : `Edge down ${Math.round(p2pEdge.p2pDownBytes / 1e3)} KB / up ${Math.round(p2pEdge.p2pUpBytes / 1e3)} KB, hash failures 0`);

  // Viewer count badge with 2 viewers.
  await early.page.waitForFunction(() => /\b2\b/.test(document.querySelector('[data-testid=viewer-count]')?.textContent ?? ''), null, { timeout: 30_000 }).then(
    async () => check('viewer count badge shows 2', true, await early.page.textContent('[data-testid=viewer-count]')),
    async () => check('viewer count badge shows 2', false, await early.page.textContent('[data-testid=viewer-count]').catch(() => '?')),
  );
  await e.context.close();

  // Firefox + Chrome P2P.
  const f = await joinAndPlay(firefox, s0.liveLink, 'firefox').catch((err) => err);
  if (f instanceof Error) {
    record('viewer plays in Firefox', 'fail', f.message);
  } else {
    check('viewer plays in Firefox', true, firefox.version());
    await f.page.check('#p2p');
    const p2pFf = await until(async () => {
      const sf = await stats(f.page);
      return sf.p2pDownBytes + sf.p2pUpBytes > 0 ? sf : null;
    }, 150_000, 'P2P bytes Chrome<->Firefox').catch((err) => err);
    const sc2 = await stats(early.page);
    check('P2P Chrome<->Firefox (hash-verified)', !(p2pFf instanceof Error) && p2pFf.hashFailures + sc2.hashFailures === 0, p2pFf instanceof Error ? p2pFf.message : `Firefox down ${Math.round(p2pFf.p2pDownBytes / 1e3)} KB / up ${Math.round(p2pFf.p2pUpBytes / 1e3)} KB`);
  }

  // Go-live button. The default Stable profile targets ~20 s behind the newest video, and a
  // viewer who joined before the stream sits much closer than that (it started on the first
  // segments): paused, it falls behind its live target as the live goes on (GO_LIVE_BEHIND_S).
  const gl = early.page.locator('[data-testid=go-live]');
  await early.page.waitForFunction(() => document.querySelector('[data-testid=go-live]')?.classList.contains('at-live'), null, { timeout: 20_000 });
  const lat0 = await early.page.evaluate(() => {
    const v = document.querySelector('video');
    return v.seekable.length ? v.seekable.end(v.seekable.length - 1) - v.currentTime : 0;
  });
  const tPause = Date.now();
  await early.page.evaluate(() => document.querySelector('video').pause());
  await early.page.waitForFunction((min) => Number(document.querySelector('[data-testid=go-live]')?.dataset.behind || 0) >= min, GO_LIVE_BEHIND_S, { timeout: 60_000, polling: 250 });
  const pausedS = (Date.now() - tPause) / 1000;
  // play() resolves after the 'playing' event, whose listener in the page updates the button.
  await early.page.evaluate(() => Promise.race([document.querySelector('video').play(), new Promise((_, fail) => setTimeout(() => fail(new Error('playback did not resume within 15 s')), 15_000))]));
  const behind = await gl.getAttribute('data-behind');
  const notAtLive = !(await gl.evaluate((el) => el.classList.contains('at-live')));
  await gl.click();
  const back = await early.page.waitForFunction(() => document.querySelector('[data-testid=go-live]')?.classList.contains('at-live'), null, { timeout: 15_000 }).then(() => true, () => false);
  check('Go-live: after a pause it offers "Go live", one click returns to the live edge', notAtLive && back, `${lat0.toFixed(1)} s from the edge, paused ${pausedS.toFixed(1)} s (until ${GO_LIVE_BEHIND_S} s behind the live target), ${behind} s behind it before the click`);

  // Kick (Firefox if it joined, else a new Edge viewer).
  const victim = f instanceof Error ? await joinAndPlay(edge, s0.liveLink, 'kick-me') : f;
  const victimName = f instanceof Error ? 'kick-me' : 'firefox';
  const st = await app.state();
  const sess = st.viewers.find((v) => v.nickname === victimName);
  await app.api(`/api/viewers/${sess.sessionId}/kick`, {});
  await victim.page.waitForSelector('#ended:not([hidden])', { timeout: 20_000 });
  await victim.page.goto(s0.liveLink);
  check(`kick stops playback (${victimName}) and the same link is refused for that browser`, /no longer valid|não vale mais|inválid/i.test(await victim.page.textContent('body')));
  await victim.context.close();

  // New link.
  const rot = await app.api('/api/link/rotate', {});
  const o = await chrome.newContext();
  const op = await o.newPage();
  await op.goto(s0.liveLink);
  const oldRefused = /no longer valid/i.test(await op.textContent('body'));
  await o.close();
  const nv = await joinAndPlay(chrome, rot.liveLink, 'new-link');
  check('"Generate new link": old link refused, new link plays', oldRefused && rot.liveLink !== s0.liveLink);
  await nv.context.close();
  check('early viewer kept playing through link rotation', await early.page.evaluate(() => !document.querySelector('video').paused));

  // Stop everything through the API (returns the verification).
  const stop = await app.api('/api/live/stop', {});
  check('"Stop everything" verified', stop.verified === true, JSON.stringify((await app.state()).steps.map((x) => `${x.id}:${x.status}`)));
  await early.page.waitForSelector('#ended:not([hidden])', { timeout: 20_000 }).then(
    () => check('viewer sees "The stream has ended"', true),
    () => check('viewer sees "The stream has ended"', false),
  );
  check('MediaMTX gone and port 1935 closed after stop', !processesUnder(home).some((p) => /mediamtx/i.test(p.name)) && !(await listening(1935)));
  feed.stop();

  // Turn on again from the panel button, then "Stop everything" button, then Quit from the panel.
  await panel.page.click('[data-testid=start]');
  await waitLiveLink(app);
  check('panel "Turn on" button starts again', true);
  await panel.page.click('[data-testid=stop]');
  await until(async () => (await app.state()).phase === 'off', 60_000, 'off after panel stop');
  const steps = (await app.state()).steps;
  check('panel "Stop everything" button: all stop steps ok', steps.every((x) => x.status === 'ok'), steps.map((x) => `${x.id}:${x.status}`).join(' '));
  const trayPid = processesUnder(home).find((p) => /swarmcast-tray/i.test(p.name))?.pid;
  await panel.page.getByRole('button', { name: ui('en', 'admin.quit') ?? 'Quit', exact: true }).click();
  await quitAndVerify(app, home, 'quit from the panel', { via: 'none' });
  if (trayPid) check('tray helper exits with the app', !processes().some((p) => p.pid === trayPid));
  copyAppLogs(home, 'local');
});

await section('2. pt-BR UI, session cap (maxViewers=2 -> "full"), auto-stop', async () => {
  resetConfig((c) => {
    c.maxViewers = 2;
    c.autoStopMinutes = 0.5;
  });
  const chrome = await launchBrowser('chrome');
  const edge = await launchBrowser('msedge');
  const firefox = await launchBrowser('firefox');
  const app = await start(undefined, 'ptbr-cap');
  onCleanup(() => killUnder(home));
  const s0 = await waitLiveLink(app);
  const feed = pushStream(s0.rtmpUrl, s0.streamKey);
  await waitPhase(app, 'live');

  const pt = { locale: 'pt-BR' };
  const a = await join(chrome, s0.liveLink, 'ana', pt);
  check('pt-BR join page in Portuguese', true);
  await a.page.waitForURL(/\/watch$/, { timeout: 60_000 });
  await waitPlaying(a.page);
  await a.page.waitForFunction((t) => document.getElementById('status')?.textContent === t, ui('pt-BR', 'watch.live'), { timeout: 30_000 }).then(
    () => check('pt-BR watch page: status "Ao vivo"', true),
    async () => check('pt-BR watch page: status "Ao vivo"', false, await a.page.textContent('#status')),
  );
  const ptPanel = await openPanel(chrome, app.loginUrl, 'panel-ptbr', pt);
  if (fs.existsSync(path.join(repoRoot, 'apps', 'admin', 'src', 'onboarding'))) {
    // The panel asks /api/onboarding once as it loads and opens the tutorial from the answer:
    // the check comes after that answer arrived and two frames were rendered since.
    await ptPanel.page.waitForFunction(() => performance.getEntriesByType('resource').some((e) => new URL(e.name).pathname === '/api/onboarding' && e.responseEnd > 0), null, { timeout: 30_000, polling: 100 });
    await renderedTwice(ptPanel.page);
    check('setup tutorial does not reopen after it was finished (new browser profile)', !(await ptPanel.page.locator('[data-testid=onboarding]').isVisible()));
  }
  const stopLabel = ui('pt-BR', 'admin.stopAll');
  check('pt-BR panel in Portuguese', (await ptPanel.page.textContent('[data-testid=stop]'))?.includes(stopLabel), `stop button: ${await ptPanel.page.textContent('[data-testid=stop]')}`);

  await joinAndPlay(edge, s0.liveLink, 'bia');
  const third = await join(firefox, s0.liveLink, 'caio', pt);
  const fullText = ui('pt-BR', 'viewer.err.full');
  await third.page.waitForSelector('#error:not([hidden])', { timeout: 30_000 }).catch(() => {});
  const errText = (await third.page.textContent('#error').catch(() => '')) ?? '';
  check('third viewer refused with "full" (maxViewers=2), in Portuguese', errText.includes(fullText), `error shown: "${errText}"`);
  check('panel counts 2 viewers', (await app.state()).viewers.length === 2);

  // Auto-stop: OBS stops sending; everything turns off after autoStopMinutes (0.5 min here).
  feed.stop();
  const t0 = Date.now();
  await waitPhase(app, 'off', 120_000);
  const secs = Math.round((Date.now() - t0) / 1000);
  const act = await app.api('/api/activity');
  const entries = Array.isArray(act) ? act : (act.entries ?? []);
  check('auto-stop turns everything off after the configured time without video', entries.some((x) => x.code === 'log.autoStop'), `${secs} s after the feed stopped`);
  check('after auto-stop: MediaMTX gone, 1935 closed, app still running', !processesUnder(home).some((p) => /mediamtx/i.test(p.name)) && !(await listening(1935)) && !!appProcess(home));
  await quitAndVerify(app, home, 'pt-BR/cap/auto-stop');
  copyAppLogs(home, 'ptbr');
});

await section('3. real Cloudflare quick tunnel: Chrome, Edge, Firefox', async () => {
  resetConfig();
  const browsers = [await launchBrowser('chrome'), await launchBrowser('msedge'), await launchBrowser('firefox')];
  const app = await start(['-Yes', '-SkipSpeedtest'], 'tunnel');
  onCleanup(() => killUnder(home));
  const s0 = await waitLiveLink(app, 180_000);
  must('live link on trycloudflare.com', /^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/join\//.test(s0.liveLink), s0.liveLink.replace(/\/join\/.*/, ''));
  const feed = pushStream(s0.rtmpUrl, s0.streamKey);
  await waitPhase(app, 'live');
  // Once each, no retry: a viewer that does not play is a failure (its page state is dumped).
  for (const b of browsers) {
    const v = await joinAndPlay(b, s0.liveLink, `tun-${b.__kind}`).catch((err) => err);
    check(`viewer plays through the tunnel in ${b.__kind}`, !(v instanceof Error), v instanceof Error ? v.message.split('\n')[0] : '');
    if (!(v instanceof Error)) await v.context.close();
  }
  const base = s0.liveLink.replace(/\/join\/.*/, '');
  const stop = await app.api('/api/live/stop', {});
  check('[tunnel] "Stop everything" verified', stop.verified === true);
  check('[tunnel] cloudflared gone', !processesUnder(home).some((p) => /cloudflared/i.test(p.name)));
  check('[tunnel] public address no longer answers', !(await probe(base)));
  feed.stop();
  await quitAndVerify(app, home, 'tunnel');
  copyAppLogs(home, 'tunnel');
});

await section('4. taskkill /F on the app: the reaper removes MediaMTX, cloudflared, tray', async () => {
  resetConfig();
  const app = await start(['-Yes', '-SkipSpeedtest'], 'taskkill');
  onCleanup(() => killUnder(home));
  const s0 = await waitLiveLink(app, 180_000).catch(() => null);
  if (s0) {
    const feed = pushStream(s0.rtmpUrl, s0.streamKey);
    await waitPhase(app, 'live').catch(() => {});
    onCleanup(() => feed.stop());
  }
  const before = processesUnder(home);
  info('processes before taskkill /F', describeProcs(before));
  const main = appProcess(home);
  must('found the SwarmCast process', !!main);
  spawnSync('taskkill', ['/F', '/PID', String(main.pid)], { stdio: 'ignore' });
  const left = await until(async () => (processesUnder(home).length === 0 ? [] : null), 20_000, 'reaper').catch(() => processesUnder(home));
  check('after taskkill /F: no reaper/MediaMTX/cloudflared/tray/ffmpeg left', left.length === 0, left.length ? `left: ${describeProcs(left)}` : `killed: ${describeProcs(before.filter((p) => p.pid !== main.pid))}`);
  check('after taskkill /F: port 1935 free', !(await listening(1935)));
  const code = await orTimeout(app.inst.exit, 10_000, 'timeout');
  info('start script exit code after the app was killed', String(code));
});

/** Runs the start script in a new console window (like a double-click) and returns the app pid. */
async function startInConsole(label) {
  const launcher = path.join(ART, `console-${label}.cmd`);
  fs.writeFileSync(launcher, `@echo off\r\ncall "${path.join(relDir, 'start-windows.cmd')}" --yes --skip-speedtest --no-tunnel\r\n`);
  const env = bareEnv({ releaseUrl: srv.url });
  const r = spawnSync(powershellExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'launch-console.ps1'), '-Launcher', launcher, '-Title', `SwarmCast ${label}`], { env, encoding: 'utf8', timeout: 60_000 });
  info('console launcher', (r.stdout || r.stderr || '').trim());
  // 1935 listens only once the app has its Ctrl+C / Ctrl+Break handlers (main.ts starts the live
  // after them), and the start script logged its window watch before it started the app.
  await until(async () => (await listening(1935)) && appProcess(home), 180_000, 'app live in its console window');
  const watch = readText(path.join(home, 'logs', 'install.log')).match(/Window watch.*$/gm)?.pop();
  info('start script window watch', watch ?? 'no "Window watch" line in install.log');
  return { pid: appProcess(home).pid, launcher };
}

for (const [action, what] of [
  ['close', 'closing the console window (X button)'],
  ['ctrlc', 'Ctrl+C in the console window'],
  ['ctrlbreak', 'Ctrl+Break in the console window'],
]) {
  await section(`5. ${what} -> clean shutdown`, async () => {
    resetConfig();
    const logBefore = appLog(home).length;
    const { pid, launcher } = await startInConsole(action);
    onCleanup(() => {
      killUnder(home);
      for (const p of processes().filter((x) => x.cmd.includes(launcher))) killTree(p.pid);
    });
    const before = processesUnder(home);
    const installLog = () => readText(path.join(home, 'logs', 'install.log'));
    const installBefore = installLog().length;
    if (action === 'close') {
      // Which window hosts the console (Console Host, or Windows Terminal with a 0 x 0 pseudo window).
      const host = spawnSync(powershellExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'console-ctl.ps1'), '-TargetPid', String(pid), '-Action', 'probe', '-Title', `SwarmCast ${action}`], { encoding: 'utf8', timeout: 60_000 });
      info('console close: host before the close', (host.stdout || host.stderr || '').trim());
    }
    const t0 = Date.now();
    const r = spawnSync(powershellExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'console-ctl.ps1'), '-TargetPid', String(pid), '-Action', action, '-Title', `SwarmCast ${action}`, '-Method', opt('close-method', 'auto')], { encoding: 'utf8', timeout: 90_000 });
    const ev = (r.stdout || r.stderr || '').trim();
    info('console event', ev);
    // close: how the window went (console-ctl.ps1 -Method): a real click on its X (SendInput),
    // UI Automation's WindowPattern.Close(), or the posted SC_CLOSE / WM_CLOSE.
    const method = /method=(\w+)/.exec(ev)?.[1] ?? 'unknown';
    if (action === 'close') {
      info('console close: method', method);
      must(`${what}: the console window closed`, /closed=True/.test(ev), ev);
    }
    const left = await until(async () => (processesUnder(home).length === 0 ? [] : null), 30_000, 'shutdown').catch(() => processesUnder(home));
    const secs = Math.round((Date.now() - t0) / 1000);
    check(`${what}: no SwarmCast/MediaMTX/tray process left`, left.length === 0, left.length ? `still running ${secs} s later: ${describeProcs(left)}` : `stopped in ${secs} s: ${describeProcs(before)}`);
    check(`${what}: port 1935 free`, !(await listening(1935)));
    const lines = appLog(home).slice(logBefore);
    const graceful = /shutting down: stopping the live/.test(lines);
    const complete = /shutdown complete/.test(lines);
    check(`${what}: graceful shutdown path ran`, graceful, `"shutting down" logged: ${graceful}; "shutdown complete" logged: ${complete}`);
    if (action === 'close') {
      // B2: on some builds the window goes away and no CTRL_CLOSE_EVENT reaches its programs. The
      // start script's window watch then ends the script, and SwarmCast stops because the program
      // that started it is gone. Which path ran is the outcome the soak counts.
      const watch = /\(window watch\)/.test(installLog().slice(installBefore));
      const parentGone = /the window that started SwarmCast was closed/.test(lines);
      const build = Number(ps('[Environment]::OSVersion.Version.Build', { allowFail: true })) || 0;
      info('console close: shutdown path', watch ? `window watch of the start script: no CTRL_CLOSE_EVENT reached the window's programs (SwarmCast saw its parent end: ${parentGone})` : `close event (CTRL_CLOSE_EVENT)${parentGone ? '; SwarmCast also saw its parent end' : ''}`);
      info('console close: outcome', `method=${method} path=${watch ? 'window-watch' : 'close-event'} stopped=${left.length === 0} seconds=${secs} build=${build}`);
      const windowProcs = () => processes().filter((x) => x.cmd.includes(launcher) || (x.cmd.includes('start-windows.ps1') && x.cmd.includes(relDir)));
      const chain = await until(async () => (windowProcs().length === 0 ? [] : null), 10_000, "the window's programs").catch(() => windowProcs());
      check(`${what}: the window's cmd and PowerShell ended too`, chain.length === 0, chain.length ? `left: ${describeProcs(chain)}` : '');
      if (left.length) {
        const att = spawnSync(powershellExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'console-ctl.ps1'), '-TargetPid', String(pid), '-Action', 'probe', '-Title', `SwarmCast ${action}`], { encoding: 'utf8', timeout: 30_000 });
        info('console close: console of the app afterwards', (att.stdout || att.stderr || '').trim());
      }
    }
    if (action === 'ctrlc') {
      const cmdLeft = processes().filter((x) => x.cmd.includes(launcher));
      info('cmd.exe after Ctrl+C', cmdLeft.length ? 'cmd.exe still open (it asks "Terminate batch job (Y/N)?", standard cmd behavior)' : 'console closed');
    }
  });
}

await section('6. uninstall-windows.cmd during a live (tunnel, viewer watching), default data folder', async () => {
  resetConfig();
  const chrome = await launchBrowser('chrome');
  const app = await start(['-Yes', '-SkipSpeedtest'], 'before-uninstall');
  onCleanup(() => killUnder(home));
  const s0 = await waitLiveLink(app, 180_000);
  const feed = pushStream(s0.rtmpUrl, s0.streamKey);
  await waitPhase(app, 'live');
  const v = await joinAndPlay(chrome, s0.liveLink, 'watching-uninstall').catch((e) => e);
  info('viewer before uninstall', v instanceof Error ? v.message.split('\n')[0] : 'playing');
  info('running before uninstall', describeProcs(processesUnder(home)));
  await uninstallAndVerify({ dir: relDir, home, label: 'uninstall during a live', envHome: false });
  if (!(v instanceof Error)) {
    await v.page.waitForSelector('#ended:not([hidden])', { timeout: 30_000 }).then(
      () => info('viewer after uninstall', 'sees "The stream has ended"'),
      () => info('viewer after uninstall', 'no end screen (the app was force-stopped or the tunnel vanished)'),
    );
  }
  const code = await orTimeout(app.inst.exit, 15_000, 'timeout');
  info('start script exit code after the uninstaller stopped SwarmCast', String(code));
  feed.stop();
});

await srv.close();
finish();
