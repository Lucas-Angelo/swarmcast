import dgram from 'node:dgram';
import type { PortMapper } from './mapper.js';

/** Minimal UPnP Internet Gateway Device client (SSDP discovery + SOAP WAN*Connection). */

const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];

export interface SsdpOptions {
  address?: string;
  port?: number;
  timeoutMs?: number;
}

/** Send M-SEARCH and collect LOCATION headers of gateways that answer. */
export function ssdpSearch(opts: SsdpOptions = {}): Promise<string[]> {
  const address = opts.address ?? '239.255.255.250';
  const port = opts.port ?? 1900;
  const timeoutMs = opts.timeoutMs ?? 3000;
  return new Promise((resolve) => {
    const found = new Set<string>();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const finish = (): void => {
      try {
        sock.close();
      } catch {
        /* closed */
      }
      resolve([...found]);
    };
    sock.on('message', (msg) => {
      const loc = /^location:\s*(.+)$/im.exec(msg.toString())?.[1]?.trim();
      if (loc && /^https?:\/\//i.test(loc)) found.add(loc);
    });
    sock.on('error', finish);
    sock.bind(0, () => {
      for (const st of SEARCH_TARGETS) {
        const req = Buffer.from(
          `M-SEARCH * HTTP/1.1\r\nHOST: ${address}:${port}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`,
        );
        sock.send(req, port, address);
      }
    });
    setTimeout(finish, timeoutMs).unref();
  });
}

interface WanService {
  serviceType: string;
  controlUrl: string;
}

/** Find the WANIPConnection/WANPPPConnection control URL in a device description. */
export function parseDeviceDescription(xml: string, location: string): WanService | null {
  const base = /<URLBase>\s*([^<]+?)\s*<\/URLBase>/i.exec(xml)?.[1] ?? location;
  const services = xml.match(/<service>[\s\S]*?<\/service>/gi) ?? [];
  for (const s of services) {
    const type = /<serviceType>\s*([^<]+?)\s*<\/serviceType>/i.exec(s)?.[1];
    const ctrl = /<controlURL>\s*([^<]+?)\s*<\/controlURL>/i.exec(s)?.[1];
    if (type && ctrl && /WAN(IP|PPP)Connection/i.test(type)) {
      return { serviceType: type, controlUrl: new URL(ctrl, base).href };
    }
  }
  return null;
}

export class UpnpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

export class UpnpGateway implements PortMapper {
  readonly kind = 'upnp' as const;

  constructor(
    private readonly service: WanService,
    readonly location: string,
  ) {}

  /** Identifier saved to disk so a crash can be cleaned up later. */
  get id(): string {
    return `${this.service.serviceType}|${this.service.controlUrl}`;
  }

  static fromId(id: string): UpnpGateway {
    const [serviceType, controlUrl] = id.split('|');
    if (!serviceType || !controlUrl) throw new Error('bad gateway id');
    return new UpnpGateway({ serviceType, controlUrl }, controlUrl);
  }

  private async soap(action: string, args: Record<string, string | number>): Promise<string> {
    const body =
      `<?xml version="1.0"?>\r\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
      `<s:Body><u:${action} xmlns:u="${this.service.serviceType}">` +
      Object.entries(args)
        .map(([k, v]) => `<${k}>${xmlEscape(String(v))}</${k}>`)
        .join('') +
      `</u:${action}></s:Body></s:Envelope>`;
    const res = await fetch(this.service.controlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPAction: `"${this.service.serviceType}#${action}"`,
      },
      body,
      signal: AbortSignal.timeout(5000),
    });
    const text = await res.text();
    if (!res.ok) {
      const code = Number(/<errorCode>\s*(\d+)\s*<\/errorCode>/i.exec(text)?.[1]);
      const desc = /<errorDescription>\s*([^<]*)<\/errorDescription>/i.exec(text)?.[1] ?? `HTTP ${res.status}`;
      throw new UpnpError(`${action} failed: ${desc}`, Number.isFinite(code) ? code : undefined);
    }
    return text;
  }

  async externalIp(): Promise<string> {
    const xml = await this.soap('GetExternalIPAddress', {});
    const ip = /<NewExternalIPAddress>\s*([^<]*?)\s*<\/NewExternalIPAddress>/i.exec(xml)?.[1];
    if (!ip) throw new UpnpError('router did not report its external IP');
    return ip;
  }

  async map(externalPort: number, internalPort: number, internalHost: string, description: string, leaseSeconds: number): Promise<void> {
    const args = (lease: number): Record<string, string | number> => ({
      NewRemoteHost: '',
      NewExternalPort: externalPort,
      NewProtocol: 'TCP',
      NewInternalPort: internalPort,
      NewInternalClient: internalHost,
      NewEnabled: 1,
      NewPortMappingDescription: description,
      NewLeaseDuration: lease,
    });
    try {
      await this.soap('AddPortMapping', args(leaseSeconds));
    } catch (err) {
      // 725 = OnlyPermanentLeasesSupported. We still remove it ourselves on stop.
      if (err instanceof UpnpError && err.code === 725) await this.soap('AddPortMapping', args(0));
      else throw err;
    }
  }

  async unmap(externalPort: number): Promise<void> {
    try {
      await this.soap('DeletePortMapping', { NewRemoteHost: '', NewExternalPort: externalPort, NewProtocol: 'TCP' });
    } catch (err) {
      // 714 = NoSuchEntryInArray: already gone.
      if (!(err instanceof UpnpError && err.code === 714)) throw err;
    }
  }

  async hasMapping(externalPort: number): Promise<boolean> {
    try {
      await this.soap('GetSpecificPortMappingEntry', { NewRemoteHost: '', NewExternalPort: externalPort, NewProtocol: 'TCP' });
      return true;
    } catch (err) {
      if (err instanceof UpnpError && (err.code === 714 || err.code === 402)) return false;
      throw err;
    }
  }
}

/** Discover the first UPnP gateway with a WAN connection service. */
export async function discoverUpnp(opts: SsdpOptions = {}): Promise<UpnpGateway | null> {
  const locations = await ssdpSearch(opts);
  for (const loc of locations) {
    try {
      const res = await fetch(loc, { signal: AbortSignal.timeout(4000) });
      const svc = parseDeviceDescription(await res.text(), loc);
      if (svc) return new UpnpGateway(svc, loc);
    } catch {
      /* try next */
    }
  }
  return null;
}
