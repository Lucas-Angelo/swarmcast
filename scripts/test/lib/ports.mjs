// Ports for tests. Servers the test itself creates should listen on port 0: the OS then picks a
// free port at listen time, with no race at all. Two kinds of servers need a number before they
// start, and get it here.
//
// Allocated ports (allocPorts): MediaMTX's RTMP and HLS ports, a SwarmCast started with a config file.
// - Each Vitest worker gets its own block (PORT_BASE + VITEST_POOL_ID x BLOCK), so test files
//   running in parallel never pick the same port. Within a process, ports are handed out in
//   turn from a random point of the block, so the next file in the same worker starts elsewhere.
// - Every block lies in 20000-31999, outside every default ephemeral range (EPHEMERAL_DEFAULTS).
// - Each candidate is probed with a real listen on 127.0.0.1 and on all interfaces. Ports in use
//   (EADDRINUSE) and ports Windows refuses (EACCES: an excluded range, see `netsh int ipv4 show
//   excludedportrange protocol=tcp`) are skipped.
//
// Fixed ports (FIXED_PORTS): a harness whose URL is set before its server starts (Playwright's
// baseURL and webServer, an update manifest that names its server, a script another script
// signs in through). They all lie in FIXED_ZONE, 10000-19999.
//
// Why never in an ephemeral range: every outgoing TCP connection the OS opens without an explicit
// bind() takes its local port from that range (Linux 32768-60999, macOS and Windows 49152-65535).
// A connection to 127.0.0.1 holds 127.0.0.1:<that port> while it is open and, on the side that
// closed first, for TIME_WAIT (60 s on Linux) after; until then nobody can listen on that address
// and port. The e2e server once failed with EADDRINUSE on port 38082 of 127.0.0.1, its control port
// (inside Linux's range), because the loopback connections it had just opened itself (the fake
// OBS's RTMP push, the app's HLS requests to MediaMTX) could take that number (pipeline run
// 41192273509). Below 20000 a fixed port is also clear of the Vitest blocks above, so the e2e
// suite and `npm test` can run on one machine at once. Never the ports of a SwarmCast someone
// runs on this computer (RESERVED: the defaults and the demo's).
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';

export const PORT_BASE = 20000;
export const BLOCK = 200;
const BLOCKS = 60; // 20000 + 60 x 200 = 32000
/** SwarmCast's default ports and the demo's: a test never takes them, even when they are free. */
export const RESERVED = new Set([1935, 8080, 8888, 8889, 31935, 38180, 38181, 38888]);

/**
 * The default range each OS takes the local port of an outgoing connection from, inclusive: Linux's
 * net.ipv4.ip_local_port_range, macOS's net.inet.ip.portrange.first/last, Windows' dynamic port
 * range (`netsh int ipv4 show dynamicport tcp`). ephemeralRange() reads this machine's.
 */
export const EPHEMERAL_DEFAULTS = { linux: [32768, 60999], darwin: [49152, 65535], win32: [49152, 65535] };
/** Where every fixed test port lies: below every default ephemeral range and the Vitest blocks. */
export const FIXED_ZONE = [10000, 19999];
/**
 * Every fixed port of the test harnesses, by harness (the unit test ports-zone.test.ts checks
 * them all). `e2e` is moved by SWARMCAST_E2E_PORT_OFFSET (e2ePorts()); docs screenshots run the
 * e2e server with SCREENSHOTS_OFFSET.
 */
export const FIXED_PORTS = {
  /** apps/server/test/e2e/server.ts, playwright.config.ts, fixtures.ts (control: its test control port). */
  e2e: { public: 11080, admin: 11081, control: 11082, mediamtxHls: 11083, rtmp: 11935 },
  /** site/playwright.config.ts and site/test/serve.mjs (SITE_E2E_PORT moves it). */
  site: { http: 13210 },
  /** scripts/test/obs-e2e/run.mjs (a real OBS, run by hand). */
  obsE2e: { public: 14080, admin: 14081, mediamtxHls: 14888, rtmp: 14935 },
  /** scripts/test/quality/debug-ladder.ts (run by hand). */
  qualityDebug: { public: 15080, admin: 15081, mediamtxHls: 15888, rtmp: 15935 },
  /** scripts/test/quality/server.ts, bench.ts and menu-check.ts (run by hand). */
  quality: { public: 16080, admin: 16081, control: 16082, mediamtxHls: 16888, rtmp: 16935 },
  /** The update server of scripts/test/desktop/verify.mjs (--update-port), named in the manifests _desktop.yml and soak.yml make. */
  desktopUpdate: { http: 17811 },
};
/** The offset scripts/docs/screenshots.mjs runs the e2e server with, so it can run next to the e2e suite. */
export const SCREENSHOTS_OFFSET = 1000;

/** The e2e server's ports moved by `offset` (SWARMCAST_E2E_PORT_OFFSET). */
export function e2ePorts(offset = Number(process.env.SWARMCAST_E2E_PORT_OFFSET ?? 0)) {
  return Object.fromEntries(Object.entries(FIXED_PORTS.e2e).map(([name, port]) => [name, port + offset]));
}

/** Two numbers of `text` in order ("32768\t60999", or netsh's "Start Port : 49152 / Number of Ports : 16384"). */
const numbers = (text) => (text.match(/\d+/g) ?? []).map(Number);

/**
 * This machine's ephemeral port range [first, last]: what the OS really uses now, read from the
 * kernel (Linux), sysctl (macOS) or netsh (Windows, in any language: the start and the count are
 * the only numbers it prints). The OS default when it cannot be read.
 */
export function ephemeralRange(platform = process.platform) {
  const fallback = EPHEMERAL_DEFAULTS[platform] ?? EPHEMERAL_DEFAULTS.linux;
  try {
    if (platform === 'linux') {
      const [first, last] = numbers(fs.readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8'));
      if (first && last) return [first, last];
    } else if (platform === 'darwin') {
      const [first, last] = numbers(execFileSync('sysctl', ['-n', 'net.inet.ip.portrange.first', 'net.inet.ip.portrange.last'], { encoding: 'utf8', timeout: 5000 }));
      if (first && last) return [first, last];
    } else if (platform === 'win32') {
      const [start, count] = numbers(execFileSync('netsh', ['int', 'ipv4', 'show', 'dynamicport', 'tcp'], { encoding: 'utf8', timeout: 5000, windowsHide: true }));
      if (start && count) return [start, start + count - 1];
    }
  } catch {
    /* the default below */
  }
  return fallback;
}

/**
 * What is wrong with the fixed ports `ports` ({ name: port }) of the harness `harness` (a key of
 * FIXED_PORTS): not a port number, outside FIXED_ZONE, inside an ephemeral range (`ranges`: this
 * machine's and every OS default), on a RESERVED port, or on a fixed port of another harness.
 * One sentence per problem; none when the ports are fine.
 */
export function fixedPortProblems(harness, ports, ranges = [ephemeralRange(), ...Object.values(EPHEMERAL_DEFAULTS)]) {
  const others = new Map();
  for (const [h, map] of Object.entries(FIXED_PORTS)) if (h !== harness) for (const [name, port] of Object.entries(map)) others.set(port, `${h}.${name}`);
  const problems = [];
  for (const [name, port] of Object.entries(ports)) {
    const at = `${name} would be ${port}`;
    if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push(`${at}, not a port number`);
    else if (RESERVED.has(port)) problems.push(`${at}, a port of a SwarmCast that may run on this computer (RESERVED)`);
    else if (port < FIXED_ZONE[0] || port > FIXED_ZONE[1]) problems.push(`${at}, outside ${FIXED_ZONE[0]}-${FIXED_ZONE[1]}`);
    else if (others.has(port)) problems.push(`${at}, the port of ${others.get(port)}`);
    for (const [first, last] of ranges) if (port >= first && port <= last) problems.push(`${at}, inside the ephemeral range ${first}-${last}, where outgoing connections take their local ports`);
  }
  return [...new Set(problems)];
}

/** Throws, naming every problem, unless fixedPortProblems() finds none. `what` names the setting at fault. */
export function assertFixedPorts(harness, ports, what = 'its fixed ports') {
  const problems = fixedPortProblems(harness, ports);
  if (problems.length) throw new Error(`${harness}: ${what} cannot be used: ${problems.join('; ')} (scripts/test/lib/ports.mjs).`);
}

function poolId() {
  const id = Number(process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? 0);
  return Number.isInteger(id) && id >= 0 ? id : 0;
}

let cursor = null;

/** True when this process can listen on `port` on 127.0.0.1 and on all interfaces right now. */
export async function canListen(port) {
  for (const host of ['127.0.0.1', undefined]) {
    const ok = await new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen({ port, host, exclusive: true }, () => s.close(() => resolve(true)));
    });
    if (!ok) return false;
  }
  return true;
}

/**
 * True when something accepts TCP connections on host:port right now (a connect probe; 800 ms
 * without an answer counts as no). For "is the app still listening" checks.
 */
export function isListening(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    s.setTimeout(800, () => (s.destroy(), resolve(false)));
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });
}

/** `n` distinct ports of this worker's block that are free right now. */
export async function allocPorts(n) {
  const base = PORT_BASE + (poolId() % BLOCKS) * BLOCK;
  cursor ??= crypto.randomInt(BLOCK);
  const out = [];
  for (let tried = 0; out.length < n; tried++) {
    if (tried >= BLOCK) throw new Error(`no ${n} free ports left in ${base}-${base + BLOCK - 1} (worker ${poolId()})`);
    const port = base + (cursor++ % BLOCK);
    if (RESERVED.has(port) || out.includes(port)) continue;
    if (await canListen(port)) out.push(port);
  }
  return out;
}

/** Named ports: `await allocPortMap(['rtmp', 'mediamtxHls'])` gives `{ rtmp: 20113, mediamtxHls: 20114 }`. */
export async function allocPortMap(names) {
  const ports = await allocPorts(names.length);
  return Object.fromEntries(names.map((name, i) => [name, ports[i]]));
}

/** True for the error of a server that could not bind its port (worth one retry on new ports). */
export function isBindError(err) {
  const text = `${err?.code ?? ''} ${err?.message ?? ''}`;
  return /EADDRINUSE|EACCES|address already in use|already in use|err\.rtmpBusy|err\.portsBusy|bind:/i.test(text);
}
