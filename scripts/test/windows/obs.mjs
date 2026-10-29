#!/usr/bin/env node
// Real OBS Studio on a Windows runner (best effort: no GPU, D3D11 must fall back to WARP).
// OBS 33.0.0 portable zip (pinned SHA-256), configured through files + obs-websocket exactly
// like scripts/test/obs-e2e/setup-obs.mjs (Advanced output, x264 CBR 2500, keyframe 2 s,
// Custom service rtmp://127.0.0.1:1935/live + key), a looping Media Source, streaming into
// SwarmCast installed by the start script; the panel must show OBS sending and a viewer plays.
//
// Usage: node scripts/test/windows/obs.mjs --work <dir from make-release.mjs> [--out results.json]
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { download } from '../../build/fetch-binaries.mjs';
import {
  ART, check, copyAppLogs, environmentFacts, ffmpegBin, finish, info, joinAndPlay, killTree, killUnder, launchBrowser, log, must, onCleanup, openPanel, opt, ps,
  quitAndVerify, readText, uninstallAndVerify, uploadCapCheck, repoRoot, section, serve, sha256File, sleep, startApp, until, waitLiveLink, waitPhase,
} from './lib.mjs';

const OBS = { version: '33.0.0', url: 'https://github.com/obsproject/obs-studio/releases/download/33.0.0/OBS-Studio-33.0.0-Windows-x64.zip', sha256: '3369a3ecd67b5669a8a08d77357f87cc786d1fba42fbbd1054d841a69f6271a7' };
const work = path.resolve(opt('work', path.join(repoRoot, 'release', 'win-e2e')));
const relDir = path.join(work, 'rel');
const obsRoot = 'C:\\obs-portable';
const obsCfg = path.join(obsRoot, 'config', 'obs-studio');
const obsExe = path.join(obsRoot, 'bin', '64bit', 'obs64.exe');
const media = path.join(obsRoot, 'testsrc-540p30.mp4');
const home = 'C:\\SC obs\\SwarmCast';
const PROFILE = 'SwarmCast';
const SCENE = 'SwarmCast';
const WS_PORT = 4455;
const password = crypto.randomBytes(18).toString('base64url');

const ini = (sections) => Object.entries(sections).map(([n, kv]) => `[${n}]\r\n${Object.entries(kv).map(([k, v]) => `${k}=${v}`).join('\r\n')}\r\n`).join('\r\n');
function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function screenshot(tag) {
  const file = path.join(ART, `obs-desktop-${tag}.png`);
  ps(`Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b = [System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height; $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size); $bmp.Save('${file}'); "$($b.Width)x$($b.Height)"`, { allowFail: true });
}

/** Minimal obs-websocket 5 client. */
async function obsConnect() {
  const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
  const pending = new Map();
  let identified;
  const ready = new Promise((resolve, reject) => {
    identified = resolve;
    ws.once('error', reject);
    ws.once('close', () => reject(new Error('obs-websocket closed')));
  });
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.op === 0) {
      const a = msg.d.authentication;
      const auth = a ? crypto.createHash('sha256').update(crypto.createHash('sha256').update(password + a.salt).digest('base64') + a.challenge).digest('base64') : undefined;
      ws.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, ...(auth ? { authentication: auth } : {}), eventSubscriptions: 0 } }));
    } else if (msg.op === 2) identified(msg.d);
    else if (msg.op === 7) {
      const p = pending.get(msg.d.requestId);
      pending.delete(msg.d.requestId);
      if (!p) return;
      if (msg.d.requestStatus.result) p.resolve(msg.d.responseData ?? {});
      else p.reject(new Error(`${msg.d.requestType}: ${msg.d.requestStatus.code} ${msg.d.requestStatus.comment ?? ''}`));
    }
  });
  await ready;
  return {
    call: (requestType, requestData = {}) =>
      new Promise((resolve, reject) => {
        const requestId = crypto.randomUUID();
        pending.set(requestId, { resolve, reject });
        ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
        setTimeout(() => pending.has(requestId) && (pending.delete(requestId), reject(new Error(`${requestType}: timeout`))), 20_000);
      }),
    close: () => ws.close(),
  };
}

function obsLogTail() {
  const dir = path.join(obsCfg, 'logs');
  if (!fs.existsSync(dir)) return '(no OBS log)';
  const files = fs.readdirSync(dir).sort();
  const last = files.at(-1);
  if (!last) return '(no OBS log)';
  fs.copyFileSync(path.join(dir, last), path.join(ART, `obs-${last}`));
  return readText(path.join(dir, last));
}

let obsProc;
let obs;
await section('0. environment', async () => {
  for (const [k, v] of Object.entries(environmentFacts())) info(k, v);
});

await section('1. OBS 33.0.0 portable: download (pinned SHA-256), configure, generate media', async () => {
  const zip = path.join(process.env.RUNNER_TEMP ?? 'C:\\Temp', 'obs.zip');
  // A zip kept from an earlier run is used only when it still matches the pin; otherwise it is
  // downloaded again, checked in memory, and only then written (download() in fetch-binaries).
  let cached = '';
  try {
    cached = sha256File(zip);
  } catch {
    /* not there yet */
  }
  if (cached !== OBS.sha256) {
    try {
      await download(OBS.url, zip, OBS.sha256);
    } catch (err) {
      must('downloaded OBS (pinned SHA-256)', false, err.message);
    }
  }
  must('OBS zip SHA-256 matches the pin', sha256File(zip) === OBS.sha256, sha256File(zip));
  fs.rmSync(obsRoot, { recursive: true, force: true });
  fs.mkdirSync(obsRoot, { recursive: true });
  execFileSync(path.join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-xf', zip, '-C', obsRoot]);
  must('obs64.exe extracted', fs.existsSync(obsExe), obsExe);
  write(path.join(obsRoot, 'portable_mode.txt'), '');

  const general = { FirstRun: 'true', LastVersion: String((33 << 24) >>> 0), Pre31Migrated: 'true', 'Pre33.0Migrated': 'true', EnableAutoUpdates: 'false', InfoIncrement: '999', ConfirmOnExit: 'false' };
  write(path.join(obsCfg, 'global.ini'), ini({ General: general }));
  write(path.join(obsCfg, 'user.ini'), ini({ General: general, Basic: { Profile: PROFILE, ProfileDir: PROFILE, SceneCollection: SCENE, SceneCollectionFile: SCENE }, BasicWindow: { SysTrayEnabled: 'false', WarnBeforeStartingStream: 'false', WarnBeforeStoppingStream: 'false' } }));
  write(path.join(obsCfg, 'plugin_config', 'obs-websocket', 'config.json'), JSON.stringify({ alerts_enabled: false, auth_required: true, first_load: false, server_enabled: true, server_password: password, server_port: WS_PORT }));
  const prof = path.join(obsCfg, 'basic', 'profiles', PROFILE);
  write(path.join(prof, 'basic.ini'), ini({
    General: { Name: PROFILE },
    Output: { Mode: 'Advanced' },
    AdvOut: { Encoder: 'obs_x264', TrackIndex: '1', ApplyServiceSettings: 'true', RecType: 'Standard' },
    // 960x540: the runner has 2 vCPUs and no GPU (OBS renders with WARP on the CPU).
    Video: { BaseCX: '960', BaseCY: '540', OutputCX: '960', OutputCY: '540', FPSType: '0', FPSCommon: '30' },
    Audio: { SampleRate: '48000', ChannelSetup: 'Stereo' },
  }));
  write(path.join(prof, 'streamEncoder.json'), JSON.stringify({ rate_control: 'CBR', bitrate: 2000, keyint_sec: 2, preset: 'veryfast', profile: 'high', tune: '', x264opts: '' }));
  write(path.join(obsCfg, 'basic', 'scenes', `${SCENE}.json`), JSON.stringify({
    name: SCENE, current_scene: SCENE, current_program_scene: SCENE, scene_order: [{ name: SCENE }],
    sources: [{ name: SCENE, uuid: crypto.randomUUID(), id: 'scene', versioned_id: 'scene', settings: { id_counter: 0, custom_size: false, items: [] }, mixers: 0, enabled: true, muted: false, volume: 1.0 }],
    groups: [], transitions: [], quick_transitions: [], saved_projectors: [], modules: {},
  }));
  execFileSync(ffmpegBin(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=960x540:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000', '-t', '60', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '60', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', media]);
  check('OBS configured (Advanced output, x264 CBR 2000, keyframe 2 s, 960x540@30, obs-websocket on)', fs.existsSync(media));
});

await section('2. SwarmCast installed by the start script, OBS streams into it, a viewer plays', async () => {
  must('OBS prepared', fs.existsSync(obsExe));
  const srv = await serve(relDir);
  onCleanup(() => srv.close());
  const app = await startApp({ entry: 'ps', dir: relDir, releaseUrl: srv.url, home, args: ['-Yes', '-SkipSpeedtest', '-NoTunnel'], label: 'obs' });
  onCleanup(() => killUnder(home));
  const s0 = await waitLiveLink(app);

  onCleanup(() => obsLogTail());
  obsProc = spawn(obsExe, ['--portable', '--disable-updater', '--disable-missing-files-check', '--profile', PROFILE, '--collection', SCENE, '--scene', SCENE], { cwd: path.dirname(obsExe), stdio: 'ignore', windowsHide: false });
  onCleanup(() => obsProc && killTree(obsProc.pid));
  let exitCode = null;
  obsProc.on('exit', (c) => (exitCode = c));
  obs = await until(async () => {
    if (exitCode !== null) throw new Error(`OBS exited with code ${exitCode}`);
    return obsConnect().catch(() => null);
  }, 120_000, 'obs-websocket').catch((e) => e);
  screenshot('after-launch');
  if (obs instanceof Error) {
    const tail = obsLogTail();
    const reason = tail.split(/\r?\n/).filter((l) => /fail|error|unsupported|D3D|adapter|renderer|crash/i.test(l)).slice(-12).join(' | ');
    must('OBS starts and obs-websocket answers', false, `${obs.message}. OBS log: ${reason || tail.slice(-1500)}`);
  }
  const ver = await obs.call('GetVersion');
  info('OBS', `${ver.obsVersion} / obs-websocket ${ver.obsWebSocketVersion} / ${ver.platformDescription}`);
  const vs = await obs.call('GetVideoSettings');
  info('OBS video', `${vs.baseWidth}x${vs.baseHeight} -> ${vs.outputWidth}x${vs.outputHeight} @ ${vs.fpsNumerator}/${vs.fpsDenominator}`);
  const adapter = obsLogTail().split(/\r?\n/).filter((l) => /Adapter|Loading up D3D|Renderer|feature level/i.test(l)).slice(0, 6).join(' | ');
  info('OBS graphics', adapter);

  await obs.call('CreateInput', { sceneName: SCENE, inputName: 'Test video', inputKind: 'ffmpeg_source', inputSettings: { local_file: media, looping: true, restart_on_activate: true, is_local_file: true }, sceneItemEnabled: true });
  await sleep(2000);
  const shot = await obs.call('GetSourceScreenshot', { sourceName: SCENE, imageFormat: 'png', imageWidth: 320 }).catch((e) => ({ imageData: '', err: e.message }));
  const png = Buffer.from(String(shot.imageData ?? '').replace(/^data:image\/png;base64,/, ''), 'base64');
  if (png.length) fs.writeFileSync(path.join(ART, 'obs-program.png'), png);
  check('OBS renders the Media Source (program screenshot is not blank)', png.length > 5000, `${png.length} bytes PNG at 320 px wide${shot.err ? `; ${shot.err}` : ''}`);
  await obs.call('SetStreamServiceSettings', { streamServiceType: 'rtmp_custom', streamServiceSettings: { server: s0.rtmpUrl, key: s0.streamKey, use_auth: false, bwtest: false } });
  const svc = await obs.call('GetStreamServiceSettings');
  check('OBS Custom service set to the panel values', svc.streamServiceSettings.server === s0.rtmpUrl && svc.streamServiceSettings.key === s0.streamKey, svc.streamServiceSettings.server);
  await obs.call('StartStream');
  const active = await until(async () => (await obs.call('GetStreamStatus')).outputActive, 30_000, 'OBS outputActive').then(() => true, (e) => e);
  must('OBS StartStream: output active', active === true, active instanceof Error ? `${active.message}; ${obsLogTail().split(/\r?\n/).slice(-15).join(' | ')}` : '');
  await waitPhase(app, 'live', 90_000);
  const st = await until(async () => {
    const s = await app.state();
    return s.obsConnected && s.obsBitrateKbps > 0 ? s : null;
  }, 60_000, 'panel shows OBS bitrate');
  check('panel shows OBS sending (phase live, bitrate > 0)', true, `${st.obsBitrateKbps} kbps`);
  const browser = await launchBrowser('chrome');
  const panel = await openPanel(browser, app.loginUrl);
  check('panel pill says OBS is sending', /Mbps|sending/i.test((await panel.page.textContent('[data-testid=obs-status]')) ?? ''), await panel.page.textContent('[data-testid=obs-status]'));
  const v = await joinAndPlay(browser, s0.liveLink, 'obs-viewer').catch(async (e) => {
    const stats = await obs.call('GetStats').catch(() => ({}));
    const ss = await obs.call('GetStreamStatus').catch(() => ({}));
    const st2 = await app.state();
    throw new Error(`${e.message.split('\n')[0]} | panel phase ${st2.phase}, obsConnected ${st2.obsConnected}, ${st2.obsBitrateKbps} kbps | OBS cpu ${Math.round(stats.cpuUsage ?? -1)}%, render skipped ${stats.renderSkippedFrames}/${stats.renderTotalFrames}, output skipped ${stats.outputSkippedFrames}/${stats.outputTotalFrames}, stream skipped ${ss.outputSkippedFrames}/${ss.outputTotalFrames}, reconnecting ${ss.outputReconnecting}`, { cause: e });
  });
  check('a viewer plays the OBS stream', true);
  await uploadCapCheck(app, 'panel while OBS streams');
  const status = await obs.call('GetStreamStatus');
  const stats = await obs.call('GetStats');
  info('OBS load', `cpu ${Math.round(stats.cpuUsage)}%, render skipped ${stats.renderSkippedFrames}/${stats.renderTotalFrames}, encoder skipped ${stats.outputSkippedFrames}/${stats.outputTotalFrames}`);
  info('OBS stream status', `skipped ${status.outputSkippedFrames}/${status.outputTotalFrames} frames, congestion ${status.outputCongestion}`);
  const segs = (await app.state()).warnings ?? [];
  check('no keyframe warning (OBS keyframe interval 2 s honored)', !segs.some((w) => /keyframe/i.test(w)), segs.join(' | '));
  await v.context.close();
  screenshot('streaming');

  await obs.call('StopStream');
  await until(async () => !(await obs.call('GetStreamStatus')).outputActive, 20_000, 'OBS stopped');
  await until(async () => !(await app.state()).obsConnected, 30_000, 'panel shows OBS gone').then(
    () => check('panel notices OBS stopped', true),
    () => check('panel notices OBS stopped', false),
  );
  // Uninstall while OBS is open and streaming: SwarmCast goes away, OBS and its settings stay.
  await obs.call('StartStream').catch(() => {});
  await sleep(5000);
  const snap = () => {
    const files = [];
    (function walk(d) {
      for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (!/^(logs|crashes|profiler_data|updates|\.sentinel)$/i.test(e.name)) walk(p);
        } else files.push(`${path.relative(obsCfg, p)}=${sha256File(p)}`);
      }
    })(obsCfg);
    return files.sort();
  };
  const before = snap();
  await uninstallAndVerify({ dir: relDir, home, label: 'uninstall while OBS streams into SwarmCast' });
  const after = snap();
  const changed = after.filter((x) => !before.includes(x)).concat(before.filter((x) => !after.includes(x)));
  check('OBS settings untouched by the uninstaller', changed.length === 0, changed.length ? changed.join(', ') : `${before.length} OBS config files identical`);
  check('OBS is still running after the uninstall', exitCodeOf(obsProc) === null);
  await obs.call('StopStream').catch(() => {});
  obs.close();
  ps(`$p = Get-Process -Id ${obsProc.pid} -ErrorAction SilentlyContinue; if ($p) { [void]$p.CloseMainWindow() }`, { allowFail: true });
  await until(() => exitCodeOf(obsProc) !== null, 20_000, 'OBS quits').catch(() => killTree(obsProc.pid));
  if (!fs.existsSync(path.join(relDir, 'uninstall-windows.cmd'))) await quitAndVerify(app, home, 'after OBS');
  copyAppLogs(home, 'obs');
  log('done');
});

function exitCodeOf(p) {
  return p.exitCode;
}

finish();
