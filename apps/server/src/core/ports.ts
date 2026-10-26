import net from 'node:net';

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

function canBind(port: number, host: string): Promise<boolean> {
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
  if (!(await canBind(port, host))) return false;
  if (host === '127.0.0.1' || host === 'localhost') return canBind(port, '0.0.0.0');
  return true;
}

/** The preferred port if free, otherwise the next free one within `span`. */
export async function firstFreePort(preferred: number, span = 20, host = '127.0.0.1'): Promise<number | null> {
  for (let p = preferred; p < preferred + span && p <= 65535; p++) {
    if (await isPortFree(p, host)) return p;
  }
  return null;
}
