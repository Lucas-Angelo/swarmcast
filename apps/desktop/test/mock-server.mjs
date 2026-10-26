#!/usr/bin/env node
// A fake `swarmcast-server --desktop` for testing the desktop shell without the real server
// (docs/DESKTOP.md, "Shell ↔ server protocol"). It serves a tiny panel on 127.0.0.1, prints
// `@@swarmcast` messages and reacts to the shell's stdin like the real server would.
//
//   node apps/desktop/test/mock-server.mjs --desktop
//
// Behaviour (environment):
//   MOCK_MODE=ok            ready, then state changes on start/stop clicks (default)
//   MOCK_MODE=crash         exits with code 1 before ready, every time
//   MOCK_MODE=crash-twice   exits before ready on the first two starts (counted in the data dir)
//   MOCK_MODE=fatal         sends fatal {code: MOCK_FATAL_CODE (default already-running)}, exits 1
//   MOCK_MODE=no-ready      runs but never sends ready
//   MOCK_QUIT_DELAY_MS=n    takes n ms to exit after quit (default 300)
//   MOCK_IGNORE_QUIT=1      ignores quit and stdin EOF (tests the shell's kill)
//   MOCK_AUTOTEST=1         the panel page tests itself (language, IPC, links) and reports
//                           the results as `mock-report …` log lines (→ desktop.log)
//   MOCK_AUTOSTART=0        do not start the live after ready (like the real server, the
//                           mock turns it on by itself unless --no-autostart is passed)
//   MOCK_READY_DELAY_MS=n   time before ready (default 800)
//
// Every protocol line it receives is logged as `mock: got …`. It writes
// <data>/mock-config.json on first start so update tests can check the data is kept.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';

const env = process.env;
const mode = env.MOCK_MODE ?? 'ok';
const quitDelay = Number(env.MOCK_QUIT_DELAY_MS ?? 300);
const log = (msg) => process.stdout.write(`${new Date().toISOString()} mock: ${msg}\n`);
const send = (msg) => process.stdout.write(`@@swarmcast ${JSON.stringify(msg)}\n`);

function dataDir() {
  if (env.SWARMCAST_DATA_DIR) return path.resolve(env.SWARMCAST_DATA_DIR);
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'SwarmCast');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'SwarmCast');
  return path.join(env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'swarmcast');
}

log(`started pid=${process.pid} args=${process.argv.slice(2).join(' ')} mode=${mode}`);
for (const k of ['SWARMCAST_DESKTOP_EXE', 'SWARMCAST_BIN_DIR', 'SWARMCAST_WEB_DIR', 'SWARMCAST_DESKTOP_VERSION', 'SWARMCAST_LOCALE', 'SWARMCAST_DATA_DIR']) {
  log(`env ${k}=${env[k] ?? ''}`);
}
if (!process.argv.includes('--desktop')) log('warning: started without --desktop');
process.stderr.write('mock: this line goes to stderr\n');

const dir = dataDir();
fs.mkdirSync(dir, { recursive: true });
const configFile = path.join(dir, 'mock-config.json');
if (!fs.existsSync(configFile)) {
  fs.writeFileSync(configFile, JSON.stringify({ createdAt: new Date().toISOString(), secret: crypto.randomBytes(8).toString('hex') }, null, 2));
  log(`wrote ${configFile}`);
}

if (mode === 'crash') {
  log('crashing before ready (MOCK_MODE=crash)');
  process.exit(1);
}
if (mode === 'crash-twice') {
  const counter = path.join(dir, 'mock-crash-count');
  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
  if (n < 2) {
    fs.writeFileSync(counter, String(n + 1));
    log(`crashing before ready (${n + 1}/2)`);
    process.exit(1);
  }
}
if (mode === 'fatal') {
  const code = env.MOCK_FATAL_CODE ?? 'already-running';
  send({ type: 'fatal', code, message: `mock fatal (${code})` });
  process.exit(1);
}

// ---- live state machine ----
let phase = 'off';
let viewers = 0;
const timers = new Set();
const later = (ms, fn) => {
  const t = setTimeout(() => {
    timers.delete(t);
    fn();
  }, ms);
  timers.add(t);
};
const iconFor = (p) => (p === 'off' ? 'off' : p === 'live' ? 'live' : 'waiting');
function setPhase(p, n = 0) {
  phase = p;
  viewers = n;
  send({ type: 'state', state: iconFor(p), tooltip: `SwarmCast: ${p}`, canStart: p === 'off', canStop: p !== 'off', phase: p, viewers: n });
}
function start() {
  if (phase !== 'off') return;
  setPhase('starting');
  later(500, () => setPhase('waiting-obs'));
  later(1500, () => setPhase('live', 3));
}
function stop() {
  if (phase === 'off') return;
  for (const t of timers) clearTimeout(t);
  timers.clear();
  setPhase('stopping');
  later(400, () => setPhase('off'));
}

let quitting = false;
function quit(reason) {
  if (env.MOCK_IGNORE_QUIT === '1') {
    log(`ignoring ${reason} (MOCK_IGNORE_QUIT=1)`);
    return;
  }
  if (quitting) return;
  quitting = true;
  log(`quitting (${reason}), live was ${phase}`);
  setTimeout(() => {
    log('bye');
    process.exit(0);
  }, quitDelay);
}

// ---- tiny panel ----
const token = crypto.randomBytes(12).toString('hex');
const reports = [];
const updates = [];
const page = `<!doctype html><html><head><meta charset="utf-8"><title>Mock panel</title>
<style>body{font-family:system-ui;margin:2rem;line-height:1.6}button{margin:.2rem}</style></head><body><div id="app">
<h1>Mock SwarmCast panel</h1>
<p>Phase: <b id="phase">?</b> · navigator.language: <code id="lang"></code></p>
<p><button id="start">Start</button><button id="stop">Stop</button>
<button id="check">Check for updates</button><button id="install">Update now</button></p>
<p><a id="blank" href="https://example.com/target-blank" target="_blank">target=_blank link</a> ·
<a id="ext" href="https://example.com/plain-link">plain external link</a> ·
<button id="open">window.open</button> · <a href="/second">same-origin page</a> · <button id="quit">Quit SwarmCast</button></p>
<pre id="updates"></pre></div>
<script>
const report = (k, v) => fetch('/report?' + new URLSearchParams({ [k]: String(v) }));
document.getElementById('lang').textContent = navigator.language + ' ' + JSON.stringify(navigator.languages);
report('language', navigator.language);
report('languages', JSON.stringify(navigator.languages));
const post = (p) => fetch(p, { method: 'POST' });
for (const id of ['start', 'stop', 'check', 'install', 'quit']) document.getElementById(id).onclick = () => post('/api/' + id);
document.getElementById('open').onclick = () => window.open('https://example.com/window-open');
setInterval(async () => {
  const s = await (await fetch('/api/state')).json();
  document.getElementById('phase').textContent = s.phase;
  document.getElementById('updates').textContent = s.updates.map((u) => JSON.stringify(u)).join('\\n');
}, 500);
if (${env.MOCK_AUTOTEST === '1'}) {
  (async () => {
    const internals = window.__TAURI_INTERNALS__;
    report('tauri-internals', typeof internals);
    try {
      const r = await internals.invoke('splash_status');
      report('ipc-from-remote', 'ALLOWED ' + JSON.stringify(r).slice(0, 80));
    } catch (e) {
      report('ipc-from-remote', 'denied: ' + String(e).slice(0, 120));
    }
    setTimeout(() => document.getElementById('blank').click(), 500);
    setTimeout(() => window.open('https://example.com/window-open'), 1000);
    setTimeout(() => { location.href = 'https://example.com/navigation'; }, 1500);
    setTimeout(() => report('still-on-panel', location.origin), 3000);
  })();
}
</script></body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (env.MOCK_LOG_REQUESTS === '1') log(`http ${req.method} ${url.pathname}`);
  if (url.pathname === `/auth/${token}`) {
    // Same as the real server: a SameSite=Strict cookie, then a 303 to the panel.
    res.writeHead(303, { location: '/', 'set-cookie': `mock=${token}; Path=/; HttpOnly; SameSite=Strict` });
    return res.end();
  }
  const authed = (req.headers.cookie ?? '').split(/;\s*/).includes(`mock=${token}`);
  if (url.pathname === '/report') {
    for (const [k, v] of url.searchParams) {
      log(`mock-report ${k}=${v}`);
      reports.push([k, v]);
    }
    res.writeHead(204);
    return res.end();
  }
  if (url.pathname === '/api/state' && !authed) {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end('{"error":"not authorized"}');
  }
  if (url.pathname === '/api/state') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ phase, viewers, updates }));
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    const what = url.pathname.slice(5);
    log(`panel ${what}`);
    if (what === 'start') start();
    if (what === 'stop') stop();
    if (what === 'check') send({ type: 'update-check' });
    if (what === 'install') send({ type: 'update-install' });
    // The panel's "Quit SwarmCast": the real server stops everything and exits 0 by itself.
    if (what === 'quit') quit('panel quit');
    res.writeHead(204);
    return res.end();
  }
  if ((url.pathname === '/' || url.pathname === '/second') && !authed) {
    log(`panel ${url.pathname} without the cookie (401)`);
    res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><h1>Not authorized</h1><p>Open the panel from the app.</p>');
  }
  if (url.pathname === '/' || url.pathname === '/second') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(url.pathname === '/' ? page : '<!doctype html><div id="app"><p>Second page (same origin). <a href="/">Back</a></p></div>');
  }
  res.writeHead(404);
  res.end();
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  log(`panel on http://127.0.0.1:${port}/`);
  if (mode === 'no-ready') return;
  setTimeout(() => {
    send({ type: 'ready', adminUrl: `http://127.0.0.1:${port}/auth/${token}`, version: '0.0.0-mock' });
    setPhase('off');
    if (env.MOCK_AUTOSTART !== '0' && !process.argv.includes('--no-autostart')) start();
  }, Number(env.MOCK_READY_DELAY_MS ?? 800));
});

// ---- stdin from the shell ----
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  log(`got ${line}`);
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === 'click' && msg.id === 'start') start();
  else if (msg.type === 'click' && msg.id === 'stop') stop();
  else if (msg.type === 'click' && msg.id === 'quit') quit('click quit');
  else if (msg.type === 'quit') quit('quit message');
  else if (msg.type === 'update') updates.push(msg);
});
process.stdin.on('end', () => quit('stdin closed'));

// Backup: the parent (the shell) is gone.
const parent = process.ppid;
setInterval(() => {
  try {
    process.kill(parent, 0);
  } catch {
    log('parent is gone, exiting');
    process.exit(0);
  }
}, 1000).unref();
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => quit(sig));
