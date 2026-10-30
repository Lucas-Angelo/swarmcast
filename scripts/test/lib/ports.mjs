// Ports for tests whose server needs a number before it starts (MediaMTX's RTMP and HLS ports,
// a SwarmCast started with a config file). Servers the test itself creates should listen on
// port 0 instead: the OS then picks a free port at listen time, with no race at all.
//
// - Each Vitest worker gets its own block (PORT_BASE + VITEST_POOL_ID x BLOCK), so test files
//   running in parallel never pick the same port. Within a process, ports are handed out in
//   turn from a random point of the block, so the next file in the same worker starts elsewhere.
// - Every block lies in 20000-31999: below Windows' dynamic range (49152-65535, where Hyper-V,
//   WSL and Docker reserve whole ranges) and below Linux's ephemeral range (32768-60999), from
//   which outgoing connections take their local ports.
// - Each candidate is probed with a real listen on 127.0.0.1 and on all interfaces. Ports in use
//   (EADDRINUSE) and ports Windows refuses (EACCES: an excluded range, see `netsh int ipv4 show
//   excludedportrange protocol=tcp`) are skipped.
// - Never the ports of a SwarmCast someone runs on this computer (the defaults and the demo's).
import crypto from 'node:crypto';
import net from 'node:net';

export const PORT_BASE = 20000;
export const BLOCK = 200;
const BLOCKS = 60; // 20000 + 60 x 200 = 32000
/** SwarmCast's default ports and the demo's: a test never takes them, even when they are free. */
export const RESERVED = new Set([1935, 8080, 8888, 8889, 31935, 38180, 38181, 38888]);

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
