#!/usr/bin/env node
// Quality ladder on a GPU-less Windows runner: ffmpeg download + SHA-256 (installer or panel
// API), encoder probe (no hardware encoder), the CPU fallback decision, a manual rendition
// with a multivariant playlist (>= 2 levels, ABR switch under throttling), and no ffmpeg left
// behind after stop, quit or taskkill /F.
//
// Usage: node scripts/test/windows/quality.mjs --work <dir from make-release.mjs> [--out results.json]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  appProcess, check, killTree, copyAppLogs, describeProcs, environmentFacts, finish, hlsProbe, info, installHlsProbe, installerResult, joinAndPlay, killUnder, launchBrowser, listening, log, must, onCleanup,
  opt, processesUnder, pushStream, quitAndVerify, readText, record, repoRoot, runInstaller, section, serve, sleep, startApp, uninstallAndVerify, until, waitLiveLink, waitPhase,
} from './lib.mjs';

const work = path.resolve(opt('work', path.join(repoRoot, 'release', 'win-e2e')));
const relDir = path.join(work, 'rel');
const home = 'C:\\SC quality\\SwarmCast';
const srv = await serve(relDir);
const pin = JSON.parse(readText(path.join(repoRoot, 'scripts', 'build', 'versions.json'))).ffmpeg;
const pinWin = pin.assets['windows-x64'];
const script = readText(path.join(relDir, 'start-windows.ps1'));
const installerFfmpeg = /ffmpeg/i.test(script);
const noFfmpegFlag = /NoFfmpeg/i.test(script) ? '-NoFfmpeg' : null;
// Where the start script and the panel put ffmpeg: <data>\tools\ffmpeg (outside app\, kept across updates).
const ffmpegExe = (h) => path.join(h, 'tools', 'ffmpeg', 'ffmpeg.exe');
const why = (plan) => (plan?.reasons ?? []).map((r) => r.text ?? r.code ?? String(r)).join(' ');
const ffmpegLeft = () => processesUnder(home).filter((p) => /ffmpeg/i.test(p.name));
const start = (label, extra = {}) => startApp({ entry: 'ps', dir: relDir, releaseUrl: srv.url, home, args: ['-Yes', '-SkipSpeedtest', '-NoTunnel'], label, ...extra });

async function quality(app) {
  return app.api('/api/quality');
}
async function putQuality(app, mut) {
  const q = await quality(app);
  const s = q.settings;
  const body = { ladder: { ...s.ladder }, upload: { ...s.upload }, obsWebsocket: { enabled: s.obsWebsocket.enabled, url: s.obsWebsocket.url } };
  mut(body);
  const r = await app.api('/api/quality', body, 'PUT');
  if (r.__status !== 200) throw new Error(`PUT /api/quality: ${JSON.stringify(r)}`);
  return r;
}

let app;
await section('0. environment', async () => {
  for (const [k, v] of Object.entries(environmentFacts())) info(k, v);
  info('installer and ffmpeg', installerFfmpeg ? `start-windows.ps1 mentions ffmpeg; opt-out flag: ${noFfmpegFlag ?? 'none'}` : 'start-windows.ps1 does not install ffmpeg on this commit: using the panel install API');
});

await section('1. ffmpeg download + SHA-256 verification', async () => {
  fs.rmSync(path.dirname(home), { recursive: true, force: true });
  if (installerFfmpeg && noFfmpegFlag) {
    const h2 = 'C:\\SC quality noffmpeg\\SwarmCast';
    fs.rmSync(path.dirname(h2), { recursive: true, force: true });
    const r = await installerResult(runInstaller({ entry: 'ps', dir: relDir, releaseUrl: srv.url, home: h2, args: ['-Yes', '-SkipSpeedtest', '-InstallOnly', noFfmpegFlag], label: 'noffmpeg' }));
    check(`${noFfmpegFlag}: installs SwarmCast without ffmpeg`, r.code === 0 && !fs.existsSync(ffmpegExe(h2)), `exit ${r.code}`);
  }
  const r = await installerResult(runInstaller({ entry: 'ps', dir: relDir, releaseUrl: srv.url, home, args: ['-Yes', '-SkipSpeedtest', '-InstallOnly'], label: 'install' }), 1_200_000);
  must('installed', r.code === 0, `exit ${r.code}`);
  if (installerFfmpeg) {
    check('installer downloaded ffmpeg into tools\\ffmpeg', fs.existsSync(ffmpegExe(home)), ffmpegExe(home));
    check('installer recorded the pin (version + SHA-256)', readText(path.join(path.dirname(ffmpegExe(home)), 'PIN')).trim() === `${pin.version} ${pinWin.sha256}`, readText(path.join(path.dirname(ffmpegExe(home)), 'PIN')).trim());
    info('installer ffmpeg lines', r.out.split(/\r?\n/).filter((l) => /ffmpeg|video converter/i.test(l)).join(' | ').slice(0, 800));
  }
  app = await start('quality', { persist: true }); // stays up for sections 2-5
  let q = await quality(app);
  if (!q.ffmpeg.available) {
    const r2 = await app.api('/api/quality/ffmpeg/install', {});
    check('panel "Install the video converter" accepted', r2.__status === 200, JSON.stringify(r2.install ?? r2).slice(0, 200));
    q = await until(async () => {
      const x = await quality(app);
      if (x.install?.phase === 'error') throw new Error(x.install.message);
      return x.install?.phase === 'done' && x.ffmpeg.available ? x : null;
    }, 900_000, 'ffmpeg install', 3000);
  }
  check('ffmpeg available to the app', q.ffmpeg.available, q.ffmpeg.path);
  check('ffmpeg installed in the data folder (not on PATH)', (q.ffmpeg.path ?? '').toLowerCase().startsWith(home.toLowerCase()), q.ffmpeg.path);
  const source = readText(path.join(path.dirname(q.ffmpeg.path ?? ffmpegExe(home)), 'SOURCE.txt'));
  check('SHA-256 of the download matched the pin in versions.json', source.includes(`sha256 ${pinWin.sha256}`) && source.includes(pinWin.url), source.trim().replace(/\r?\n/g, ' | '));
  const v = spawnSync(q.ffmpeg.path, ['-hide_banner', '-version'], { encoding: 'utf8' });
  info('ffmpeg -version', (v.stdout ?? '').split(/\r?\n/)[0]);
  const lic = /--enable-gpl/.test(v.stdout ?? '') ? 'GPL build' : 'LGPL build (no --enable-gpl)';
  info('ffmpeg license (from its configure line)', lic);
});

await section('2. encoder probe: no hardware encoder on the runner', async () => {
  must('app running', !!app);
  let q = await quality(app);
  if (!q.encoders.length || q.probing) {
    await app.api('/api/quality/probe', {}).catch(() => {});
    q = await until(async () => {
      const x = await quality(app);
      return !x.probing && x.encoders.length ? x : null;
    }, 180_000, 'encoder probe', 2000);
  }
  const hw = q.encoders.filter((e) => e.hardware);
  check('probe ran for every Windows candidate', ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264', 'libopenh264'].every((id) => q.encoders.some((e) => e.id === id)), q.encoders.map((e) => e.id).join(', '));
  check('no hardware encoder reported working (no GPU)', hw.length > 0 && hw.every((e) => !e.ok), hw.map((e) => `${e.id}: ${e.ok ? 'OK?!' : e.error}`).join(' | '));
  for (const e of q.encoders.filter((x) => !x.hardware)) info(`software encoder ${e.id}`, e.ok ? `works, ${e.fps} fps in the 720p probe` : `not usable: ${e.error}`);
  info('CPU cores seen by the planner', String(q.cpuCores));
  const sw = q.pc?.software;
  info('Your PC assessment', `${q.pc?.reason?.text ?? '?'}${sw ? ` (software: ${sw.pick ? `${sw.pick.encoder} ${sw.pick.height}p` : 'none'}, budget ${sw.budgetCores} cores)` : ''}`);
});

await section('3. CPU fallback decision (auto mode)', async () => {
  const q = await putQuality(app, (b) => (b.ladder = { ...b.ladder, mode: 'auto', encoder: 'auto' }));
  const codes = (q.plan.reasons ?? []).map((r) => r.code);
  check('auto on a 2-thread PC without a GPU: original quality only, with the CPU reason', q.plan.rungs.length === 1 && q.plan.encoder === null && codes.some((c) => /^quality\.reason\.cpu/.test(c ?? '')), why(q.plan));
});

await section('4. manual rendition: multivariant playlist, viewers get >= 2 levels and switch', async () => {
  const browser = await launchBrowser('chrome');
  // The automatic choice refuses CPU conversion on 2 threads (section 3); force it like a
  // streamer would in Quality settings: 480p with the software encoder that works.
  const enc = (await quality(app)).encoders.find((e) => !e.hardware && e.ok)?.id;
  must('a software encoder works', !!enc);
  const q0 = await putQuality(app, (b) => (b.ladder = { ...b.ladder, mode: 'manual', enabled: true, heights: [480], encoder: enc }));
  info('manual plan before OBS', `${q0.plan.rungs.map((r) => `${r.height}p`).join('+')} encoder=${q0.plan.encoder}; ${why(q0.plan)}`);
  // The end of this section stops the live; a repeated run (--repeat) starts it again.
  if ((await app.state()).phase === 'off') await app.api('/api/live/start', {});
  const s0 = await waitLiveLink(app);
  const feed = pushStream(s0.rtmpUrl, s0.streamKey, { size: '1280x720', kbps: 2500 });
  await waitPhase(app, 'live', 120_000);
  const q = await until(async () => {
    const x = await quality(app);
    if (x.transcoder.status === 'failed') throw new Error(`transcoder failed: ${x.transcoder.message}`);
    return x.transcoder.status === 'running' && x.variants.length >= 2 ? x : null;
  }, 120_000, 'transcoder running with 2 variants', 2000).catch((e) => e);
  if (q instanceof Error) {
    const x = await quality(app);
    must('ladder running', false, `${q.message}; plan ${JSON.stringify(x.plan)} transcoder ${JSON.stringify(x.transcoder)}`);
  }
  check('transcoder running on the CPU encoder', true, `encoder ${q.plan.encoder}, speed ${q.transcoder.speed ?? '?'}x, variants ${q.variants.map((v) => `${v.height}p@${v.bandwidthKbps}k`).join(', ')}`);
  const ff = ffmpegLeft();
  check('the converter runs from the data folder', ff.length >= 1, describeProcs(ff));

  const v = await joinAndPlay(browser, s0.liveLink, 'ladder-viewer');
  await v.page.uncheck('#p2p').catch(() => {});
  const master = await v.page.evaluate(async () => (await fetch('/hls/index.m3u8', { credentials: 'same-origin' })).text());
  const infs = master.split('\n').filter((l) => l.startsWith('#EXT-X-STREAM-INF'));
  check('multivariant playlist with >= 2 levels', infs.length >= 2, infs.map((l) => /RESOLUTION=(\S+?),/.exec(l)?.[1]).join(', '));
  const uris = master.split('\n').filter((l) => l && !l.startsWith('#'));
  const sub = await v.page.evaluate(async (list) => Promise.all(list.map(async (u) => [u, (await fetch(`/hls/${u}`, { credentials: 'same-origin' })).status])), uris);
  check('every level playlist answers 200', sub.every(([, st]) => st === 200), sub.map(([u, st]) => `${u}=${st}`).join(' '));

  // ABR: throttle the viewer below the top level; hls.js must move to the 480p level.
  const seen = new Set();
  v.page.on('request', (r) => {
    const m = /\/hls\/(?:[^/]*_)?(v\d+)/.exec(r.url());
    if (m) seen.add(m[1]);
  });
  // F4/B9 evidence: every hls.js level event, error and instance change (stall recovery can
  // reload the source, which makes a new hls.js), plus the viewer's stall-recovery log lines.
  await installHlsProbe(v.page);
  v.page.on('console', (m) => {
    if (/stall recovery|reload/i.test(m.text())) log(`[ladder-viewer] ${m.text().slice(0, 300)}`);
  });
  const menu = await v.page.$('select.quality-menu, #player-controls select, select[aria-label*="quality" i]');
  if (menu) {
    const opts = await menu.$$eval('option', (os) => os.map((o) => [o.value, o.textContent]));
    const low = opts.find(([, t]) => /480/.test(t ?? ''));
    const t0 = Date.now();
    if (low) await menu.selectOption(low[0]);
    // The player's own state, not only its requests: the level hls.js plays and loads is 480p,
    // and a 480p fragment arrived.
    const state = await v.page
      .waitForFunction(() => {
        const h = window.__hls;
        const lv = h?.levels ?? [];
        const cur = lv[h?.currentLevel]?.height;
        const load = lv[h?.loadLevel]?.height;
        return cur === 480 && load === 480 && (window.__scHls?.frag480 ?? 0) > 0 ? { cur, load, auto: h.autoLevelEnabled } : null;
      }, undefined, { timeout: 20_000, polling: 250 })
      .then((h) => h.jsonValue(), () => null);
    const probe = await hlsProbe(v.page);
    log(`hls.js events around the 480p pick: ${probe.events.map((e) => `${e.t}ms #${e.inst} ${e.ev}${e.level !== undefined ? ` L${e.level}` : ''}${e.details ? ` ${e.details}` : ''}`).join(', ').slice(0, 4000)}`);
    const detail = `${state ? `currentLevel and loadLevel at 480p in ${Math.round((Date.now() - t0) / 1000)} s` : `after 20 s: currentLevel ${probe.cur ?? '?'}p, loadLevel ${probe.load ?? '?'}p, auto ${probe.auto}, 480p fragments ${probe.frag480}`}; hls.js instances ${probe.instances}; stall recoveries ${probe.stallRecoveries}; v480 requested: ${seen.has('v480')}; menu ${opts.map(([, t]) => t).join(' / ')}`;
    check('viewer quality menu switches to 480p (player state)', !!state, detail);
    // B9: a reload by the stall watchdog must not drop the viewer's manual choice.
    if (probe.instances > 1) record('manual 480p kept across a source reload', probe.cur === 480 ? 'pass' : 'warn', probe.cur === 480 ? `${probe.instances} hls.js instances, still 480p` : `BUG? ${probe.instances} hls.js instances and the level is ${probe.cur}p after the reload (B9)`);
    if (low) await menu.selectOption(opts[0][0]);
  } else {
    info('viewer quality menu', 'not in this viewer build (watch.ts integration pending): testing hls.js automatic switching instead');
  }
  const cdp = await v.context.newCDPSession(v.page);
  await cdp.send('Network.enable');
  seen.clear();
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: 1_900_000 / 8, uploadThroughput: -1 });
  const down = await until(() => seen.has('v480'), 90_000, 'v480 requests under a 1.9 Mbps limit').then(() => true, () => false);
  check('ABR switches down to 480p when the viewer link is slow (1.9 Mbps)', down, `levels requested: ${[...seen].join(', ') || 'none'}`);
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  seen.clear();
  const up = await until(() => [...seen].some((x) => x !== 'v480'), 90_000, 'back to the top level').then(() => true, () => false);
  info('ABR switches back up when the limit is removed', up ? `yes (${[...seen].join(', ')})` : 'not within 90 s');
  const qNow = await quality(app);
  for (const rung of qNow.plan.rungs.filter((r) => !r.source)) {
    const got = qNow.variants.find((x) => x.height === rung.height)?.bandwidthKbps ?? 0;
    const target = rung.kbps + 128;
    record(`${rung.height}p rendition bitrate close to its target (${qNow.plan.encoder})`, got > 0 && got <= target * 1.5 ? 'pass' : 'warn', `measured ${got} kbps vs target ~${target} kbps (video ${rung.kbps} + audio); source ${qNow.variants.find((x) => x.height === qNow.plan.rungs[0].height)?.bandwidthKbps} kbps`);
  }
  const stillPlaying = await v.page.evaluate(() => !document.querySelector('video').paused);
  check('playback continued through the level switches', stillPlaying);
  await v.context.close();

  const stop = await app.api('/api/live/stop', {});
  check('"Stop everything" verified (includes the converter)', stop.verified === true);
  await sleep(1500);
  check('no ffmpeg left after stop', ffmpegLeft().length === 0, describeProcs(ffmpegLeft()));
  feed.stop();
});

await section('5. taskkill /F during conversion: the reaper removes ffmpeg', async () => {
  onCleanup(() => {
    killTree(app.inst.child.pid);
    killUnder(home);
  });
  await app.api('/api/live/start', {});
  const s0 = await waitLiveLink(app);
  const feed = pushStream(s0.rtmpUrl, s0.streamKey, { size: '1280x720', kbps: 2500 });
  onCleanup(() => feed.stop());
  await until(async () => (await quality(app)).transcoder.status === 'running', 120_000, 'transcoder running', 2000);
  const before = processesUnder(home);
  const main = appProcess(home);
  spawnSync('taskkill', ['/F', '/PID', String(main.pid)], { stdio: 'ignore' });
  const left = await until(async () => (processesUnder(home).length === 0 ? [] : null), 20_000, 'reaper').catch(() => processesUnder(home));
  check('after taskkill /F: ffmpeg, MediaMTX and the reaper are gone', left.length === 0, left.length ? describeProcs(left) : `were: ${describeProcs(before)}`);
  check('port 1935 free', !(await listening(1935)));
  await Promise.race([app.inst.exit, sleep(10_000)]);
});

await section('6. quit during conversion leaves nothing', async () => {
  app = await start('quality-quit');
  onCleanup(() => killUnder(home));
  const s0 = await waitLiveLink(app);
  const feed = pushStream(s0.rtmpUrl, s0.streamKey, { size: '1280x720', kbps: 2500 });
  await until(async () => (await quality(app)).transcoder.status === 'running', 120_000, 'transcoder running', 2000);
  await quitAndVerify(app, home, 'quit while converting');
  feed.stop();
  copyAppLogs(home, 'quality');
});

await section('7. uninstall-windows.cmd while converting', async () => {
  app = await start('quality-uninstall');
  onCleanup(() => killUnder(home));
  const s0 = await waitLiveLink(app);
  const feed = pushStream(s0.rtmpUrl, s0.streamKey, { size: '1280x720', kbps: 2500 });
  await until(async () => (await quality(app)).transcoder.status === 'running', 120_000, 'transcoder running', 2000);
  info('running before uninstall', describeProcs(processesUnder(home)));
  await uninstallAndVerify({ dir: relDir, home, label: 'uninstall while ffmpeg converts' });
  check('the downloaded ffmpeg is gone with the data folder', !fs.existsSync(ffmpegExe(home)));
  feed.stop();
});

await srv.close();
finish();
