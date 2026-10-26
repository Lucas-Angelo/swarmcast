#!/usr/bin/env node
// Clean-machine test of the desktop app installers (docs/DESKTOP.md, "Testing"), run by
// .github/workflows/desktop.yml on fresh CI machines. It changes the machine (installs the
// app, writes the autostart entry, deletes the SwarmCast data folder): do not run it on yours.
//
//   node scripts/test/desktop/verify.mjs --installers release/desktop/<target> \
//        [--update-from <dir A> --update-to <dir B with latest.json> --update-port 47811]
//
// 1. Installs the real installer (Windows NSIS /S, macOS .dmg -> ~/Applications, Linux .deb),
//    starts the app, logs into the panel (admin API), checks /api/desktop, turns "Start with
//    the computer" on and off (Run key / LaunchAgent / XDG entry), kills the app (its server
//    and tools must go with it: the Windows Job object), starts it again, quits from the panel
//    (nothing left running) and uninstalls (NSIS uninstaller / apt remove). Linux also runs
//    the AppImage. Then installs again and removes everything with scripts/uninstall-*.
// 2. Update: installs build A, serves build B and its latest.json on 127.0.0.1, starts A,
//    clicks "Update now" through the panel API and expects B to come back by itself with
//    config.json and secrets.json unchanged.
//
// The panel login URL comes from SWARMCAST_TEST_LOGIN_FILE (written by the server).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
function step(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) {
    failures += 1;
    throw new Error(`${name} failed${detail ? `: ${detail}` : ''}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(500);
  }
  throw new Error(`timed out (${ms / 1000} s) waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}
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

/** SwarmCast processes still running (the shell, the server, MediaMTX, cloudflared). */
function ours() {
  if (OS === 'windows') {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', "Get-Process SwarmCast,swarmcast-server,mediamtx,cloudflared -ErrorAction SilentlyContinue | ForEach-Object { \"$($_.Id) $($_.Path)\" }"], { encoding: 'utf8' });
    return r.stdout.split(/\r?\n/).filter(Boolean);
  }
  const r = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return r.stdout.split('\n').filter((l) => /SwarmCast\.app\/|swarmcast-desktop|swarmcast-server|SwarmCast_.*\.AppImage|\/mediamtx|cloudflared/.test(l) && !l.includes('verify.mjs'));
}
async function nothingLeft(what) {
  const left = await until(() => ours().length === 0, 45_000, 'every SwarmCast process to exit').then(() => []).catch(() => ours());
  step(`${what}: nothing left running`, left.length === 0, left.join('; '));
}

// ---------------------------------------------------------------- the app and its panel

let child = null;
/** Starts the installed app and logs into its panel. */
async function launch(exe, env = {}, argv = []) {
  fs.rmSync(loginFile, { force: true });
  const out = fs.openSync(path.join(work, 'app-output.log'), 'a');
  child = spawn(exe, argv, {
    stdio: ['ignore', out, out],
    env: { ...process.env, SWARMCAST_TEST_LOGIN_FILE: loginFile, SWARMCAST_NO_FFMPEG_INSTALL: '1', SWARMCAST_NO_OPEN: '1', APPIMAGE_EXTRACT_AND_RUN: '1', ...env },
  });
  child.on('error', (err) => console.log(`spawn error: ${err.message}`));
  return login();
}

async function login() {
  const url = await until(() => fs.existsSync(loginFile) && fs.readFileSync(loginFile, 'utf8').trim(), 120_000, 'the app to start its server (login URL)');
  const u = new URL(url);
  const res = await request({ port: u.port, path: u.pathname });
  const cookie = String(res.headers['set-cookie'] ?? '').split(';')[0];
  step('panel login', res.status === 303 && cookie.includes('='), `HTTP ${res.status}`);
  const panel = { port: Number(u.port), cookie };
  const page = await request({ port: panel.port, path: '/', cookie });
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

/** Killing the app (no clean quit) must take its server and tools down too. */
async function killApp(what) {
  const pid = child.pid;
  if (OS === 'windows') run('taskkill', ['/F', '/PID', String(pid)], { allowFail: true });
  else process.kill(pid, 'SIGKILL');
  await nothingLeft(what);
}

async function quitFromPanel(panel) {
  await api(panel, 'POST', '/api/app/quit');
  const exited = await until(() => child.exitCode !== null || child.signalCode !== null, 60_000, 'the app to quit').then(() => true, () => false);
  step('"Quit SwarmCast" in the panel closes the app', exited);
  await nothingLeft('after quitting');
}

// ---------------------------------------------------------------- install / uninstall per OS

function install(dir) {
  if (OS === 'windows') {
    run(file(dir, /_x64-setup\.exe$/), ['/S']);
    const exe = path.join(winInstallDir, 'SwarmCast.exe');
    step('NSIS silent install', fs.existsSync(exe), exe);
    return exe;
  }
  if (OS === 'macos') {
    const mnt = path.join(work, 'dmg');
    run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mnt, file(dir, /\.dmg$/)]);
    fs.mkdirSync(path.dirname(macApp), { recursive: true });
    fs.rmSync(macApp, { recursive: true, force: true });
    run('cp', ['-R', path.join(mnt, 'SwarmCast.app'), macApp]);
    run('hdiutil', ['detach', mnt]);
    const exe = path.join(macApp, 'Contents', 'MacOS', 'SwarmCast');
    step('the .dmg holds SwarmCast.app (copied to ~/Applications)', fs.existsSync(exe), exe);
    return exe;
  }
  run('sudo', ['apt-get', 'install', '-y', '--no-install-recommends', file(dir, /\.deb$/)]);
  step('the .deb installs swarmcast-desktop', fs.existsSync('/usr/bin/swarmcast-desktop'));
  return '/usr/bin/swarmcast-desktop';
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

async function nativeUninstall() {
  if (OS === 'windows') {
    run(path.join(winInstallDir, 'uninstall.exe'), ['/S']);
    await until(() => !fs.existsSync(path.join(winInstallDir, 'SwarmCast.exe')), 60_000, 'the NSIS uninstaller to finish').catch(() => {});
    step('NSIS uninstaller removes the app', !fs.existsSync(path.join(winInstallDir, 'SwarmCast.exe')));
    step('...and keeps the settings (no "delete app data")', fs.existsSync(path.join(dataDir, 'config.json')));
  } else if (OS === 'linux') {
    run('sudo', ['apt-get', 'remove', '-y', 'swarmcast-desktop']);
    step('apt remove removes the app', !fs.existsSync('/usr/bin/swarmcast-desktop'));
  }
}

function scriptUninstall(exe) {
  if (OS === 'windows') run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'uninstall-windows.ps1')]);
  else run('bash', [path.join(root, 'scripts', OS === 'macos' ? 'uninstall-macos.command' : 'uninstall-linux.sh')], { env: { ...process.env, SWARMCAST_NO_PAUSE: '1' } });
  step('scripts/uninstall-* removes the app', !fs.existsSync(exe), exe);
  step('scripts/uninstall-* removes the data folder', !fs.existsSync(dataDir), dataDir);
  step('no autostart entry is left', !autostartPresent());
}

// ---------------------------------------------------------------- 1. the real installer

async function installerTest(dir) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const v = fs.readdirSync(dir).map((n) => /_(\d+\.\d+\.\d+[^_]*)_/.exec(n)?.[1]).find(Boolean) ?? version;
  console.log(`\n=== installer ${v} (${OS})`);
  const exe = install(dir);
  let panel = await launch(exe);
  await checkDesktopApi(panel, v);
  await checkAutostart(panel);
  await killApp('after killing the app');
  panel = await launch(exe);
  await quitFromPanel(panel);
  await nativeUninstall();

  let last = exe;
  if (OS === 'linux') {
    console.log('\n=== AppImage');
    last = installAppImage(dir);
    panel = await launch(last);
    await checkDesktopApi(panel, v);
    await quitFromPanel(panel);
  } else if (OS === 'windows') {
    install(dir);
    await quitFromPanel(await launch(exe));
  }
  console.log('\n=== scripts/uninstall-*');
  scriptUninstall(last);
}

// ---------------------------------------------------------------- 2. update A -> B

async function updateTest(dirA, dirB, port) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dirB, 'latest.json'), 'utf8'));
  console.log(`\n=== update to ${manifest.version} (${OS})`);
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1));
    const f = path.join(dirB, path.basename(name));
    console.log(`update server: GET ${req.url}`);
    if (!name || !fs.existsSync(f) || !fs.statSync(f).isFile()) return res.writeHead(404).end();
    res.writeHead(200, { 'content-length': fs.statSync(f).size });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const exe = OS === 'linux' ? installAppImage(dirA) : install(dirA);
    const env = { SWARMCAST_UPDATE_URL: `http://127.0.0.1:${port}/latest.json` };
    let panel = await launch(exe, env);
    const config = path.join(dataDir, 'config.json');
    const secrets = path.join(dataDir, 'secrets.json');
    await until(() => fs.existsSync(config) && fs.existsSync(secrets), 30_000, 'config.json and secrets.json');
    const before = [fs.readFileSync(config, 'utf8'), fs.readFileSync(secrets, 'utf8')];
    fs.rmSync(loginFile, { force: true });
    await api(panel, 'POST', '/api/desktop/update/install');
    console.log('"Update now" sent; waiting for the new version to start by itself');
    await until(() => fs.existsSync(loginFile), 300_000, 'the updated app to start');
    panel = await login();
    await checkDesktopApi(panel, manifest.version);
    const after = [fs.readFileSync(config, 'utf8'), fs.readFileSync(secrets, 'utf8')];
    step('config.json is unchanged by the update', JSON.stringify(JSON.parse(after[0])) === JSON.stringify(JSON.parse(before[0])));
    step('secrets.json is unchanged by the update', after[1] === before[1]);
    // The relaunched app is not our child: quit it through its panel.
    await api(panel, 'POST', '/api/app/quit');
    await nothingLeft('after quitting the updated app');
    scriptUninstall(exe); // updated in place
  } finally {
    server.close();
  }
}

// ---------------------------------------------------------------- main

try {
  if (opt('installers')) await installerTest(path.resolve(opt('installers')));
  if (opt('update-from')) await updateTest(path.resolve(opt('update-from')), path.resolve(opt('update-to')), Number(opt('update-port') ?? 47811));
  console.log('\nAll desktop checks passed.');
} catch (err) {
  console.log(`\n${err.stack ?? err}`);
  for (const f of [path.join(work, 'app-output.log'), path.join(dataDir, 'logs', 'desktop.log')]) {
    if (fs.existsSync(f)) console.log(`\n--- ${f} (last 80 lines)\n${fs.readFileSync(f, 'utf8').split('\n').slice(-80).join('\n')}`);
  }
  console.log(`\nStill running: ${ours().join('; ') || 'nothing'}`);
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) child.kill();
  if (process.env.SC_DESKTOP_ARTIFACTS) {
    fs.mkdirSync(process.env.SC_DESKTOP_ARTIFACTS, { recursive: true });
    for (const f of [path.join(work, 'app-output.log'), path.join(dataDir, 'logs', 'desktop.log')]) {
      if (fs.existsSync(f)) fs.copyFileSync(f, path.join(process.env.SC_DESKTOP_ARTIFACTS, path.basename(f)));
    }
  }
  if (failures) console.log(`${failures} check(s) failed`);
}
