import dgram from 'node:dgram';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** Minimal UPnP Internet Gateway Device for tests: SSDP responder + description + SOAP control. */
export class MockIgd {
  externalIp: string;
  mappings = new Map<number, { internalPort: number; client: string; description: string; lease: number }>();
  calls: string[] = [];
  onlyPermanentLeases = false;
  private http!: http.Server;
  private udp!: dgram.Socket;
  ssdpPort = 0;
  httpPort = 0;

  constructor(externalIp: string) {
    this.externalIp = externalIp;
  }

  async start(): Promise<void> {
    this.http = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url === '/desc.xml') {
          res.writeHead(200, { 'Content-Type': 'text/xml' }).end(`<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0"><device><deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
<deviceList><device><deviceList><device><serviceList><service>
<serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
<controlURL>/ctl/IPConn</controlURL></service></serviceList></device></deviceList></device></deviceList></device></root>`);
          return;
        }
        const action = /#(\w+)"?$/.exec(String(req.headers.soapaction ?? ''))?.[1] ?? '';
        this.calls.push(action);
        const arg = (n: string): string => new RegExp(`<${n}>([^<]*)</${n}>`).exec(body)?.[1] ?? '';
        const fault = (code: number, desc: string) =>
          res.writeHead(500, { 'Content-Type': 'text/xml' }).end(`<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>${code}</errorCode><errorDescription>${desc}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`);
        const ok = (inner = '') => res.writeHead(200, { 'Content-Type': 'text/xml' }).end(`<s:Envelope><s:Body><u:${action}Response>${inner}</u:${action}Response></s:Body></s:Envelope>`);
        const port = Number(arg('NewExternalPort'));
        switch (action) {
          case 'GetExternalIPAddress':
            return ok(`<NewExternalIPAddress>${this.externalIp}</NewExternalIPAddress>`);
          case 'AddPortMapping': {
            const lease = Number(arg('NewLeaseDuration'));
            if (this.onlyPermanentLeases && lease !== 0) return fault(725, 'OnlyPermanentLeasesSupported');
            this.mappings.set(port, { internalPort: Number(arg('NewInternalPort')), client: arg('NewInternalClient'), description: arg('NewPortMappingDescription'), lease });
            return ok();
          }
          case 'DeletePortMapping':
            if (!this.mappings.delete(port)) return fault(714, 'NoSuchEntryInArray');
            return ok();
          case 'GetSpecificPortMappingEntry':
            if (!this.mappings.has(port)) return fault(714, 'NoSuchEntryInArray');
            return ok(`<NewInternalPort>${this.mappings.get(port)!.internalPort}</NewInternalPort>`);
          default:
            return fault(401, 'Invalid Action');
        }
      });
    });
    await new Promise<void>((r) => this.http.listen(0, '127.0.0.1', () => r()));
    this.httpPort = (this.http.address() as AddressInfo).port;
    this.udp = dgram.createSocket('udp4');
    this.udp.on('message', (msg, rinfo) => {
      if (!msg.toString().startsWith('M-SEARCH')) return;
      const reply = `HTTP/1.1 200 OK\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\nLOCATION: http://127.0.0.1:${this.httpPort}/desc.xml\r\n\r\n`;
      this.udp.send(reply, rinfo.port, rinfo.address);
    });
    await new Promise<void>((r) => this.udp.bind(0, '127.0.0.1', () => r()));
    this.ssdpPort = this.udp.address().port;
  }

  async stop(): Promise<void> {
    this.udp.close();
    await new Promise((r) => this.http.close(r));
  }
}
