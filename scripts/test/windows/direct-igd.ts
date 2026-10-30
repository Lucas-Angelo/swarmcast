// Direct mode on Windows against the mock UPnP gateway (apps/server/test/unit/mock-igd.ts),
// binding the real way (0.0.0.0, like LiveController.startDirectServer), then reaching the
// HTTPS server over loopback and over the machine's LAN address. Prints one JSON line per
// check ({"name","ok","detail"}) for scripts/test/windows/direct.mjs.
//
// Run: node --import tsx scripts/test/windows/direct-igd.ts
import crypto from 'node:crypto';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import pino from 'pino';
import { MemoryStateStore } from '../../../apps/server/src/core/state.js';
import { SelfSignedIssuer } from '../../../apps/server/src/direct/certs.js';
import { DirectMode } from '../../../apps/server/src/direct/direct.js';
import { UpnpGateway, discoverUpnp } from '../../../apps/server/src/direct/upnp.js';
import { MockIgd } from '../../../apps/server/test/unit/mock-igd.js';

const out = (name: string, ok: boolean, detail = ''): void => console.log(JSON.stringify({ name, ok, detail }));
const lan = Object.values(os.networkInterfaces())
  .flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

/** The certificate the server under test presents (set by startServer below). */
let pinned: { pem: string; der: Buffer } | null = null;

function get(host: string, port: number): Promise<number> {
  return new Promise((resolve) => {
    // Certificate checks stay on, pinned to the server's own self-signed certificate. It names
    // the public IP (203.0.113.7), not localhost / 127.0.0.1 / the LAN address, so the host name
    // check is replaced by comparing the exact certificate.
    const checkServerIdentity = (_host: string, peer: { raw: Buffer }): Error | undefined =>
      pinned && peer.raw.equals(pinned.der) ? undefined : new Error('not the certificate of the server under test');
    const req = https.get({ host, port, path: '/', ca: pinned?.pem, checkServerIdentity, timeout: 5000 }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(0));
  });
}

function tcpOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.setTimeout(2000, () => (s.destroy(), resolve(false)));
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });
}

const igd = new MockIgd('203.0.113.7');
await igd.start();
const servers: Array<{ close(): Promise<void> }> = [];
let bound = '';
const state = new MemoryStateStore();
const d = new DirectMode({
  log: pino({ level: 'silent' }),
  state,
  discoverMapper: () => discoverUpnp({ address: '127.0.0.1', port: igd.ssdpPort, timeoutMs: 1500 }),
  mapperFromId: (_k, id) => UpnpGateway.fromId(id),
  publicIps: async () => ({ v4: '203.0.113.7' }),
  localAddress: async () => lan ?? '127.0.0.1',
  localAddresses: () => [],
  issuer: new SelfSignedIssuer(),
  startServer: async (port, host, sni, defaultCert) => {
    pinned = { pem: defaultCert.cert, der: new crypto.X509Certificate(defaultCert.cert).raw };
    const srv = https.createServer({ SNICallback: sni, key: defaultCert.key, cert: defaultCert.cert }, (_q, r) => r.end('ok'));
    await new Promise<void>((r, j) => {
      srv.once('error', j);
      srv.listen(port, host, () => r());
    });
    const a = srv.address();
    bound = typeof a === 'object' && a ? `${a.address}:${a.port}` : String(a);
    const h = { close: () => new Promise<void>((r) => srv.close(() => r())) };
    servers.push(h);
    return h;
  },
  probe: async () => false,
});

try {
  const check = await d.check();
  out('check() finds the mock gateway (UPnP over SSDP on Windows)', check.ok && !!check.mapper, check.message);
  const url = await d.enable();
  const port = Number(new URL(url).port);
  const m = igd.mappings.get(port);
  out('enable(): exactly one router mapping to this PC, random high port', igd.mappings.size === 1 && !!m && port >= 20000 && port < 60000 && m.internalPort === port, `${url} -> ${m?.client}:${m?.internalPort}`);
  out('server bound to 0.0.0.0 (all interfaces), as the app does', bound.startsWith('0.0.0.0:'), bound);
  out('HTTPS answers with a host name (SNI sent): https://localhost:<port>', (await get('localhost', port)) === 200);
  // Direct-mode links are https://<public IP>:<port>. Clients never send SNI for an IP literal
  // (RFC 6066): the server answers with its default certificate (key/cert beside the
  // SNICallback, as apps/server/src/public/server.ts sets them).
  const viaIp = (await get('127.0.0.1', port)) === 200;
  out('HTTPS answers for an IP-literal URL (no SNI), as viewers open the direct link: https://127.0.0.1:<port>', viaIp, viaIp ? '' : 'the TLS handshake without SNI failed: no default certificate');
  if (lan) {
    const viaLan = (await get(lan, port)) === 200;
    out('HTTPS answers on the LAN address (IP literal, no SNI)', viaLan, viaLan ? '' : `${lan}: the TLS handshake without SNI failed (local traffic; inbound from other machines also depends on Windows Firewall)`);
  }
  const r = await d.disable();
  out('disable(): mapping removed and verified', r.verified && igd.mappings.size === 0 && !state.state.activeMapping, r.details.join(', '));
  out('port closed after disable', !(await tcpOpen(port)));
} catch (e) {
  out('direct mode with the mock gateway', false, (e as Error).stack ?? String(e));
} finally {
  for (const s of servers) await s.close().catch(() => {});
  await igd.stop();
}
