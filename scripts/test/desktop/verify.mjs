#!/usr/bin/env node
// Clean-machine test of the desktop app installers (docs/DESKTOP.md, "Testing"), run by
// .github/workflows/_desktop.yml (clean-machine job) on fresh CI machines. It changes the machine (installs the
// app, writes the autostart entry, deletes the SwarmCast data folder): do not run it on yours.
//
//   node scripts/test/desktop/verify.mjs --installers release/desktop/<target> \
//        [--update-from <dir A> --update-to <dir B with latest.json> --update-port 47811]
//
// 1. Installs the real installer (Windows NSIS /S, macOS .dmg -> ~/Applications, Linux .deb),
//    starts the app, logs into the panel (admin API), checks /api/desktop, turns "Start with
//    the computer" on and off (Run key / LaunchAgent / XDG entry), kills the app (its server
//    and tools must go with it: the Windows Job object), starts it again, quits from the panel
//    (nothing left running) and uninstalls (NSIS uninstaller / apt remove). Linux runs the
//    AppImage first, before the .deb brings WebKitGTK onto the machine. Then installs again and
//    removes everything with scripts/uninstall-*.
// 2. Update: installs build A (macOS: from its .app.tar.gz, Linux: the AppImage), serves build
//    B and its latest.json on 127.0.0.1, starts A, clicks "Update now" through the panel API
//    right after the login and expects B to come back by itself with config.json and
//    secrets.json unchanged. That first round also tests the update channels: B is only on the
//    beta feed, so with "Get beta versions" off A finds nothing, and turning it on (panel API)
//    offers B at once. macOS and Linux then do it again with "Update now" sent the moment
//    the server is ready, while the window is still on the splash or opening the panel (that
//    crashed the macOS shell: wry panicked in WebviewWindow::url()).
//
// The panel login URL comes from SWARMCAST_TEST_LOGIN_FILE (written by the server). --junit FILE
// also writes the steps as JUnit XML.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { debianVersion, isPrerelease } from '../../releases/semver.mjs';
import { writeJunit } from '../lib/junit.mjs';
import { poll } from '../lib/wait.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const args = process.argv.slice(2);
const opt = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const OS = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform];
const home = os.homedir();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-desktop-'));
const loginFile = path.join(work, 'login.txt');
const dataDir = {
  windows: path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'SwarmCast'),
  macos: path.join(home, 'Library', 'Application Support', 'SwarmCast'),
  linux: path.join(process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'swarmcast'),
}[OS];
const winInstallDir = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'SwarmCast');
const macApp = path.join(home, 'Applications', 'SwarmCast.app');
const appImageDir = path.join(home, 'Applications');
const autostartEntry = {
  macos: path.join(home, 'Library', 'LaunchAgents', 'io.github.lucas-angelo.swarmcast.plist'),
  linux: path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'autostart', 'swarmcast.desktop'),
}[OS];

let failures = 0;
const steps = [];
function step(name, ok, detail = '') {
  steps.push({ group: `desktop ${OS}`, name, status: ok ? 'pass' : 'fail', detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) {
    failures += 1;
    throw new Error(`${name} failed${detail ? `: ${detail}` : ''}`);
  }
}
/** `fn`'s first truthy value, polled every `every` ms (scripts/test/lib/wait.mjs poll: a throw means "not yet"). */
const until = (fn, ms, what, every = 500) => poll(fn, { timeoutMs: ms, what, everyMs: every });
function run(cmd, argv, o = {}) {
  console.log(`$ ${cmd} ${argv.join(' ')}`);
  const r = spawnSync(cmd, argv, { stdio: 'inherit', timeout: 300_000, ...o });
  if (r.status !== 0 && !o.allowFail) throw new Error(`${cmd} exited with ${r.status ?? r.signal}`);
  return r.status;
}
const file = (dir, re) => {
  const f = fs.readdirSync(dir).find((n) => re.test(n));
  if (!f) throw new Error(`no file matching ${re} in ${dir}`);
  return path.join(dir, f);
};

// ---------------------------------------------------------------- processes

const OURS = /SwarmCast\.app\/|swarmcast-desktop|swarmcast-server|SwarmCast_.*\.AppImage|\/mediamtx|cloudflared/;

/** Every process as "pid command line". Linux reads /proc: a minimal host has no `ps`. */
function processes() {
  if (OS === 'linux') {
    return fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).flatMap((pid) => {
      try {
        const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim();
        return cmd ? [`${pid} ${cmd}`] : [];
      } catch {
        return []; // gone meanwhile
      }
    });
  }
  return spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout.split('\n');
}

/** SwarmCast processes still running (the shell, the server, MediaMTX, cloudflared). */
function ours() {
  if (OS === 'windows') {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-Process SwarmCast,swarmcast-server,mediamtx,cloudflared -ErrorAction SilentlyContinue | ForEach-Object { \"$($_.Id) $($_.Path)\" }"], { encoding: 'utf8' });
    return r.stdout.split(/\r?\n/).filter(Boolean);
  }
  return processes().filter((l) => OURS.test(l) && !l.includes('verify.mjs'));
}
async function nothingLeft(what) {
  const left = await until(() => ours().length === 0, 45_000, 'every SwarmCast process to exit').then(() => []).catch(() => ours());
  step(`${what}: nothing left running`, left.length === 0, left.join('; '));
}

// ---------------------------------------------------------------- the Run key (Windows)

/**
 * Windows: every state of HKCU\...\Run during the test, with the time (run-key.log), printed when
 * the test fails: another program writing the key while "Start with the computer" is switched
 * shows up here. Read-only (.NET registry API, every 10 ms).
 */
const RUN_KEY_JOURNAL_PS = `
$p = 'Software\\Microsoft\\Windows\\CurrentVersion\\Run'; $last = $null
while ($true) {
  $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($p)
  if ($k) { $s = ($k.GetValueNames() | Sort-Object | ForEach-Object { $_ + '=' + $k.GetValue($_, '', 'DoNotExpandEnvironmentNames') }) -join ' | '; $k.Close(); if ($s -eq '') { $s = '(empty)' } } else { $s = '(no Run key)' }
  if ($s -ne $last) { [Console]::Out.WriteLine([DateTime]::UtcNow.ToString('o') + ' ' + $s); [Console]::Out.Flush(); $last = $s }
  Start-Sleep -Milliseconds 10
}`;
const runKeyLog = path.join(work, 'run-key.log');
let runKeyJournal = null;
function startRunKeyJournal() {
  if (OS !== 'windows') return;
  const out = fs.openSync(runKeyLog, 'a');
  runKeyJournal = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', RUN_KEY_JOURNAL_PS], { stdio: ['ignore', out, out], windowsHide: true });
  fs.closeSync(out);
}
/** Windows: what Microsoft Defender detected on this machine (a removed Run value would be one). */
function defenderDetections() {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-MpThreatDetection | Format-List InitialDetectionTime,ThreatID,ProcessName,Resources,ActionSuccess | Out-String -Width 300'], { encoding: 'utf8', timeout: 60_000 });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() || 'none';
}

// ---------------------------------------------------------------- the app and its panel

let child = null;
/** Where this start of the app begins in app-output.log (the file collects every start). */
let childLogStart = 0;
let debPackage = '';
/** The variables every app start in this test gets (and the updated app inherits). */
const testEnv = () => ({ SWARMCAST_TEST_LOGIN_FILE: loginFile, SWARMCAST_NO_FFMPEG_INSTALL: '1', SWARMCAST_NO_OPEN: '1', APPIMAGE_EXTRACT_AND_RUN: '1' });

/** Starts the installed app (without waiting for it). */
function spawnApp(exe, env = {}, argv = []) {
  fs.rmSync(loginFile, { force: true });
  const out = fs.openSync(path.join(work, 'app-output.log'), 'a');
  childLogStart = fs.fstatSync(out).size;
  child = spawn(exe, argv, { stdio: ['ignore', out, out], env: { ...process.env, ...testEnv(), ...env } });
  child.on('error', (err) => console.log(`spawn error: ${err.message}`));
}

/** Starts the installed app and logs into its panel. */
async function launch(exe, env = {}, argv = []) {
  spawnApp(exe, env, argv);
  return login();
}

/** The panel login URL, as soon as the server has written it (every 50 ms). */
const loginUrl = () => until(() => fs.existsSync(loginFile) && fs.readFileSync(loginFile, 'utf8').trim(), 120_000, 'the app to start its server (login URL)', 50);

/** The panel's session cookie, from the login URL. */
async function authenticate(url) {
  const u = new URL(url);
  const res = await request({ port: u.port, path: u.pathname });
  const cookie = String(res.headers['set-cookie'] ?? '').split(';')[0];
  step('panel login', res.status < 400 && cookie.includes('='), `HTTP ${res.status}`);
  return { port: Number(u.port), cookie };
}

async function login() {
  const panel = await authenticate(await loginUrl());
  const page = await request({ port: panel.port, path: '/', cookie: panel.cookie });
  step('panel page loads behind the login', page.status === 200 && page.body.includes('<html'), `HTTP ${page.status}`);
  const anon = await request({ port: panel.port, path: '/api/state' });
  step('the admin API refuses requests without the login', anon.status === 401, `HTTP ${anon.status}`);
  return panel;
}

function request({ port, path: p, method = 'GET', cookie, body }) {
  return new Promise((resolve, reject) => {
    const headers = { host: `127.0.0.1:${port}` };
    if (cookie) headers.cookie = cookie;
    if (method !== 'GET') Object.assign(headers, { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' });
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers, timeout: 15_000 }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data ?? (method === 'GET' ? undefined : '{}'));
  });
}
async function api(panel, method, p, body) {
  const res = await request({ port: panel.port, path: p, method, cookie: panel.cookie, body });
  if (res.status !== 200) throw new Error(`${method} ${p}: HTTP ${res.status} ${res.body.slice(0, 300)}`);
  return JSON.parse(res.body);
}

async function checkDesktopApi(panel, version) {
  const info = await api(panel, 'GET', '/api/desktop');
  step('/api/desktop reports the desktop app', info.desktop === true && info.version === version, `desktop=${info.desktop} version=${info.version}, expected ${version}`);
}

function autostartPresent() {
  if (OS === 'windows') {
    return spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'SwarmCast'], { stdio: 'ignore' }).status === 0;
  }
  return fs.existsSync(autostartEntry);
}
async function checkAutostart(panel) {
  step('"Start with the computer" is off by default', !autostartPresent());
  const on = await api(panel, 'PUT', '/api/desktop/autostart', { enabled: true });
  step('turning "Start with the computer" on writes the OS entry', on.autostart?.enabled === true && autostartPresent(), JSON.stringify(on.autostart));
  const off = await api(panel, 'PUT', '/api/desktop/autostart', { enabled: false });
  step('turning it off removes the entry', off.autostart?.enabled === false && !autostartPresent(), JSON.stringify(off.autostart));
}

/** How the app ended (`null` while it runs). */
function childExit() {
  if (child.exitCode === null && child.signalCode === null) return null;
  return child.signalCode ? `signal ${child.signalCode}` : `exit code ${child.exitCode}`;
}

/** What a crashing app leaves in its output (macOS / Rust / glibc). */
const CRASH_MARKERS = /uncaught exception|libc\+\+abi: terminating|panicked at|fatal runtime error|Segmentation fault|Abort trap|EXC_BAD_ACCESS/;

/** What this start of the app wrote to app-output.log (one descriptor: no check-then-read). */
function appOutputSinceStart() {
  let fd;
  try {
    fd = fs.openSync(path.join(work, 'app-output.log'), 'r');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
  try {
    const length = Math.max(0, fs.fstatSync(fd).size - childLogStart);
    const buf = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = fs.readSync(fd, buf, read, length - read, childLogStart + read);
      if (n === 0) break;
      read += n;
    }
    return buf.subarray(0, read).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Called when the app is already gone before this test killed it. That is fine only if it
 * demonstrably did not crash (exit code 0, nothing crash-like in its output); otherwise the
 * test fails here, and the caller prints app-output.log.
 */
async function checkGoneBeforeKill() {
  await until(() => childExit() !== null, 10_000, 'the exit status of the app').catch(() => {});
  const output = appOutputSinceStart();
  const crash = output.match(CRASH_MARKERS);
  if (child.exitCode !== 0 || child.signalCode !== null || crash) {
    throw new Error(`the app crashed before the test killed it (${childExit() ?? 'exit status unknown'}${crash ? `, output: "${crash[0]}"` : ''}): see app-output.log below`);
  }
  console.log('note: the app had already exited cleanly (exit code 0, no crash in its output) before the kill');
}

/** Killing the app (no clean quit) must take its server and tools down too. */
async function killApp(what) {
  const pid = child.pid;
  if (childExit() !== null) await checkGoneBeforeKill();
  else if (OS === 'windows') run('taskkill', ['/F', '/PID', String(pid)], { allowFail: true });
  else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (err) {
      if (err.code !== 'ESRCH') throw err;
      await checkGoneBeforeKill();
    }
  }
  await nothingLeft(what);
}

async function quitFromPanel(panel) {
  await api(panel, 'POST', '/api/app/quit');
  const exited = await until(() => child.exitCode !== null || child.signalCode !== null, 60_000, 'the app to quit').then(() => true, () => false);
  step('"Quit SwarmCast" in the panel closes the app', exited);
  await nothingLeft('after quitting');
}

// ---------------------------------------------------------------- install / uninstall per OS

/** Pauses before the next `hdiutil detach` while the volume is busy; then it is forced. */
const DETACH_BUSY_PAUSES_MS = [2000, 4000, 8000];

/**
 * `hdiutil detach`. Infra recovery, not a retry of SwarmCast: right after a mount, macOS
 * services of the runner (XProtect, Spotlight) can keep the new volume busy for a few seconds
 * ("Resource busy"). Only that is waited out (logged), then the detach is forced; any other
 * failure fails at once.
 */
async function detach(mnt) {
  for (let i = 0; ; i++) {
    const force = i === DETACH_BUSY_PAUSES_MS.length;
    console.log(`$ hdiutil detach ${force ? '-force ' : ''}${mnt}`);
    const r = spawnSync('hdiutil', ['detach', ...(force ? ['-force'] : []), mnt], { encoding: 'utf8', timeout: 120_000 });
    process.stdout.write(`${r.stdout ?? ''}${r.stderr ?? ''}`);
    if (r.status === 0) return;
    if (force || !/Resource busy/i.test(`${r.stdout}${r.stderr}`)) throw new Error(`hdiutil detach ${mnt} exited with ${r.status ?? r.signal}`);
    console.log(`infra recovery: hdiutil detach of ${mnt}: the volume is still busy (try ${i + 1} of ${DETACH_BUSY_PAUSES_MS.length + 1}), next try in ${DETACH_BUSY_PAUSES_MS[i] / 1000} s`);
    await new Promise((r) => setTimeout(r, DETACH_BUSY_PAUSES_MS[i]));
  }
}

async function install(dir) {
  if (OS === 'windows') {
    run(file(dir, /_x64-setup\.exe$/), ['/S']);
    const exe = path.join(winInstallDir, 'SwarmCast.exe');
    step('NSIS silent install', fs.existsSync(exe), exe);
    return exe;
  }
  if (OS === 'macos') {
    const mnt = path.join(work, 'dmg');
    run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noverify', '-mountpoint', mnt, file(dir, /\.dmg$/)]);
    fs.mkdirSync(path.dirname(macApp), { recursive: true });
    fs.rmSync(macApp, { recursive: true, force: true });
    run('cp', ['-R', path.join(mnt, 'SwarmCast.app'), macApp]);
    await detach(mnt);
    const exe = path.join(macApp, 'Contents', 'MacOS', 'SwarmCast');
    step('the .dmg holds SwarmCast.app (copied to ~/Applications)', fs.existsSync(exe), exe);
    return exe;
  }
  const deb = file(dir, /\.deb$/);
  debPackage = spawnSync('dpkg-deb', ['--field', deb, 'Package'], { encoding: 'utf8' }).stdout.trim();
  // A pre-release must sort below its stable version for dpkg (0.3.0~beta.1 < 0.3.0).
  const debVersion = spawnSync('dpkg-deb', ['--field', deb, 'Version'], { encoding: 'utf8' }).stdout.trim();
  const v = versionIn(dir);
  step(`the .deb's Version is ${debianVersion(v)}`, debVersion === debianVersion(v), debVersion);
  if (isPrerelease(v)) {
    const stable = v.replace(/-.*$/, '');
    step(`dpkg sorts ${debVersion} below ${stable}`, spawnSync('dpkg', ['--compare-versions', debVersion, 'lt', stable]).status === 0);
  }
  // No time limit: apt resolving the .deb's dependencies is part of the test, and a slow mirror
  // is not a failure (the workflow downloads them beforehand; the job timeout is the backstop).
  // The workflow downloads them with apt-retry.sh into $APT_DEBS (the .deb cache).
  const cache = process.env.APT_DEBS ? ['-o', `Dir::Cache::archives=${process.env.APT_DEBS}`] : [];
  run('sudo', ['apt-get', 'install', '-y', '--no-install-recommends', '-o', 'Acquire::Retries=3', ...cache, deb], { timeout: undefined });
  step(`the .deb (package ${debPackage}) installs swarmcast-desktop`, fs.existsSync('/usr/bin/swarmcast-desktop'));
  return '/usr/bin/swarmcast-desktop';
}

/** macOS: the app from the updater's .app.tar.gz (what an update unpacks), into ~/Applications. */
function installAppTarGz(dir) {
  const archive = file(dir, /\.app\.tar\.gz$/);
  fs.mkdirSync(path.dirname(macApp), { recursive: true });
  fs.rmSync(macApp, { recursive: true, force: true });
  run('tar', ['-xzf', archive, '-C', path.dirname(macApp)]);
  const exe = path.join(macApp, 'Contents', 'MacOS', 'SwarmCast');
  step(`${path.basename(archive)} holds SwarmCast.app (unpacked to ~/Applications)`, fs.existsSync(exe), exe);
  return exe;
}

/** Linux: the AppImage, where people keep them (the uninstall script looks there). */
function installAppImage(dir) {
  const src = file(dir, /\.AppImage$/);
  fs.mkdirSync(appImageDir, { recursive: true });
  const dest = path.join(appImageDir, path.basename(src));
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o755);
  return dest;
}

/** The update test's build A: without a .dmg or .deb (_desktop.yml builds it with app / appimage / nsis). */
async function installUpdateFrom(dir) {
  if (OS === 'linux') return installAppImage(dir);
  if (OS === 'macos') return installAppTarGz(dir);
  return install(dir);
}

async function nativeUninstall() {
  if (OS === 'windows') {
    // `_?=<dir>` (last, unquoted) runs the uninstaller in place, so it can be waited for and its
    // exit code means something (0 ok, 1 cancelled, 2 aborted); it then leaves itself behind.
    const status = run(path.join(winInstallDir, 'uninstall.exe'), ['/S', `_?=${winInstallDir}`], { allowFail: true });
    step('NSIS uninstaller exits with 0', status === 0, `exit ${status}`);
    step('NSIS uninstaller removes the app', !fs.existsSync(path.join(winInstallDir, 'SwarmCast.exe')));
    step('...and keeps the settings (no "delete app data")', fs.existsSync(path.join(dataDir, 'config.json')));
    fs.rmSync(winInstallDir, { recursive: true, force: true });
  } else if (OS === 'linux') {
    run('sudo', ['apt-get', 'remove', '-y', debPackage]);
    step('apt remove removes the app', !fs.existsSync('/usr/bin/swarmcast-desktop'));
  }
}

function scriptUninstall(exe) {
  if (OS === 'windows') run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'uninstall-windows.ps1')]);
  else run('bash', [path.join(root, 'scripts', OS === 'macos' ? 'uninstall-macos.command' : 'uninstall-linux.sh')], { env: { ...process.env, SWARMCAST_NO_PAUSE: '1' } });
  step('scripts/uninstall-* removes the app', !fs.existsSync(exe), exe);
  step('scripts/uninstall-* removes the data folder', !fs.existsSync(dataDir), dataDir);
  step('no autostart entry is left', !autostartPresent());
}

// ---------------------------------------------------------------- 1. the real installer

/** The version in the installers' file names (package.json's otherwise). */
function versionIn(dir) {
  const fallback = fs.existsSync(path.join(root, 'package.json')) ? JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version : '?';
  return fs.readdirSync(dir).map((n) => /_(\d+\.\d+\.\d+[^_]*)_/.exec(n)?.[1]).find(Boolean) ?? fallback;
}

/** Linux: the AppImage on its own (start, panel, /api/desktop, quit). */
async function appImageTest(dir) {
  const v = versionIn(dir);
  console.log(`\n=== AppImage ${v}`);
  const exe = installAppImage(dir);
  const panel = await launch(exe);
  await checkDesktopApi(panel, v);
  await quitFromPanel(panel);
  return exe;
}

async function installerTest(dir) {
  const v = versionIn(dir);
  // Linux: the AppImage first, while the machine has none of the .deb's libraries (WebKitGTK…):
  // a library the AppImage should bundle but does not then fails here.
  const appImage = OS === 'linux' ? await appImageTest(dir) : null;
  console.log(`\n=== installer ${v} (${OS})`);
  const exe = await install(dir);
  let panel = await launch(exe);
  await checkDesktopApi(panel, v);
  await checkAutostart(panel);
  await killApp('after killing the app');
  panel = await launch(exe);
  await quitFromPanel(panel);
  await nativeUninstall();

  if (OS === 'windows') {
    await install(dir);
    await quitFromPanel(await launch(exe));
  }
  console.log('\n=== scripts/uninstall-*');
  scriptUninstall(appImage ?? exe);
}

// ---------------------------------------------------------------- 2. update A -> B

/**
 * Windows: the NSIS installer relaunches the updated app, and when it runs elevated (as on the
 * CI runner) it does so with an environment made from the user's profile, without this test's
 * variables. HKCU\Environment is part of that profile, so they go there for the update and are
 * removed afterwards.
 */
function userEnvironment(vars) {
  if (OS !== 'windows') return () => {};
  for (const [name, value] of Object.entries(vars)) run('reg', ['add', 'HKCU\\Environment', '/v', name, '/t', 'REG_SZ', '/d', value, '/f']);
  return () => {
    for (const name of Object.keys(vars)) run('reg', ['delete', 'HKCU\\Environment', '/v', name, '/f'], { allowFail: true });
  };
}

/**
 * One update A -> B. `atReady`: "Update now" goes out the moment the server has written its login
 * URL, i.e. while the shell is still on the splash or just navigating to the panel; otherwise
 * right after the panel login, like a streamer clicking at once. No delay either way: the shell
 * must cope (it used to crash on macOS).
 */
/** Feed requests seen by the local update server (file names). */
const feedRequests = [];

/**
 * The update channels against the real shell: the stable feed (SWARMCAST_UPDATE_URL) answers
 * 404 and B is only on the beta feed (SWARMCAST_BETA_UPDATE_URL). On stable, A's first check
 * (10 s after start) reads only the stable feed and finds nothing; "Get beta versions" on makes
 * the shell check both feeds right away and offer B.
 */
async function channelChecks(panel, manifest) {
  let info = await api(panel, 'GET', '/api/desktop');
  step('the update channel is the saved choice (stable)', info.updateChannel?.choice === 'stable' && info.updateChannel?.effective === 'stable', JSON.stringify(info.updateChannel));
  await until(async () => (await api(panel, 'GET', '/api/desktop')).update?.status === 'none', 90_000, 'the first automatic check on the stable channel');
  step('stable channel: no update (the beta feed is not read)', feedRequests.includes('stable.json') && !feedRequests.includes('beta.json'), feedRequests.join(', '));
  info = await api(panel, 'PUT', '/api/desktop/update/channel', { channel: 'beta' });
  step('"Get beta versions" on: saved, the shell checks again', info.updateChannel?.effective === 'beta', JSON.stringify(info.updateChannel));
  info = await until(async () => {
    const d = await api(panel, 'GET', '/api/desktop');
    return d.update?.status === 'available' ? d : null;
  }, 90_000, 'the update offered on the beta channel');
  step(`beta channel: ${manifest.version} offered from the beta feed`, info.update.version === manifest.version && feedRequests.includes('beta.json'), `${info.update.version}; ${feedRequests.join(', ')}`);
}

async function updateRound(dirA, manifest, env, atReady, channels = false) {
  const what = atReady ? 'the moment the server is ready (window on the splash)' : 'right after the panel login';
  console.log(`\n=== update to ${manifest.version}: "Update now" ${what}`);
  const exe = await installUpdateFrom(dirA);
  const config = path.join(dataDir, 'config.json');
  const secrets = path.join(dataDir, 'secrets.json');
  const log = path.join(dataDir, 'logs', 'desktop.log');
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  let before;
  let logFrom;
  let panel;
  if (atReady) {
    // Needs the settings of an earlier start to compare against (the other round runs first).
    before = [read(config), read(secrets)];
    logFrom = read(log).length;
    spawnApp(exe, env);
    const url = await loginUrl();
    const seen = Date.now();
    fs.rmSync(loginFile, { force: true });
    panel = await authenticate(url);
    await api(panel, 'POST', '/api/desktop/update/install');
    console.log(`"Update now" sent ${Date.now() - seen} ms after the login URL appeared`);
  } else {
    if (channels) {
      // "Get beta versions" off (stable) before A's first start; B is only on the beta feed.
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(config, `${JSON.stringify({ updates: { channel: 'stable' } })}\n`);
    }
    panel = await launch(exe, env);
    await until(() => fs.existsSync(config) && fs.existsSync(secrets), 30_000, 'config.json and secrets.json');
    if (channels) await channelChecks(panel, manifest);
    before = [read(config), read(secrets)];
    logFrom = read(log).length;
    fs.rmSync(loginFile, { force: true });
    await api(panel, 'POST', '/api/desktop/update/install');
    console.log('"Update now" sent');
  }
  console.log('waiting for the new version to start by itself');
  const restarted = (t) => {
    const i = t.indexOf(`SwarmCast desktop ${manifest.version} starting`);
    return i >= 0 && t.indexOf('ready, opening the panel', i) > 0;
  };
  await until(() => restarted(read(log).slice(logFrom)), 300_000, `SwarmCast ${manifest.version} to start by itself`);
  step(`the app relaunched itself as ${manifest.version} and its server is ready`, true);
  const after = [read(config), read(secrets)];
  step('config.json is unchanged by the update', JSON.stringify(JSON.parse(after[0])) === JSON.stringify(JSON.parse(before[0])));
  step('secrets.json is unchanged by the update', after[1] === before[1]);
  // The new version got this test's environment too (Windows: through HKCU\Environment).
  panel = await login();
  await checkDesktopApi(panel, manifest.version);
  await api(panel, 'POST', '/api/app/quit');
  await nothingLeft('after closing the updated app');
  return exe;
}

async function updateTest(dirA, dirB, port) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dirB, 'latest.json'), 'utf8'));
  console.log(`\n=== update to ${manifest.version} (${OS})`);
  const server = http.createServer((req, res) => {
    const name = path.basename(decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1)));
    if (name.endsWith('.json')) feedRequests.push(name);
    // The channel round: beta.json is B's manifest, stable.json (no such file) a feed without B.
    const f = path.join(dirB, name === 'beta.json' ? 'latest.json' : name);
    console.log(`update server: GET /${name.replace(/[\r\n]/g, "")}`);
    if (!name || !fs.existsSync(f) || !fs.statSync(f).isFile()) return res.writeHead(404).end();
    res.writeHead(200, { 'content-length': fs.statSync(f).size });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${port}`;
  // First round: the two channel feeds. Second round: SWARMCAST_UPDATE_URL alone (one feed).
  const channelEnv = { SWARMCAST_UPDATE_URL: `${base}/stable.json`, SWARMCAST_BETA_UPDATE_URL: `${base}/beta.json` };
  const env = { SWARMCAST_UPDATE_URL: `${base}/latest.json` };
  const restoreUserEnv = userEnvironment({ ...testEnv(), ...channelEnv });
  try {
    let exe = await updateRound(dirA, manifest, channelEnv, false, true);
    // Windows: reinstalling A over B is a downgrade the NSIS installer handles differently; the
    // early click is a macOS/Linux shell bug (wry), so it runs there.
    if (OS !== 'windows') exe = await updateRound(dirA, manifest, env, true);
    scriptUninstall(exe); // updated in place
  } finally {
    restoreUserEnv();
    server.close();
  }
}

// ---------------------------------------------------------------- optional: guide screenshots

// SC_DESKTOP_SCREENSHOTS=<dir> (Windows only, artifacts for the website guide, no checks): runs
// the installer with its normal pages (Enter on each), captures each page and the app window,
// then removes everything again so the real test starts from a clean machine.
// -Signature prints the texts of the window's controls instead (a new page has other texts).
const WIN_SHOT_PS = String.raw`
param([string]$Out = '', [int]$ProcId = 0, [string]$Keys = '', [switch]$Signature)
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text; using System.Threading;
public class ScWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool UpdateWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("dwmapi.dll")] public static extern int DwmFlush();
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);
  // The texts of every control of the window, in order.
  public static string Texts(IntPtr h) {
    StringBuilder all = new StringBuilder();
    EnumChildWindows(h, delegate (IntPtr c, IntPtr l) { StringBuilder sb = new StringBuilder(512); GetWindowText(c, sb, 512); all.Append(sb).Append('|'); return true; }, IntPtr.Zero);
    return all.ToString();
  }
  // In front (or 2 s passed), repainted, and on the screen: the next composed frame is shown.
  public static void Front(IntPtr h) {
    SetForegroundWindow(h);
    DateTime end = DateTime.UtcNow.AddSeconds(2);
    while (GetForegroundWindow() != h && DateTime.UtcNow < end) Thread.Sleep(20);
    UpdateWindow(h);
    DwmFlush();
  }
}
"@
[ScWin]::SetProcessDPIAware() | Out-Null
$h = [IntPtr]::Zero
if ($ProcId -gt 0) { $p = Get-Process -Id $ProcId -ErrorAction SilentlyContinue; if ($p) { $h = $p.MainWindowHandle } }
if ($Signature) { if ($h -ne [IntPtr]::Zero) { [ScWin]::Texts($h) }; exit 0 }
if ($h -ne [IntPtr]::Zero) { [ScWin]::Front($h) }
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save($Out + '-screen.png'); $g.Dispose()
if ($h -ne [IntPtr]::Zero) {
  $r = New-Object ScWin+RECT; [ScWin]::GetWindowRect($h, [ref]$r) | Out-Null
  $x = [Math]::Max(0, $r.L); $y = [Math]::Max(0, $r.T); $w = [Math]::Min($b.Width, $r.R) - $x; $hh = [Math]::Min($b.Height, $r.B) - $y
  if ($w -gt 10 -and $hh -gt 10) { $bmp.Clone((New-Object System.Drawing.Rectangle $x, $y, $w, $hh), $bmp.PixelFormat).Save($Out + '-window.png') }
}
$bmp.Dispose()
if ($Keys) { [System.Windows.Forms.SendKeys]::SendWait($Keys) }
`;

async function windowsGuideShots(dir, out) {
  fs.mkdirSync(out, { recursive: true });
  const ps1 = path.join(work, 'shot.ps1');
  fs.writeFileSync(ps1, WIN_SHOT_PS);
  const shot = (name, pid = 0, keys = '') =>
    spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Out', path.join(out, name), '-ProcId', String(pid), ...(keys ? ['-Keys', keys] : [])], { stdio: 'inherit', timeout: 60_000 });
  /** The texts of the controls of `pid`'s window ('' while it has no window). */
  const signature = (pid) => (spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-ProcId', String(pid), '-Signature'], { encoding: 'utf8', timeout: 60_000 }).stdout ?? '').trim();
  const pidOf = (name) => {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process ${name} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).Id`], { encoding: 'utf8' });
    return Number(r.stdout.trim()) || 0;
  };
  const killAll = async () => {
    run('powershell.exe', ['-NoProfile', '-Command', 'Get-Process SwarmCast,swarmcast-server,mediamtx,cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force'], { allowFail: true });
    await until(() => ours().length === 0, 30_000, 'no SwarmCast process').catch((err) => console.log(err.message));
  };
  const desktopLog = path.join(dataDir, 'logs', 'desktop.log');
  const logLength = () => (fs.existsSync(desktopLog) ? fs.statSync(desktopLog).size : 0);
  /** The app's window is there and its server is ready (desktop.log after byte `from`): its pid. */
  const appShown = (from) =>
    until(() => {
      const pid = pidOf('SwarmCast');
      return pid && fs.existsSync(desktopLog) && fs.readFileSync(desktopLog, 'utf8').slice(from).includes('ready, opening the panel') ? pid : 0;
    }, 120_000, 'the app window with its panel').catch(() => pidOf('SwarmCast'));
  console.log('\n=== guide screenshots (Windows installer pages and the app window)');
  let from = logLength();
  const setup = spawn(file(dir, /_x64-setup\.exe$/), [], { stdio: 'ignore' });
  let page = '';
  for (let i = 1; i <= 10 && setup.exitCode === null; i++) {
    // The next page: other texts in the installer's window (or the installer is gone).
    const now = await until(() => {
      if (setup.exitCode !== null) return 'closed';
      const sig = signature(setup.pid);
      return sig && sig !== page ? sig : null;
    }, 60_000, `installer page ${i}`).catch(() => 'closed');
    if (now === 'closed') break;
    page = now;
    shot(`installer-${String(i).padStart(2, '0')}`, setup.pid, '{ENTER}');
  }
  await until(() => setup.exitCode !== null, 120_000, 'the installer to close').catch(() => setup.kill());
  // The last page starts the app ("Run SwarmCast" is ticked by default).
  shot('app-en', await appShown(from));
  await killAll();
  const exe = path.join(winInstallDir, 'SwarmCast.exe');
  if (fs.existsSync(exe)) {
    from = logLength();
    spawn(exe, [], { stdio: 'ignore', env: { ...process.env, SWARMCAST_LOCALE: 'pt-BR', SWARMCAST_NO_OPEN: '1' } });
    shot('app-pt-BR', await appShown(from));
    await killAll();
    run(path.join(winInstallDir, 'uninstall.exe'), ['/S'], { allowFail: true });
    await until(() => !fs.existsSync(exe), 60_000, 'the uninstaller').catch(() => {});
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(`guide screenshots: ${fs.readdirSync(out).join(', ')}`);
}

// ---------------------------------------------------------------- main

try {
  startRunKeyJournal();
  if (process.env.SC_DESKTOP_SCREENSHOTS && OS === 'windows' && opt('installers')) {
    await windowsGuideShots(path.resolve(opt('installers')), path.resolve(process.env.SC_DESKTOP_SCREENSHOTS)).catch((err) => console.log(`guide screenshots failed (ignored): ${err.message}`));
  }
  if (opt('installers')) await installerTest(path.resolve(opt('installers')));
  if (opt('update-from')) await updateTest(path.resolve(opt('update-from')), path.resolve(opt('update-to')), Number(opt('update-port') ?? 47811));
  console.log('\nAll desktop checks passed.');
} catch (err) {
  console.log(`\n${err.stack ?? err}`);
  for (const f of [path.join(work, 'app-output.log'), path.join(dataDir, 'logs', 'desktop.log'), runKeyLog]) {
    if (fs.existsSync(f)) console.log(`\n--- ${f} (last 80 lines)\n${fs.readFileSync(f, 'utf8').split('\n').slice(-80).join('\n')}`);
  }
  if (OS === 'windows') console.log(`\n--- Microsoft Defender detections\n${defenderDetections()}`);
  console.log(`\nStill running: ${ours().join('; ') || 'nothing'}`);
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) child.kill();
  runKeyJournal?.kill();
  if (process.env.SC_DESKTOP_ARTIFACTS) {
    fs.mkdirSync(process.env.SC_DESKTOP_ARTIFACTS, { recursive: true });
    for (const f of [path.join(work, 'app-output.log'), path.join(dataDir, 'logs', 'desktop.log'), runKeyLog]) {
      if (fs.existsSync(f)) fs.copyFileSync(f, path.join(process.env.SC_DESKTOP_ARTIFACTS, path.basename(f)));
    }
  }
  if (failures) console.log(`${failures} check(s) failed`);
  if (opt('junit')) {
    if (process.exitCode && !failures) steps.push({ group: `desktop ${OS}`, name: 'desktop test (outside a check)', status: 'fail', detail: 'failed before or between checks: see the output' });
    writeJunit(path.resolve(opt('junit')), `desktop ${OS}-${os.arch()}`, steps);
  }
}
