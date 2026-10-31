import net from 'node:net';
import { runCommand, system32 } from './exec.js';

/** True when something accepts TCP connections on host:port. */
export function isListening(port: number, host = '127.0.0.1', timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v: boolean): void => {
      s.removeAllListeners();
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/**
 * True when this process could listen on host:port right now. False for a port in use and for
 * one the OS refuses (on Windows, Hyper-V/WinNAT reserve whole ranges of high ports, listed by
 * `netsh interface ipv4 show excludedportrange protocol=tcp`; listening there fails with EACCES).
 */
export function canBindPort(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

/**
 * True when nothing else uses the port. We listen on 127.0.0.1, but Windows lets that bind
 * succeed next to another program's non-exclusive 0.0.0.0 listener on the same port (which
 * would then silently lose its local clients), so the wildcard address is checked too.
 */
export async function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  if (!(await canBindPort(port, host))) return false;
  if (host === '127.0.0.1' || host === 'localhost') return canBindPort(port, '0.0.0.0');
  return true;
}

/** The preferred port if free, otherwise the next free one within `span`. */
export async function firstFreePort(preferred: number, span = 20, host = '127.0.0.1'): Promise<number | null> {
  for (let p = preferred; p < preferred + span && p <= 65535; p++) {
    if (await isPortFree(p, host)) return p;
  }
  return null;
}

/** A port held by a real, exclusive listen until `release()`. */
export interface PortReservation {
  port: number;
  release(): Promise<void>;
}

/**
 * Listen on host:port for real (exclusive) and keep the port until `release()`. Rejects with the
 * listen error: EACCES when the OS refuses the port (on Windows: inside an excluded range, see
 * `excludedPortRanges`), EADDRINUSE when another program has it. Holding the port closes the
 * probe-then-bind gap while slow work (router mapping, certificate) runs before the real server.
 */
export function reservePort(port: number, host: string): Promise<PortReservation> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    // Nothing is served on it: a connection during the short holding time is just closed.
    srv.on('connection', (s) => s.destroy());
    srv.once('error', reject);
    srv.listen({ port, host, exclusive: true }, () => {
      srv.off('error', reject);
      let closed: Promise<void> | null = null;
      resolve({ port, release: () => (closed ??= new Promise<void>((r) => srv.close(() => r()))) });
    });
  });
}

/**
 * Windows only: the TCP port ranges the OS keeps for itself (Hyper-V, WSL, Docker, WinNAT), as
 * `netsh int ipv4 show excludedportrange protocol=tcp` prints them. Null elsewhere or on error.
 */
export function excludedPortRanges(timeoutMs = 5000): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return runCommand(system32('netsh.exe'), ['int', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp'], { timeoutMs }).then((r) => (r.ok ? r.stdout.trim() : null));
}
