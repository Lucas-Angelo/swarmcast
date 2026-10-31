// Experiment: does asking the OS resolver for a brand-new quick-tunnel name poison it?
// Usage: node dns-exp.mjs <cloudflared> <iterations>
import { spawn, execFileSync } from 'node:child_process';
import dns from 'node:dns';
import { Resolver, lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';

const [bin, itersArg] = process.argv.slice(2);
const ITERS = Number(itersArg || 6);
const SCENARIOS = ['current', 'doh-only', 'early-os'];
const cf = new Resolver(); cf.setServers(['1.1.1.1', '1.0.0.1']);
const sys = new Resolver(); // c-ares, OS-configured servers, no local cache
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let T0 = 0;
const out = [];
const ev = (it, sc, what, data) => { const e = { it, sc, t: ((Date.now() - T0) / 1000).toFixed(2), what, ...data }; out.push(e); console.log(JSON.stringify(e)); };

async function doh(host) {
  try {
    const res = await fetch(`https://1.1.1.1/dns-query?name=${host}&type=A`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000) });
    const b = await res.json();
    return { status: b.Status, ip: b.Answer?.find((a) => a.type === 1)?.data ?? null };
  } catch (e) { return { status: 'err', ip: null, err: e.message }; }
}
function get(url, ip) {
  const u = new URL('/healthz', url);
  return new Promise((resolve) => {
    let lookupResult = ip ? 'fixed' : null;
    const lk = ip
      ? (_h, o, cb) => (o.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4))
      : (h, o, cb) => dns.lookup(h, o, (err, a, f) => { lookupResult = err ? err.code : 'ok'; cb(err, a, f); });
    const req = https.get(u, { lookup: lk, timeout: 5000 }, (res) => { res.resume(); resolve({ lookup: lookupResult, status: res.statusCode, marker: res.headers['x-swarmcast'] ?? null }); });
    req.on('timeout', () => req.destroy());
    req.on('error', (e) => resolve({ lookup: lookupResult, status: 'err', err: e.code || e.message }));
  });
}
const osLookup = async (h) => lookup(h).then((a) => 'ok ' + a.address, (e) => e.code);
const sysResolve = async (h) => sys.resolve4(h).then((a) => 'ok ' + a[0], (e) => e.code);
const cfResolve = async (h) => cf.resolve4(h).then((a) => 'ok ' + a[0], (e) => e.code);
function dnsCache(host) {
  if (process.platform !== 'win32') return null;
  try { return execFileSync('powershell', ['-NoProfile', '-Command', `Get-DnsClientCache -Entry '${host}' -ErrorAction SilentlyContinue | Format-List Entry,Type,Status,TimeToLive,Data | Out-String`], { encoding: 'utf8' }).trim(); } catch (e) { return 'err ' + e.message; }
}

async function iteration(it, sc) {
  const server = http.createServer((req, res) => { res.setHeader('x-swarmcast', 'marker'); res.end('ok'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  const url = await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('no url')), 45000);
    const on = (d) => {
      buf += d;
      for (const line of d.toString().split('\n')) if (/Registered tunnel connection/.test(line) && T0) ev(it, sc, 'cloudflared-registered', { line: line.slice(0, 120) });
      const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !T0) { clearTimeout(to); T0 = Date.now(); resolve(m[0]); }
    };
    child.stdout.on('data', on); child.stderr.on('data', on);
  });
  const host = new URL(url).hostname;
  ev(it, sc, 'url', { host: host.replace(/^[^.]+/, '<name>') });
  // Phase 1: app's readiness check
  if (sc === 'early-os') ev(it, sc, 'early-os-lookup', { os: await osLookup(host), sys: await sysResolve(host), cf: await cfResolve(host) });
  let delay = 500; let ok = false;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const d = await doh(host);
    let r;
    if (d.ip || sc === 'current') r = await get(url, d.ip);
    ev(it, sc, 'probe', { doh: d.status, dohIp: !!d.ip, ...(r ?? { skipped: true }) });
    if (r?.marker === 'marker') { ok = true; break; }
    await sleep(delay); delay = Math.min(delay * 1.5, 4000);
  }
  ev(it, sc, 'reachable', { ok });
  if (sc === 'current') ev(it, sc, 'app-resolve4', { sys: await sysResolve(host) });
  // Phase 2: what the viewer harness / a browser on this machine sees
  ev(it, sc, 'harness-cf', { cf: await cfResolve(host) });
  let firstFail = true;
  for (let i = 0; i < 75; i++) {
    const os = await osLookup(host);
    const s = await sysResolve(host);
    ev(it, sc, 'os', { os, sys: s });
    if (!os.startsWith('ok') && firstFail) { firstFail = false; const c = dnsCache(host); if (c) ev(it, sc, 'dnscache', { cache: c.replace(host, '<name>').replace(/\r?\n/g, ' | ') }); }
    if (os.startsWith('ok') && i >= 5 && out.filter((e) => e.it === it && e.what === 'os').slice(-5).every((e) => e.os.startsWith('ok'))) break;
    await sleep(1000);
  }
  child.kill(); server.close();
  T0 = 0;
}

for (let it = 0; it < ITERS; it++) {
  const sc = SCENARIOS[it % SCENARIOS.length];
  try { await iteration(it, sc); } catch (e) { console.log(JSON.stringify({ it, sc, what: 'error', err: e.message })); T0 = 0; }
  await sleep(3000);
}
