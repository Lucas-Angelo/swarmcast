#!/usr/bin/env node
// SwarmCast on Windows: the staged server (release/staging/windows-x64, the desktop app's
// sidecar) run outside the desktop app with a bare-OS PATH, on the DEFAULT data folder
// (%LOCALAPPDATA%\SwarmCast: no --data-dir), where the desktop app keeps its data too:
//  - local mode with Google Chrome, Microsoft Edge and Firefox viewers, P2P Chrome<->Edge and
//    Chrome<->Firefox, viewer joining before the stream, viewer count, Go-live, kick, new link,
//    "Stop everything" (API and panel button), Quit from the panel, loopback-only sockets
//  - pt-BR UI, session cap (maxViewers=2 -> "full"), auto-stop
//  - real Cloudflare quick tunnel with the three browsers
//  - taskkill /F of the app (reaper), Quit from the panel during a live
//
// Usage: node scripts/test/windows/app.mjs [--staging release/staging/windows-x64] [--out results.json]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  addSweepPath, appProcess, check, copyAppLogs, describeProcs, editConfig, environmentFacts, finish, info, installServer, isLoopback, join, joinAndPlay,
  killUnder, launchBrowser, listening, must, onCleanup, openPanel, opt, orTimeout, peSubsystem, pkgVersion, probe, processesUnder,
  pushStream, quitAndVerify, record, renderedTwice, uploadCapCheck, repoRoot, section, serverExe, socketsOf, startApp, stats, ui, until,
  waitLiveLink, waitPhase, waitPlaying, waitPlaylistForLateJoiners, setP2P,
} from './lib.mjs';

const V = opt('version', pkgVersion());
const home = path.join(process.env.LOCALAPPDATA, 'SwarmCast');
addSweepPath(home);
const start = (args = ['--no-tunnel'], label = 'start') => startApp({ home, defaultDataDir: true, args, label });
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

await section('0. environment + an empty default data folder with the staged server', async () => {
  for (const [k, v] of Object.entries(environmentFacts())) info(k, v);
  fs.rmSync(home, { recursive: true, force: true });
  installServer(home);
  must('staged server copied', fs.existsSync(serverExe(home)), serverExe(home));
  info('swarmcast.exe PE subsystem', `${peSubsystem(serverExe(home))} (3 = console; the desktop app starts it without a window)`);
});

await section('1. local mode: Chrome, Edge, Firefox, P2P, Go-live, kick, new link, stop, quit', async () => {
  resetConfig();
  const chrome = await launchBrowser('chrome');
  const edge = await launchBrowser('msedge');
  const firefox = await launchBrowser('firefox');
  const app = await start(undefined, 'local');
  onCleanup(() => killUnder(home));
  const s0 = await waitLiveLink(app);
  check('live link is local (--no-tunnel)', /^http:\/\/127\.0\.0\.1:\d+\/join\//.test(s0.liveLink));
  check('the staged version runs', s0.version === V, s0.version);
  check('without --data-dir it keeps its data in %LOCALAPPDATA%\\SwarmCast', fs.existsSync(path.join(home, 'secrets.json')) && fs.existsSync(path.join(home, 'config.json')), home);

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
      // Finish closes the tutorial at once and saves "done" right after (Onboarding.tsx close()):
      // read the server only once that save has been answered.
      const saved = panel.page.waitForResponse((r) => new URL(r.url()).pathname === '/api/onboarding' && r.request().method() === 'POST', { timeout: 10_000 });
      await panel.page.click('[data-testid=onb-finish]');
      const closed = await onb.waitFor({ state: 'hidden', timeout: 10_000 }).then(() => true, () => false);
      const savedOk = await saved.then((r) => r.ok(), () => false);
      const done = savedOk && (await app.api('/api/onboarding')).done === true;
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

  await uploadCapCheck(app, 'panel with one viewer');

  // Edge + Chrome P2P (Firefox not joined yet): Edge must start on segments Chrome already played.
  await waitPlaylistForLateJoiners(early.page);
  const e = await joinAndPlay(edge, s0.liveLink, 'edge');
  check('viewer plays in Microsoft Edge', true, edge.version());
  await setP2P(early.page, true);
  await setP2P(e.page, true);
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
    await setP2P(f.page, true);
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
  await panel.page.getByRole('button', { name: ui('en', 'admin.quit') ?? 'Quit', exact: true }).click();
  await quitAndVerify(app, home, 'quit from the panel', { via: 'none' });
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
  const app = await start([], 'tunnel');
  onCleanup(() => killUnder(home));
  const s0 = await waitLiveLink(app);
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

await section('4. taskkill /F on the app: the reaper removes MediaMTX and cloudflared', async () => {
  resetConfig();
  const app = await start([], 'taskkill');
  onCleanup(() => killUnder(home));
  const s0 = await waitLiveLink(app).catch(() => null);
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
  check('after taskkill /F: no reaper/MediaMTX/cloudflared/ffmpeg left', left.length === 0, left.length ? `left: ${describeProcs(left)}` : `killed: ${describeProcs(before.filter((p) => p.pid !== main.pid))}`);
  check('after taskkill /F: port 1935 free', !(await listening(1935)));
  const code = await orTimeout(app.inst.exit, 10_000, 'timeout');
  info('server exit code after taskkill /F', String(code));
});

await section('5. Quit from the panel during a live (tunnel, viewer watching)', async () => {
  resetConfig();
  const chrome = await launchBrowser('chrome');
  const app = await start([], 'quit-live');
  onCleanup(() => killUnder(home));
  const s0 = await waitLiveLink(app);
  const feed = pushStream(s0.rtmpUrl, s0.streamKey);
  onCleanup(() => feed.stop());
  await waitPhase(app, 'live');
  const v = await joinAndPlay(chrome, s0.liveLink, 'watching-quit').catch((e) => e);
  check('viewer plays through the tunnel before the quit', !(v instanceof Error), v instanceof Error ? v.message.split('\n')[0] : '');
  info('running before the quit', describeProcs(processesUnder(home)));
  await quitAndVerify(app, home, 'quit during a live');
  if (!(v instanceof Error)) {
    await v.page.waitForSelector('#ended:not([hidden])', { timeout: 30_000 }).then(
      () => check('viewer sees "The stream has ended" after the quit', true),
      () => check('viewer sees "The stream has ended" after the quit', false),
    );
  }
  copyAppLogs(home, 'quit-live');
});

finish();
