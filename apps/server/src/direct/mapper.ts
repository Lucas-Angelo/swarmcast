import { execFile } from 'node:child_process';
import dgram from 'node:dgram';
import net from 'node:net';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** A command runner (execFile's promise form): tests pass their own. */
export type GatewayRunner = (cmd: string, args: string[], options: { windowsHide: boolean; timeout: number }) => Promise<{ stdout: string }>;

/**
 * How the gateway tools run: never with a console window of their own (on Windows a PowerShell
 * started from the desktop app would flash one on screen), and never for long (a tool that hangs
 * would hold up Direct mode's start).
 */
export const GATEWAY_TOOL_OPTIONS = { windowsHide: true, timeout: 10_000 } as const;

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
export async function defaultGateway(platform: NodeJS.Platform = process.platform, runTool: GatewayRunner = run): Promise<string | null> {
  try {
    if (platform === 'darwin') {
      const { stdout } = await runTool('route', ['-n', 'get', 'default'], GATEWAY_TOOL_OPTIONS);
      return /gateway:\s*([\d.]+)/.exec(stdout)?.[1] ?? null;
    }
    if (platform === 'linux') {
      const { stdout } = await runTool('ip', ['-4', 'route', 'show', 'default'], GATEWAY_TOOL_OPTIONS);
      return /default via ([\d.]+)/.exec(stdout)?.[1] ?? null;
    }
    if (platform === 'win32') {
      const { stdout } = await runTool(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', '(Get-NetRoute -DestinationPrefix 0.0.0.0/0 | Sort-Object RouteMetric | Select-Object -First 1).NextHop'],
        GATEWAY_TOOL_OPTIONS,
      );
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
