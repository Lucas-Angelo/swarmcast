#!/usr/bin/env node
// Measures the concurrency limit of a Cloudflare quick tunnel (trycloudflare.com) for
// SwarmCast's traffic pattern: long-lived WebSockets plus short HLS-like GETs.
//
// It starts a tiny local HTTP + WebSocket server (no SwarmCast needed), opens ONE quick
// tunnel with the bundled cloudflared, and runs three short phases:
//   a  idle WebSockets ramp (steps of 25, 10 s holds, app-level ping every 2 s)
//   c  concurrent slow HTTP requests (where do 429s start? do slow bodies count?)
//   b  K open WebSockets + slow-request waves + HLS-like 300 KB GETs (do sockets eat HTTP headroom?)
// It stops a phase on sustained 429s or error bursts, has a hard time budget, and always
// kills its own cloudflared at the end. See README.md (etiquette!) before running it.
//
// Usage: node scripts/test/tunnel-limit/run.mjs [--local] [--phases a,c,b] [--max-ws 400]
//        [--step 25] [--hold 10] [--budget 540] [--out DIR] [--cloudflared PATH]
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');

// ---------- options ----------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
if (flag('help')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 15).join('\n'));
  process.exit(0);
}
const LOCAL = flag('local'); // self-test against 127.0.0.1, no tunnel
const PHASES = opt('phases', 'a,c,b').split(',');
const MAX_WS = Number(opt('max-ws', 400));
const STEP = Number(opt('step', 25));
const HOLD_S = Number(opt('hold', 10));
const BUDGET_S = Number(opt('budget', 540));
const OUT = opt('out', path.join(os.tmpdir(), `swarmcast-tunnel-limit-${new Date().toISOString().replace(/[:.]/g, '-')}`));
const platformDir = `${process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
const CLOUDFLARED = opt('cloudflared', path.join(repo, 'vendor', platformDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'));
const UA = 'swarmcast-tunnel-limit-harness/1 (one-off capacity test; see scripts/test/tunnel-limit/README.md)';
const MARKER = crypto.randomBytes(8).toString('hex');

fs.mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const deadline = t0 + BUDGET_S * 1000;
const results = { startedAt: new Date(t0).toISOString(), local: LOCAL, node: process.version, phases: {} };
const logFile = fs.createWriteStream(path.join(OUT, 'run.log'));
function log(...a) {
  const line = `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${a.join(' ')}`;
  console.log(line);
  logFile.write(line + '\n');
}
class Abort extends Error {}
function checkBudget() {
  if (Date.now() > deadline) throw new Abort(`time budget of ${BUDGET_S}s exhausted`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((x, y) => x - y);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
};
const tally = (list) => list.reduce((m, r) => ((m[r.status === 0 ? `err:${r.err}` : r.status] = (m[r.status === 0 ? `err:${r.err}` : r.status] ?? 0) + 1), m), {});

// ---------- local origin ----------
const BLOB = crypto.randomBytes(300 * 1024); // random: no compression gains
const origin = { inflight: 0, maxInflight: 0, wsOpen: 0, wsMax: 0, requests: 0 };
const server = http.createServer((req, res) => {
  origin.requests += 1;
  origin.inflight += 1;
  origin.maxInflight = Math.max(origin.maxInflight, origin.inflight);
  let done = false;
  res.on('close', () => {
    if (!done) {
      done = true;
      origin.inflight -= 1;
    }
  });
  const u = new URL(req.url ?? '/', 'http://x');
  const headers = { 'cache-control': 'no-store, private', 'x-tunnel-limit': MARKER };
  if (u.pathname === '/healthz') {
    res.writeHead(200, { ...headers, 'content-type': 'text/plain' });
    res.end('ok');
  } else if (u.pathname === '/blob') {
    res.writeHead(200, { ...headers, 'content-type': 'application/octet-stream', 'content-length': BLOB.length });
    res.end(BLOB);
  } else if (u.pathname === '/slow') {
    const ms = Math.min(10_000, Math.max(0, Number(u.searchParams.get('ms')) || 2000));
    let t;
    if (u.searchParams.get('mode') === 'body') {
      // Headers and a first chunk right away, the rest after `ms` (a long download).
      res.writeHead(200, { ...headers, 'content-type': 'application/octet-stream' });
      res.write(Buffer.alloc(1024));
      t = setTimeout(() => res.end(Buffer.alloc(1024)), ms);
    } else {
      // Nothing until `ms` (slow time to first byte).
      t = setTimeout(() => {
        res.writeHead(200, { ...headers, 'content-type': 'text/plain' });
        res.end('ok');
      }, ms);
    }
    res.on('close', () => clearTimeout(t));
  } else {
    res.writeHead(404, headers);
    res.end();
  }
});
server.keepAliveTimeout = 65_000; // fewer reuse races with cloudflared's origin pool
const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: false, maxPayload: 4096 });
wss.on('connection', (ws) => {
  origin.wsOpen += 1;
  origin.wsMax = Math.max(origin.wsMax, origin.wsOpen);
  ws.on('message', (d) => ws.send(d.toString()));
  ws.on('close', () => (origin.wsOpen -= 1));
  ws.on('error', () => {});
});

// ---------- cloudflared ----------
let child = null;
let metricsUrl = null;
const tunnelInfo = { connections: [] };
function startTunnel(port) {
  if (!fs.existsSync(CLOUDFLARED)) throw new Error(`cloudflared not found at ${CLOUDFLARED} (copy vendor/ from the main checkout or run npm run fetch-bins)`);
  const cfg = path.join(OUT, 'cloudflared.yml');
  fs.writeFileSync(cfg, '# tunnel-limit harness: keeps ~/.cloudflared/config.yml from overriding --url\nno-autoupdate: true\n');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TUNNEL_')));
  const cfLog = fs.createWriteStream(path.join(OUT, 'cloudflared.log'));
  child = spawn(CLOUDFLARED, ['tunnel', '--no-autoupdate', '--config', cfg, '--url', `http://127.0.0.1:${port}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  log(`cloudflared pid ${child.pid}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no quick tunnel URL within 45 s')), 45_000);
    let buf = '';
    const onData = (chunk) => {
      cfLog.write(chunk);
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const m = /https:\/\/([a-z0-9]+(?:-[a-z0-9]+)*)\.trycloudflare\.com\b/i.exec(line);
        if (m && m[1].toLowerCase() !== 'api') {
          clearTimeout(timer);
          resolve(`https://${m[1].toLowerCase()}.trycloudflare.com`);
        }
        const mm = /metrics server on (\S+?)\/metrics/i.exec(line);
        if (mm) metricsUrl = `http://${mm[1]}/metrics`;
        const reg = /Registered tunnel connection.*?connIndex=(\d+).*?location=(\S+).*?protocol=(\S+)/.exec(line);
        if (reg) tunnelInfo.connections.push({ index: Number(reg[1]), location: reg[2], protocol: reg[3] });
        if (/429 Too Many Requests|failed to request quick Tunnel/i.test(line)) {
          clearTimeout(timer);
          reject(new Error(`Cloudflare refused the quick tunnel: ${line.slice(0, 200)}`));
        }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`cloudflared exited (${code})`));
    });
  });
}
async function stopTunnel() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  const ok = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]);
  if (!ok) {
    child.kill('SIGKILL');
    await Promise.race([exited, sleep(2000)]);
  }
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  log(`cloudflared pid ${pid} stopped (${alive ? 'STILL ALIVE?' : 'gone'})`);
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    log(`${sig}: stopping cloudflared`);
    await stopTunnel();
    process.exit(130);
  });
}
process.on('exit', () => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
});

async function scrapeMetrics() {
  if (!metricsUrl) return null;
  try {
    const text = await (await fetch(metricsUrl, { signal: AbortSignal.timeout(2000) })).text();
    const want = /^(cloudflared_tunnel_(concurrent_requests_per_tunnel|total_requests|request_errors|response_by_code\{[^}]*\})|cloudflared_tcp_active_sessions)\s+(\S+)/;
    const out = {};
    for (const line of text.split('\n')) {
      const m = want.exec(line);
      if (m) out[m[1]] = Number(m[3]);
    }
    return out;
  } catch {
    return null;
  }
}

// ---------- client ----------
let base = '';
let pinnedHost = null;
let pinnedIp = null;
const lookup = (host, o, cb) => {
  if (pinnedIp && host === pinnedHost) {
    if (o && o.all) cb(null, [{ address: pinnedIp, family: 4 }]);
    else cb(null, pinnedIp, 4);
  } else dns.lookup(host, o, cb);
};
let agent;
const mod = () => (base.startsWith('https:') ? https : http);

function get(p, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    const start = performance.now();
    const fail = (e) => resolve({ status: 0, err: e.code || e.message, ms: performance.now() - start });
    const req = mod().request(base + p, { agent, lookup, timeout: timeoutMs, headers: { 'user-agent': UA, 'cache-control': 'no-cache' } }, (res) => {
      let bytes = 0;
      let body = '';
      res.on('data', (c) => {
        bytes += c.length;
        if (res.statusCode !== 200 && body.length < 400) body += c.toString('latin1');
      });
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          bytes,
          ms: performance.now() - start,
          ...(res.statusCode !== 200 ? { body: body.slice(0, 400), server: res.headers.server, cfRay: res.headers['cf-ray'], retryAfter: res.headers['retry-after'] } : {}),
        }),
      );
      res.on('error', fail);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    req.on('error', fail);
    req.end();
  });
}

const sockets = []; // open WebSocket records
let stepRtts = [];
function openWs(id) {
  return new Promise((resolve) => {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws', { lookup, handshakeTimeout: 15_000, perMessageDeflate: false, headers: { 'user-agent': UA } });
    const rec = { id, ws, open: false, closed: false, closeCode: null, sent: 0, recv: 0 };
    ws.on('unexpected-response', (req, res) => {
      let body = '';
      res.on('data', (c) => body.length < 300 && (body += c.toString('latin1')));
      res.on('end', () => resolve({ ok: false, status: res.statusCode, body: body.slice(0, 300), server: res.headers.server }));
      res.on('error', () => resolve({ ok: false, status: res.statusCode }));
      setTimeout(() => req.destroy(), 3000);
    });
    ws.on('open', () => {
      rec.open = true;
      sockets.push(rec);
      resolve({ ok: true, rec });
    });
    ws.on('message', (d) => {
      const s = d.toString();
      if (s.startsWith('p:')) {
        rec.recv += 1;
        stepRtts.push(performance.now() - Number(s.split(':')[2]));
      }
    });
    ws.on('close', (code) => {
      if (rec.open && !rec.closed) {
        rec.closed = true;
        rec.closeCode = code;
      }
    });
    ws.on('error', (e) => {
      if (!rec.open) resolve({ ok: false, status: 0, err: e.code || e.message });
    });
  });
}
const liveSockets = () => sockets.filter((s) => !s.closed);
let pinger = null;
function startPinger() {
  pinger = setInterval(() => {
    for (const s of liveSockets()) {
      if (s.ws.readyState !== WebSocket.OPEN) continue;
      s.sent += 1;
      s.ws.send(`p:${s.id}:${performance.now()}`);
    }
  }, 2000);
}
async function closeAllSockets() {
  for (const s of sockets) {
    try {
      s.ws.close(1000);
    } catch {
      /* ignore */
    }
  }
  await sleep(1500);
  for (const s of sockets) s.ws.terminate();
  sockets.length = 0;
}
/** Open `n` more sockets in parallel batches of `batch`; returns their outcomes. */
async function openMany(n, startId, batch = 25) {
  const outcomes = [];
  for (let i = 0; i < n; i += batch) {
    const k = Math.min(batch, n - i);
    outcomes.push(...(await Promise.all(Array.from({ length: k }, (_, j) => openWs(startId + i + j)))));
  }
  return outcomes;
}
const wsTally = (outs) => outs.reduce((m, o) => ((m[o.ok ? 'ok' : o.status === 0 ? `err:${o.err}` : o.status] = (m[o.ok ? 'ok' : o.status === 0 ? `err:${o.err}` : o.status] ?? 0) + 1), m), {});

// ---------- phases ----------
let nextWsId = 0;
const firstRejects = []; // samples of non-200 bodies (to see who answered: edge or origin)
function keepSample(r) {
  if (firstRejects.length < 6 && r.status && r.status !== 200 && r.status !== 101) firstRejects.push(r);
}

async function phaseA() {
  log(`phase a: WebSocket ramp to ${MAX_WS} in steps of ${STEP}, ${HOLD_S}s holds`);
  const steps = [];
  let bad = 0;
  for (let target = STEP; target <= MAX_WS; target += STEP) {
    checkBudget();
    stepRtts = [];
    const before = sockets.map((s) => ({ s, sent: s.sent, recv: s.recv, closed: s.closed }));
    const need = target - liveSockets().length;
    const outs = await openMany(Math.max(0, need), nextWsId);
    nextWsId += need;
    outs.filter((o) => !o.ok).forEach(keepSample);
    // hold, with a few HTTP probes in the middle
    await sleep((HOLD_S * 1000) / 2);
    const probes = await Promise.all([get('/healthz'), get('/healthz'), get('/healthz')]);
    probes.forEach(keepSample);
    await sleep((HOLD_S * 1000) / 2);
    const droppedOld = before.filter((b) => !b.closed && b.s.closed);
    const lost = before.filter((b) => !b.s.closed).reduce((n, b) => n + Math.max(0, b.s.sent - b.sent - (b.s.recv - b.recv) - 1), 0);
    const failed = outs.filter((o) => !o.ok).length;
    const row = {
      target,
      attempted: outs.length,
      upgrades: wsTally(outs),
      openClient: liveSockets().length,
      openOrigin: origin.wsOpen,
      droppedExisting: droppedOld.length,
      dropCodes: [...new Set(droppedOld.map((b) => b.s.closeCode))],
      lostPings: lost,
      pingP50: pct(stepRtts, 50),
      pingP95: pct(stepRtts, 95),
      pingMax: pct(stepRtts, 100),
      httpProbes: tally(probes),
      metrics: await scrapeMetrics(),
    };
    steps.push(row);
    log(`  ws=${target} open=${row.openClient}/${row.openOrigin} upgrades=${JSON.stringify(row.upgrades)} dropped=${row.droppedExisting} lostPings=${lost} rtt p50/p95=${row.pingP50}/${row.pingP95}ms http=${JSON.stringify(row.httpProbes)}`);
    const rejected429 = outs.some((o) => o.status === 429) || probes.some((p) => p.status === 429);
    const errBurst = outs.length > 0 && failed / outs.length > 0.5;
    if (rejected429 || errBurst || droppedOld.length > 0.2 * before.length) bad += 1;
    else bad = 0;
    if (bad >= 2) {
      log('  stopping phase a: sustained 429s / failures');
      break;
    }
  }
  results.phases.a = { steps, maxOpenClient: Math.max(0, ...steps.map((s) => s.openClient)), maxOpenOrigin: origin.wsMax };
  await closeAllSockets();
  await sleep(3000);
}

/** Fire `c` concurrent slow requests twice (second wave reuses warm connections). */
async function slowStep(c, { ms = 2500, mode = 'ttfb', label = '' } = {}) {
  const waves = [];
  for (let w = 0; w < 2; w++) {
    checkBudget();
    origin.maxInflight = origin.inflight;
    const rs = await Promise.all(Array.from({ length: c }, () => get(`/slow?ms=${ms}&mode=${mode}`)));
    rs.forEach(keepSample);
    waves.push({ statuses: tally(rs), originMaxInflight: origin.maxInflight, p50ms: pct(rs.map((r) => r.ms), 50) });
    await sleep(300);
  }
  const n429 = waves.reduce((n, w) => n + (w.statuses[429] ?? 0), 0);
  const nErr = waves.reduce((n, w) => n + Object.entries(w.statuses).filter(([k]) => k.startsWith('err')).reduce((x, [, v]) => x + v, 0), 0);
  const row = { label, c, mode, ms, ws: liveSockets().length, wsOrigin: origin.wsOpen, waves, rate429: n429 / (2 * c), rateErr: nErr / (2 * c), metrics: await scrapeMetrics() };
  log(`  ${label} slow(${mode}) c=${c} ws=${row.ws}: ${waves.map((w) => `${JSON.stringify(w.statuses)} originMax=${w.originMaxInflight}`).join(' | ')}`);
  return row;
}

async function phaseC() {
  log('phase c: concurrent slow requests (2.5 s to first byte), no WebSockets');
  const steps = [];
  let lastClean = 0;
  let first429 = null;
  for (const c of [100, 150, 180, 195, 205, 220, 250, 300]) {
    const row = await slowStep(c, { label: 'c' });
    steps.push(row);
    if (row.rate429 === 0 && row.rateErr < 0.05) lastClean = c;
    if (row.rate429 > 0 && first429 === null) first429 = c;
    if (row.rate429 > 0.2 || row.rateErr > 0.5) {
      log('  stopping ramp: sustained 429s / errors');
      break;
    }
  }
  const base429 = first429;
  // Long downloads (headers sent, body still streaming) around the same boundary.
  const B = lastClean || 150;
  const body = [];
  for (const c of [Math.max(10, B - 20), B + 30]) {
    const row = await slowStep(c, { mode: 'body', label: 'c-body' });
    body.push(row);
    if (row.rate429 > 0.2 || row.rateErr > 0.5) break;
  }
  results.phases.c = { steps, lastClean, first429: base429, bodySteps: body };
  return { lastClean, first429 };
}

/** Closed-loop HLS-like load: `conc` workers GET 300 KB bodies for `seconds` (at most `maxMB` in total). */
async function hlsLoad(conc, seconds, maxMB = 80) {
  const end = Date.now() + seconds * 1000;
  const rs = [];
  let stop = false;
  let bytes = 0;
  const t = performance.now();
  await Promise.all(
    Array.from({ length: conc }, async () => {
      while (!stop && Date.now() < end) {
        const r = await get('/blob');
        rs.push(r);
        keepSample(r);
        bytes += r.bytes ?? 0;
        if (bytes > maxMB * 1e6) break; // be modest with Cloudflare's bandwidth
        const n429 = rs.filter((x) => x.status === 429).length;
        if (rs.length > 2 * conc && n429 / rs.length > 0.3) stop = true; // sustained 429: back off now
        if (r.status !== 200) await sleep(250);
      }
    }),
  );
  const secs = (performance.now() - t) / 1000;
  const ok = rs.filter((r) => r.status === 200);
  return {
    conc,
    seconds: Number(secs.toFixed(1)),
    requests: rs.length,
    statuses: tally(rs),
    reqPerS: Number((rs.length / secs).toFixed(1)),
    mbitPerS: Number(((ok.reduce((n, r) => n + r.bytes, 0) * 8) / secs / 1e6).toFixed(1)),
    p50ms: pct(ok.map((r) => r.ms), 50),
    p95ms: pct(ok.map((r) => r.ms), 95),
    stoppedEarly: stop,
  };
}

async function phaseB(B) {
  log(`phase b: K open WebSockets + slow waves + HLS-like load (baseline clean c=${B})`);
  const rows = [];
  for (const K of [50, 100, 150]) {
    checkBudget();
    const before = liveSockets().length;
    const outs = await openMany(K - before, nextWsId);
    nextWsId += K - before;
    outs.filter((o) => !o.ok).forEach(keepSample);
    await sleep(2000);
    const prevDrops = sockets.filter((s) => s.closed).length;
    log(`  K=${K}: open=${liveSockets().length} origin=${origin.wsOpen} upgrades=${JSON.stringify(wsTally(outs))}`);
    const slow = [];
    const ladder = [...new Set([Math.max(10, B - K - 20), Math.max(10, B - K + 20), Math.max(10, B - 20)])].sort((x, y) => x - y);
    for (const c of ladder) {
      const row = await slowStep(c, { label: `b K=${K}` });
      slow.push(row);
      if (row.rate429 > 0.2 || row.rateErr > 0.5) break;
    }
    checkBudget();
    stepRtts = [];
    const hls = [];
    // A realistic load (24 segment downloads in flight) once, with the most sockets open.
    if (K === 150) {
      hls.push(await hlsLoad(24, 6));
      log(`  K=${K} hls c=24: ${JSON.stringify(hls.at(-1))}`);
      checkBudget();
    }
    // Just past the boundary where open sockets would matter if they counted.
    const hi = Math.max(10, B - K + 25);
    hls.push(await hlsLoad(hi, 5));
    log(`  K=${K} hls c=${hi}: ${JSON.stringify(hls.at(-1))}`);
    const drops = sockets.filter((s) => s.closed).length - prevDrops;
    rows.push({ K, openClient: liveSockets().length, openOrigin: origin.wsOpen, upgrades: wsTally(outs), slow, hls, wsDroppedDuringLoad: drops, pingP95DuringHls: pct(stepRtts, 95) });
    await sleep(1000);
  }
  results.phases.b = rows;
  await closeAllSockets();
}

// ---------- main ----------
async function resolveDoh(host) {
  try {
    const r = await fetch(`https://1.1.1.1/dns-query?name=${encodeURIComponent(host)}&type=A`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000) });
    const body = await r.json();
    return body.Answer?.find((a) => a.type === 1)?.data ?? null;
  } catch {
    return null;
  }
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  log(`origin on 127.0.0.1:${port}; output in ${OUT}`);
  if (LOCAL) {
    base = `http://127.0.0.1:${port}`;
  } else {
    const ver = await new Promise((r) => {
      const p = spawn(CLOUDFLARED, ['--version']);
      let s = '';
      p.stdout.on('data', (d) => (s += d));
      p.on('close', () => r(s.trim()));
    });
    results.cloudflared = ver;
    log(ver);
    base = await startTunnel(port);
    pinnedHost = new URL(base).hostname;
    log(`tunnel ${base}`);
    // Wait for DNS through DoH (bypasses the OS negative cache), then pin that address.
    const dnsDeadline = Date.now() + 90_000;
    while (!pinnedIp && Date.now() < dnsDeadline) {
      pinnedIp = await resolveDoh(pinnedHost);
      if (!pinnedIp) await sleep(2000);
    }
    if (!pinnedIp) throw new Error('hostname did not resolve via DoH within 90 s');
    log(`resolved ${pinnedHost} -> ${pinnedIp} (DoH)`);
  }
  agent = new (base.startsWith('https:') ? https : http).Agent({ keepAlive: true, maxSockets: Infinity, keepAliveMsecs: 1000 });
  // Reachable with our marker?
  let ready = false;
  for (let i = 0; i < 30 && !ready; i++) {
    const r = await new Promise((resolve) => {
      const req = mod().get(base + '/healthz', { agent, lookup, timeout: 5000 }, (res) => {
        res.resume();
        resolve(res.headers['x-tunnel-limit'] === MARKER);
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(false));
    });
    ready = r;
    if (!ready) await sleep(2000);
  }
  if (!ready) throw new Error('tunnel never answered /healthz with our marker');
  if (!LOCAL) {
    let sys = false;
    for (let i = 0; i < 10 && !sys; i++) {
      try {
        sys = (await dns.promises.resolve4(pinnedHost)).length > 0;
      } catch {
        await sleep(2000);
      }
    }
    log(`system DNS resolves the name: ${sys} (the harness uses the DoH address either way)`);
    results.tunnel = { url: base, ip: pinnedIp, connections: tunnelInfo.connections, metricsUrl };
    await sleep(3000); // let the remaining tunnel connections register
    results.tunnel.connections = tunnelInfo.connections;
  }
  results.base = base;
  log(`ready: ${base}`);
  startPinger();

  let lastClean = 200;
  if (PHASES.includes('a')) await phaseA();
  if (PHASES.includes('c')) ({ lastClean } = await phaseC());
  if (PHASES.includes('b')) await phaseB(lastClean || 200);
}

let exitCode = 0;
try {
  await main();
} catch (e) {
  exitCode = e instanceof Abort ? 2 : 1;
  results.aborted = e.message;
  log(`ABORT: ${e.message}`);
} finally {
  if (pinger) clearInterval(pinger);
  await closeAllSockets().catch(() => {});
  agent?.destroy();
  await stopTunnel();
  server.closeAllConnections?.();
  server.close();
  results.rejectSamples = firstRejects;
  results.finishedAt = new Date().toISOString();
  results.seconds = Math.round((Date.now() - t0) / 1000);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  log(`results: ${path.join(OUT, 'results.json')} (${results.seconds}s)`);
  logFile.end();
}
process.exitCode = exitCode;
setTimeout(() => process.exit(exitCode), 500).unref();
