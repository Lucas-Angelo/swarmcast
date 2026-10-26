import { execFile } from 'node:child_process';
import dgram from 'node:dgram';
import net from 'node:net';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface PortMapper {
  readonly kind: 'upnp' | 'natpmp';
  /** Identifier persisted to disk to remove a mapping after a crash. */
  readonly id: string;
  externalIp(): Promise<string>;
  map(externalPort: number, internalPort: number, internalHost: string, description: string, leaseSeconds: number): Promise<void>;
  unmap(externalPort: number, internalPort?: number): Promise<void>;
  hasMapping(externalPort: number): Promise<boolean>;
}

/** IPv4 private, CGNAT (100.64/10), loopback and link-local ranges. */
export function isNonPublicIPv4(ip: string): boolean {
  if (net.isIPv4(ip) === false) return false;
  const [a = 0, b = 0] = ip.split('.').map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/** Default IPv4 gateway of this machine, or null. */
export async function defaultGateway(): Promise<string | null> {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await run('route', ['-n', 'get', 'default']);
      return /gateway:\s*([\d.]+)/.exec(stdout)?.[1] ?? null;
    }
    if (process.platform === 'linux') {
      const { stdout } = await run('ip', ['-4', 'route', 'show', 'default']);
      return /default via ([\d.]+)/.exec(stdout)?.[1] ?? null;
    }
    if (process.platform === 'win32') {
      const { stdout } = await run('powershell.exe', [
        '-NoProfile',
        '-Command',
        '(Get-NetRoute -DestinationPrefix 0.0.0.0/0 | Sort-Object RouteMetric | Select-Object -First 1).NextHop',
      ]);
      const ip = stdout.trim();
      return net.isIPv4(ip) ? ip : null;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Local IPv4 address of the interface that routes to `target`. */
export function localAddressTowards(target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.connect(9, target, () => {
      const addr = s.address().address;
      s.close();
      resolve(addr);
    });
    s.on('error', (e) => {
      s.close();
      reject(e);
    });
  });
}
