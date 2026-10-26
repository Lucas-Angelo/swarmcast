#!/usr/bin/env node
// Windows installer matrix against the REAL windows-x64 package, served locally:
// every entry point (cmd double-click equivalent, Windows PowerShell 5.1 -File, irm | iex,
// the extracted installer zip with no release server), update paths, checksum mismatch,
// offline start, option flags, non-ASCII data folder, elevated vs. Basic-User token,
// busy ports and the uninstaller (when present).
//
// Usage: node scripts/test/windows/installer.mjs --work <dir from make-release.mjs> [--newer V2] [--out results.json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  adminLogin, check, copyAppLogs, describeProcs, editConfig, environmentFacts, finish, info, installerResult, joinAndPlay, killTree, killUnder,
  launchBrowser, must, occupy, onCleanup, opt, pkgVersion, powershellExe, processesUnder, ps, pushStream, quitAndVerify, readText, record, repoRoot,
  runInstaller, section, serve, sha256File, sleep, startApp, uninstallAndVerify, until, waitLiveLink, waitPhase, bareEnv,
} from './lib.mjs';

const work = path.resolve(opt('work', path.join(repoRoot, 'release', 'win-e2e')));
const V = opt('version', pkgVersion());
const V2 = opt('newer');
const relDir = path.join(work, 'rel');
const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
// Data folder with spaces and non-ASCII characters (José, Ção), as a Brazilian user name would give.
const homeU = path.join(local, 'Test José Ção', 'SwarmCast');
const isFile = (p) => fs.existsSync(p) && fs.statSync(p).isFile();
const ver = (home, which = 'current') => readText(path.join(home, 'app', which, 'VERSION')).trim();
const has = (text, needle) => text.toLowerCase().includes(needle.toLowerCase());
const yesNoTunnel = ['-Yes', '-SkipSpeedtest', '-NoTunnel'];

const srv = await serve(relDir);
const srvNew = V2 ? await serve(path.join(work, 'rel-new')) : null;
const srvBad = await serve(path.join(work, 'rel-corrupt'));
const helpText = readText(path.join(relDir, 'start-windows.ps1'));
const installerHasFfmpeg = /ffmpeg/i.test(helpText);
const installerHasNoFfmpeg = /noffmpeg|no-ffmpeg/i.test(helpText);
const uninstallCmd = path.join(relDir, 'uninstall-windows.cmd');

async function quickStreamCheck(app, browser, label) {
  const s0 = await waitLiveLink(app);
  const feed = pushStream(s0.rtmpUrl, s0.streamKey);
  await waitPhase(app, 'live');
  const v = await joinAndPlay(browser, s0.liveLink, `v ${label}`.replace(/[^\w .-]/g, '').slice(0, 24));
  check(`${label}: stream accepted and a viewer plays it`, true, s0.liveLink.replace(/\/join\/.*/, '/join/…'));
  await v.context.close();
  feed.stop();
  return s0;
}

let browser;
await section('environment', async () => {
  const f = environmentFacts();
  for (const [k, v] of Object.entries(f)) info(k, v);
  info('runner is elevated (admin token)', f.elevated === 'True' ? 'yes: GitHub runners run as an elevated administrator; the Basic-User section covers the normal case' : 'no');
  info('installer features', `ffmpeg mentioned: ${installerHasFfmpeg}; -NoFfmpeg: ${installerHasNoFfmpeg}; uninstaller: ${fs.existsSync(uninstallCmd)}`);
});

/** Google Chrome for this section (closed by the section cleanup). */
async function chrome() {
  return launchBrowser('chrome');
}

await section('1. PowerShell 5.1 -File: clean install into "Test José Ção" + start + stream + quit', async () => {
  browser = await chrome();
  const app = await startApp({ entry: 'ps', dir: relDir, releaseUrl: srv.url, home: homeU, args: yesNoTunnel, label: 'ps-first' });
  onCleanup(() => killUnder(homeU));
  const out = app.inst.out();
  check('installs the real package', has(out, `Installing SwarmCast v${V}`) && has(out, 'Checksum OK') && has(out, `Installed SwarmCast v${V}`), `log: ${app.inst.logFile}`);
  check('installed files in the non-ASCII data folder', isFile(path.join(homeU, 'app', 'current', 'swarmcast.exe')) && ver(homeU) === V, path.join(homeU, 'app', 'current'));
  check('setup log written', isFile(path.join(homeU, 'logs', 'install.log')));
  if (/system-check/.test(helpText)) check('system check saved for the panel tutorial (system-check.json)', isFile(path.join(homeU, 'system-check.json')));
  check('-SkipSpeedtest honored', has(out, 'Speed test skipped'));
  record('elevated note shown (runner is admin)', has(out, 'runs as administrator') ? 'pass' : 'warn', has(out, 'runs as administrator') ? 'warning printed, setup continued' : 'no elevation note although the runner is elevated');
  check('report lists ports 1935/8080/8081 free', /Ports 1935\/8080\/8081\s+free/.test(out));
  const s = await waitLiveLink(app);
  check('-NoTunnel honored (local link, no cloudflared)', /^http:\/\/127\.0\.0\.1:\d+\/join\//.test(s.liveLink) && !processesUnder(homeU).some((p) => /cloudflared/i.test(p.name)));
  await quickStreamCheck(app, browser, 'non-ASCII data folder');
  await quitAndVerify(app, homeU, 'non-ASCII data folder');
  copyAppLogs(homeU, 'first');
});

await section('2. cmd /c start-windows.cmd (double-click equivalent): second run is "Already up to date", starts, quits', async () => {
  browser = await chrome();
  const r = await installerResult(runInstaller({ entry: 'cmd', dir: relDir, releaseUrl: srv.url, home: homeU, args: ['--yes', '--skip-speedtest', '--no-tunnel', '--install-only'], label: 'cmd-install-only' }));
  check('--install-only via cmd: exit 0, "Already up to date"', r.code === 0 && has(r.out, `Already up to date (v${V})`), `exit ${r.code}`);
  check('--install-only does not start the app', !has(r.out, 'Panel: ') && processesUnder(homeU).length === 0);
  const app = await startApp({ entry: 'cmd', dir: relDir, releaseUrl: srv.url, home: homeU, args: ['--yes', '--skip-speedtest', '--no-tunnel'], label: 'cmd-start' });
  onCleanup(() => killUnder(homeU));
  check('cmd entry starts the installed app (GNU-style flags)', has(app.inst.out(), 'Already up to date') && (await app.state()).version === V);
  await waitLiveLink(app);
  await quitAndVerify(app, homeU, 'cmd entry');
});

await section('3. update while SwarmCast is running is refused cleanly', async () => {
  if (!V2) return record('needs a second package (--newer)', 'skip');
  const app = await startApp({ entry: 'ps', dir: relDir, releaseUrl: srv.url, home: homeU, args: yesNoTunnel, label: 'running-app' });
  onCleanup(() => killUnder(homeU));
  await waitLiveLink(app);
  const exeHash = sha256File(path.join(homeU, 'app', 'current', 'swarmcast.exe'));
  const r = await installerResult(runInstaller({ entry: 'ps', dir: relDir, releaseUrl: srvNew.url, home: homeU, args: ['-Yes', '-SkipSpeedtest', '-InstallOnly'], label: 'update-while-running' }));
  check('report warns that SwarmCast ports are in use', has(r.out, 'in use') && has(r.out, 'Maybe SwarmCast is already running'));
  const refused = r.code !== 0 && has(r.out, 'Could not replace the installed version') && has(r.out, 'close it and run this again');
  if (!refused && r.code === 0) {
    record('update while running', 'warn', `the swap succeeded while swarmcast.exe was running (current=${ver(homeU)}, previous=${ver(homeU, 'previous')}); output tail: ${r.out.slice(-600)}`);
  } else {
    check('update refused with a clear message', refused, `exit ${r.code}; ${r.out.slice(-500)}`);
    check('nothing changed (current still the running version)', ver(homeU) === V && sha256File(path.join(homeU, 'app', 'current', 'swarmcast.exe')) === exeHash);
  }
  check('no staging folder left behind', !fs.readdirSync(path.join(homeU, 'app')).some((d) => d.startsWith('.staging-')));
  check('running app unaffected (panel still answers)', (await app.state()).phase !== undefined);
  await quitAndVerify(app, homeU, 'after refused update');
});

await section('4. update to a newer version keeps settings and the previous version', async () => {
  const cfg = path.join(homeU, 'config.json');
  const sec = path.join(homeU, 'secrets.json');
  const before = { cfg: sha256File(cfg), sec: sha256File(sec), key: JSON.parse(readText(sec)).streamKey };
  let target = V2;
  let url = srvNew?.url;
  if (!V2) {
    // Fallback: make the installed copy look older.
    fs.writeFileSync(path.join(homeU, 'app', 'current', 'VERSION'), '0.0.1\n');
    target = V;
    url = srv.url;
  }
  const from = ver(homeU);
  const r = await installerResult(runInstaller({ entry: 'ps', dir: relDir, releaseUrl: url, home: homeU, args: ['-Yes', '-SkipSpeedtest', '-InstallOnly'], label: 'update' }));
  check(`update v${from} -> v${target}: exit 0 and "Updating"`, r.code === 0 && has(r.out, `Updating SwarmCast v${from} -> v${target}`), `exit ${r.code}`);
  check('current is the new version, previous kept for rollback', ver(homeU) === target && ver(homeU, 'previous') === from, `current=${ver(homeU)} previous=${ver(homeU, 'previous')}`);
  check('config.json and secrets.json unchanged (same stream key)', sha256File(cfg) === before.cfg && sha256File(sec) === before.sec);
  if (V2) {
    const browser = await chrome();
    const app = await startApp({ entry: 'cmd', dir: path.join(work, 'rel-new'), releaseUrl: srvNew.url, home: homeU, args: ['--yes', '--skip-speedtest', '--no-tunnel'], label: 'start-new' });
    onCleanup(() => killUnder(homeU));
    const s = await app.state();
    check('the updated app runs and reports the new version, same stream key', s.version === V2 && s.streamKey === before.key, `version ${s.version}`);
    await quickStreamCheck(app, browser, 'updated app');
    await quitAndVerify(app, homeU, 'updated app');
  }
});

await section('5. checksum mismatch aborts with nothing changed', async () => {
  const exe = path.join(homeU, 'app', 'current', 'swarmcast.exe');
  const before = { v: ver(homeU), pv: ver(homeU, 'previous'), exe: sha256File(exe) };
  const r = await installerResult(runInstaller({ entry: 'ps', dir: relDir, releaseUrl: srvBad.url, home: homeU, args: ['-Yes', '-SkipSpeedtest', '-InstallOnly'], label: 'corrupt' }));
  check('setup fails (non-zero exit) with "Checksum mismatch"', r.code !== 0 && has(r.out, 'Checksum mismatch'), `exit ${r.code}`);
  check('message says the download was deleted and nothing changed', has(r.out, 'The download was deleted') && has(r.out, 'was not changed'));
  check('installed version, previous version and binary untouched', ver(homeU) === before.v && ver(homeU, 'previous') === before.pv && sha256File(exe) === before.exe);
  check('no staging folder left behind', !fs.readdirSync(path.join(homeU, 'app')).some((d) => d.startsWith('.staging-')));
});

await section('6. offline with an existing install starts it', async () => {
  const app = await startApp({ entry: 'ps', dir: relDir, releaseUrl: 'http://127.0.0.1:9', home: homeU, args: yesNoTunnel, label: 'offline' });
  onCleanup(() => killUnder(homeU));
  const out = app.inst.out();
  check('warns it could not check for updates and starts the installed version', has(out, 'Could not check for updates') && has(out, `Starting the installed version v${ver(homeU)}`));
  await waitLiveLink(app);
  await quitAndVerify(app, homeU, 'offline start');
});

await section('7. offline with nothing installed fails clearly', async () => {
  const home = path.join(local, 'SC offline empty');
  fs.rmSync(home, { recursive: true, force: true });
  const r = await installerResult(runInstaller({ entry: 'cmd', dir: relDir, releaseUrl: 'http://127.0.0.1:9', home, args: ['--yes', '--skip-speedtest'], label: 'offline-empty' }));
  check('non-zero exit, explains the server is unreachable and mentions the installer zip', r.code !== 0 && has(r.out, 'release server is unreachable') && has(r.out, 'installer zip'), `exit ${r.code}`);
  check('the .cmd wrapper adds its own error line (no pause with SWARMCAST_NO_PAUSE)', has(r.out, 'SwarmCast setup stopped with an error'));
  check('nothing installed', !fs.existsSync(path.join(home, 'app', 'current')));
});

await section('8. one-liner: irm <local>/start-windows.ps1 | iex', async () => {
  const browser = await chrome();
  const home = path.join(local, 'SC one-liner');
  fs.rmSync(home, { recursive: true, force: true });
  // The one-liner takes no options: keep this run local through the config file instead of a tunnel.
  editConfig(home, (c) => (c.tunnel = { provider: 'none' }));
  const app = await startApp({ entry: 'iex', iexUrl: srv.url, releaseUrl: srv.url, home, label: 'iex' });
  onCleanup(() => killUnder(home));
  const out = app.inst.out();
  check('installs from the served script (piped, no script folder)', has(out, `Install source: ${srv.url}`) && has(out, `Installed SwarmCast v${V}`));
  const speed = /Upload speed\s+([\d.]+ Mbps|speed test failed)/.exec(out)?.[1];
  record('speed test ran (no -SkipSpeedtest in the one-liner)', speed ? 'pass' : 'fail', speed ?? 'no "Upload speed" row');
  await quickStreamCheck(app, browser, 'one-liner');
  await quitAndVerify(app, home, 'one-liner');

  // An error in a piped run must not close the user's PowerShell window: the script's "exit"
  // would end the interactive session. Simulated with -NoExit (the window stays only if the
  // host survives the script).
  const home2 = path.join(local, 'SC one-liner error');
  fs.rmSync(home2, { recursive: true, force: true });
  const env = bareEnv({ home: home2, releaseUrl: 'http://127.0.0.1:9' });
  const child = spawn(powershellExe, ['-NoProfile', '-NoExit', '-Command', `irm ${srv.url}/start-windows.ps1 | iex`], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let o = '';
  child.stdout.on('data', (d) => (o += d));
  child.stderr.on('data', (d) => (o += d));
  onCleanup(() => killTree(child.pid));
  const gone = await until(() => child.exitCode !== null, 90_000, 'piped setup error').then(() => true, () => false);
  const errShown = has(o, 'Could not download SwarmCast');
  if (gone) {
    record('piped run: an error keeps the PowerShell window open', 'warn', `BUG: after "${errShown ? 'Could not download SwarmCast…' : 'error'}" the script calls "exit ${child.exitCode}", which closes the interactive PowerShell window of a user who pasted the one-liner, so the message disappears. (start-windows.ps1 Stop-Setup/exit)`);
  } else {
    check('piped run: an error keeps the PowerShell window open', errShown, 'host still alive after the error');
    child.stdin.end('exit\n');
  }
});

await section('9. installer zip: Explorer "Extract All" of a downloaded zip, no release server', async () => {
  const browser = await chrome();
  const zip = path.join(work, `SwarmCast-v${V}-windows-x64-installer.zip`);
  must('installer zip built', isFile(zip), zip);
  const dl = path.join(os.homedir(), 'Downloads', 'SwarmCast installer (teste)');
  fs.rmSync(dl, { recursive: true, force: true });
  fs.mkdirSync(dl, { recursive: true });
  const dlZip = path.join(os.homedir(), 'Downloads', path.basename(zip));
  fs.copyFileSync(zip, dlZip);
  // Mark of the Web, as a browser download has.
  ps(`Set-Content -LiteralPath '${dlZip}' -Stream Zone.Identifier -Value "[ZoneTransfer]\`r\`nZoneId=3\`r\`nHostUrl=https://github.com/"`);
  const how = ps(`Add-Type -AssemblyName System.IO.Compression.FileSystem; $c = ([IO.Compression.ZipFile]::OpenRead('${dlZip}')).Entries.Count
    try { $sh = New-Object -ComObject Shell.Application; $sh.NameSpace('${dl}').CopyHere($sh.NameSpace('${dlZip}').Items(), 0x14)
      $end = (Get-Date).AddSeconds(120); while ((Get-ChildItem -LiteralPath '${dl}').Count -lt $c -and (Get-Date) -lt $end) { Start-Sleep -Milliseconds 500 }
      Start-Sleep 2; 'Shell.Application' } catch { Expand-Archive -LiteralPath '${dlZip}' -DestinationPath '${dl}' -Force; "Expand-Archive ($($_.Exception.Message))" }`);
  info('extracted with', how);
  const motw = ps(`[bool](Get-Item -LiteralPath '${path.join(dl, 'start-windows.ps1')}' -Stream Zone.Identifier -ErrorAction SilentlyContinue)`);
  info('Mark of the Web propagated to the extracted files', motw);
  must('bundle extracted', isFile(path.join(dl, 'start-windows.cmd')) && isFile(path.join(dl, 'SHA256SUMS.txt')), fs.readdirSync(dl).join(', '));

  for (const variant of ['github.com reachable (private repo answers 404)', 'github.com unreachable (hosts file)']) {
    const blocked = variant.includes('unreachable');
    const home = path.join(local, blocked ? 'SC bundle offline' : 'SC bundle');
    fs.rmSync(home, { recursive: true, force: true });
    const hosts = path.join(process.env.SystemRoot, 'System32', 'drivers', 'etc', 'hosts');
    const hostsBefore = readText(hosts);
    if (blocked) {
      fs.appendFileSync(hosts, '\r\n0.0.0.0 github.com\r\n0.0.0.0 objects.githubusercontent.com\r\n0.0.0.0 release-assets.githubusercontent.com\r\n');
      ps('ipconfig /flushdns | Out-Null', { allowFail: true });
    }
    try {
      await srv.close().catch(() => {});
      const app = await startApp({ entry: 'cmd', dir: dl, home, args: ['--yes', '--skip-speedtest', '--no-tunnel'], label: blocked ? 'bundle-offline' : 'bundle' });
      onCleanup(() => killUnder(home));
      const out = app.inst.out();
      check(`[${variant}] installs from the local bundle without downloading`, has(out, 'Install source: local bundle') && has(out, 'from the local bundle (no download)') && has(out, `Installed SwarmCast v${V}`));
      check(`[${variant}] report: online release not needed`, has(out, 'Online release') && (has(out, 'not reachable (fine)') || has(out, 'nothing newer')));
      const exeMotw = ps(`[bool](Get-Item -LiteralPath '${path.join(home, 'app', 'current', 'swarmcast.exe')}' -Stream Zone.Identifier -ErrorAction SilentlyContinue)`);
      check(`[${variant}] installed binaries carry no Mark of the Web`, exeMotw === 'False');
      await quickStreamCheck(app, browser, `bundle, ${blocked ? 'offline' : 'online'}`);
      await quitAndVerify(app, home, `bundle, ${blocked ? 'offline' : 'online'}`);
    } finally {
      if (blocked) {
        fs.writeFileSync(hosts, hostsBefore);
        ps('ipconfig /flushdns | Out-Null', { allowFail: true });
      }
    }
  }
});

// The release server was closed by section 9; serve it again.
const srv2 = await serve(relDir);

await section('10. ports 8080/8081 busy: panel and public server fall back', async () => {
  const browser = await chrome();
  // Both on 127.0.0.1: Windows lets a program bind 127.0.0.1:<port> beside another program's
  // non-exclusive 0.0.0.0:<port> listener (see section 12), which is not a conflict for SwarmCast.
  const a = await occupy(8080, '127.0.0.1');
  const b = await occupy(8081, '127.0.0.1');
  onCleanup(() => a.close());
  onCleanup(() => b.close());
  const app = await startApp({ entry: 'ps', dir: relDir, releaseUrl: srv2.url, home: homeU, args: yesNoTunnel, label: 'busy-8080' });
  onCleanup(() => killUnder(homeU));
  const out = app.inst.out();
  check('report warns: 8080 and 8081 in use, names the program', /in use: 8080 8081/.test(out) && /port 8080 is used by node/i.test(out), (/Ports 1935\/8080\/8081.*/.exec(out) ?? [''])[0]);
  check('panel moved off 8081', app.port !== 8081, `panel port ${app.port}`);
  const s = await waitLiveLink(app);
  const pub = Number(new URL(s.liveLink).port);
  check('public server moved off 8080/8081', pub !== 8080 && pub !== 8081, `public port ${pub}`);
  await quickStreamCheck(app, browser, 'fallback ports');
  await quitAndVerify(app, homeU, 'fallback ports');
});

await section('11. port 1935 busy (127.0.0.1): clear error, recovers when freed', async () => {
  const occ = await occupy(1935, '127.0.0.1');
  let freed = false;
  onCleanup(() => !freed && occ.close());
  const app = await startApp({ entry: 'ps', dir: relDir, releaseUrl: srv2.url, home: homeU, args: yesNoTunnel, label: 'busy-1935' });
  onCleanup(() => killUnder(homeU));
  check('report names the program on port 1935', /port 1935 is used by node/i.test(app.inst.out()));
  const s = await until(async () => {
    const x = await app.state();
    return x.phase === 'off' && x.steps.some((st) => st.status === 'error') ? x : null;
  }, 60_000, 'start failure');
  const step = s.steps.find((st) => st.status === 'error');
  check('start fails on the RTMP port with err.rtmpBusy', step?.errorCode === 'err.rtmpBusy', `${step?.id}: ${step?.error}`);
  check('console shows "Could not start" with the reason', /Could not start: .*1935/.test(app.inst.out()));
  check('no MediaMTX left running', !processesUnder(homeU).some((p) => /mediamtx/i.test(p.name)));
  await occ.close();
  freed = true;
  const r = await app.api('/api/live/start', {});
  check('"Turn on" works once the port is free', r.phase === 'waiting-obs' || r.phase === 'live', `phase ${r.phase}`);
  await quitAndVerify(app, homeU, '1935 recovery');
});

await section('12. port 1935 busy on 0.0.0.0 (another RTMP server): behavior', async () => {
  const occ = await occupy(1935, '0.0.0.0');
  let open = true;
  onCleanup(() => open && occ.close());
  const app = await startApp({ entry: 'ps', dir: relDir, releaseUrl: srv2.url, home: homeU, args: yesNoTunnel, label: 'busy-1935-any' });
  onCleanup(() => killUnder(homeU));
  const s = await until(async () => {
    const x = await app.state();
    return x.phase === 'waiting-obs' || (x.phase === 'off' && x.steps.some((st) => st.status === 'error')) ? x : null;
  }, 60_000, 'start result');
  const step = s.steps.find((st) => st.status === 'error');
  if (s.phase === 'off') {
    check('refused with a clear error', step?.errorCode === 'err.rtmpBusy' || /1935/.test(step?.error ?? ''), `${step?.id}: ${step?.error}`);
  } else {
    // Windows lets 127.0.0.1:1935 be bound next to a non-exclusive 0.0.0.0:1935 listener; OBS on 127.0.0.1 reaches the more specific one.
    const feed = pushStream(s.rtmpUrl, s.streamKey);
    const live = await waitPhase(app, 'live', 60_000).then(() => true, () => false);
    record('started next to the other server; OBS on 127.0.0.1 reaches SwarmCast', live ? 'warn' : 'fail', live ? 'no error: Windows allowed 127.0.0.1:1935 beside 0.0.0.0:1935 and the stream worked; the other program no longer gets local RTMP clients (the installer report did warn about port 1935)' : 'started, but the stream never arrived');
    feed.stop();
  }
  await occ.close();
  open = false;
  await quitAndVerify(app, homeU, '1935 on 0.0.0.0');
});

await section('13. non-elevated (Basic User token via runas /trustlevel:0x20000)', async () => {
  const home = path.join(local, 'SC basic user');
  fs.rmSync(home, { recursive: true, force: true });
  const dir = 'C:\\sc-basic';
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const outLog = path.join(dir, 'out.log');
  const wrapper = path.join(dir, 'w.cmd');
  const env = bareEnv({ home, releaseUrl: srv2.url });
  fs.writeFileSync(
    wrapper,
    [
      '@echo off',
      `set "Path=${env.Path}"`,
      `set "SWARMCAST_HOME=${home}"`,
      `set "SWARMCAST_RELEASE_URL=${srv2.url}"`,
      'set "SWARMCAST_NO_PAUSE=1"',
      `whoami /groups | findstr /i "Mandatory" > "${path.join(dir, 'groups.txt')}"`,
      `call "${path.join(relDir, 'start-windows.cmd')}" --yes --skip-speedtest --no-tunnel > "${outLog}" 2>&1`,
      `echo EXIT %ERRORLEVEL% >> "${outLog}"`,
      '',
    ].join('\r\n'),
  );
  const r = ps(`$p = Start-Process -FilePath runas.exe -ArgumentList '/trustlevel:0x20000','"cmd /d /c ${wrapper}"' -PassThru -WindowStyle Hidden; $p.WaitForExit(30000) | Out-Null; "runas exit $($p.ExitCode)"`, { allowFail: true });
  info('runas', r);
  const text = () => readText(outLog);
  let app;
  try {
    const admin = await adminLogin(text, 240_000);
    app = { ...admin, inst: { exit: until(() => /EXIT (\d+)/.exec(text()), 90_000, 'exit').then((m) => Number(m[1]), () => 'timeout'), child: { pid: 0 } } };
  } catch (e) {
    record('started with a Basic User token', 'fail', `${e.message}; output: ${text().slice(-1500)}`);
    return;
  }
  onCleanup(() => killUnder(home));
  const groups = readText(path.join(dir, 'groups.txt'));
  info('token integrity level', groups.trim().replace(/\s+/g, ' ').slice(0, 200));
  check('ran without admin rights (no "runs as administrator" note)', !has(text(), 'runs as administrator'), /Medium/i.test(groups) ? 'Medium integrity' : groups.slice(0, 120));
  check('installed for the user only', ver(home) === V);
  await waitLiveLink(app);
  await app.api('/api/app/quit', {}).catch(() => {});
  const code = await app.inst.exit;
  check('Basic User run: quits cleanly', code === 0, `exit ${code}`);
  await sleep(1500);
  const left = processesUnder(home);
  check('Basic User run: no process left', left.length === 0, describeProcs(left));
});

await section('14. uninstaller (-KeepSettings while live, reinstall keeps the stream key, full uninstall from the installer zip)', async () => {
  if (!fs.existsSync(uninstallCmd)) return record('scripts/uninstall-windows.cmd not on this commit', 'skip');
  const browser = await chrome();
  const keyBefore = JSON.parse(readText(path.join(homeU, 'secrets.json'))).streamKey;
  const app = await startApp({ entry: 'ps', dir: relDir, releaseUrl: srv2.url, home: homeU, args: yesNoTunnel, label: 'before-uninstall-keep' });
  onCleanup(() => killUnder(homeU));
  await quickStreamCheck(app, browser, 'before uninstall');
  const s0 = await waitLiveLink(app);
  pushStream(s0.rtmpUrl, s0.streamKey);
  await waitPhase(app, 'live');
  await uninstallAndVerify({ dir: relDir, home: homeU, args: ['-KeepSettings'], label: 'uninstall -KeepSettings during a live (non-ASCII folder)' });
  const r = await installerResult(runInstaller({ entry: 'ps', dir: relDir, releaseUrl: srv2.url, home: homeU, args: ['-Yes', '-SkipSpeedtest', '-InstallOnly'], label: 'reinstall' }));
  check('reinstall after -KeepSettings reuses the same stream key', r.code === 0 && JSON.parse(readText(path.join(homeU, 'secrets.json'))).streamKey === keyBefore, `exit ${r.code}`);
  // Full uninstall after a live, run from the extracted installer zip (as the streamer would).
  const dl = path.join(os.homedir(), 'Downloads', 'SwarmCast installer (teste)');
  const app2 = await startApp({ entry: 'ps', dir: relDir, releaseUrl: srv2.url, home: homeU, args: yesNoTunnel, label: 'before-uninstall' });
  await quickStreamCheck(app2, browser, 'before full uninstall');
  check('installer zip contains the uninstaller', fs.existsSync(path.join(dl, 'uninstall-windows.cmd')) && fs.existsSync(path.join(dl, 'uninstall-windows.ps1')));
  await uninstallAndVerify({ dir: fs.existsSync(path.join(dl, 'uninstall-windows.cmd')) ? dl : relDir, home: homeU, label: 'full uninstall after a live, from the installer zip' });
  const again = await uninstallAndVerify({ dir: relDir, home: homeU, label: 'second uninstall (nothing installed)' });
  if (again) check('second uninstall says nothing to do', /not installed on this computer/i.test(again.out));
});

await srv2.close();
await srvNew?.close();
await srvBad.close();
finish();
