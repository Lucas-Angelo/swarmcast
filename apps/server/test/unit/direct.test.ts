import https from 'node:https';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canBindPort } from '../../src/core/ports.js';
import { MemoryStateStore } from '../../src/core/state.js';
import { SelfSignedIssuer } from '../../src/direct/certs.js';
import { CGNAT_MESSAGE, DirectMode, ipChangeMessage, type DirectDeps } from '../../src/direct/direct.js';
import { UpnpGateway, discoverUpnp } from '../../src/direct/upnp.js';
import { isNonPublicIPv4 } from '../../src/direct/mapper.js';
import { MockIgd } from './mock-igd.js';
import { silentLog } from './helpers.js';

let igd: MockIgd;
const servers: Array<{ close(): Promise<void> }> = [];

beforeEach(async () => {
  igd = new MockIgd('203.0.113.7');
  await igd.start();
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  await igd.stop();
});

function deps(over: Partial<DirectDeps> = {}): DirectDeps {
  return {
    log: silentLog,
    state: new MemoryStateStore(),
    discoverMapper: () => discoverUpnp({ address: '127.0.0.1', port: igd.ssdpPort, timeoutMs: 400 }),
    mapperFromId: (_k, id) => UpnpGateway.fromId(id),
    publicIps: async () => ({ v4: '203.0.113.7' }),
    localAddress: async () => '127.0.0.1',
    localAddresses: () => ['127.0.0.1'],
    issuer: new SelfSignedIssuer(),
    startServer: async (port, _host, sni, defaultCert) => {
      // Bind to loopback in tests; the real app binds 0.0.0.0.
      const srv = https.createServer({ SNICallback: sni, key: defaultCert.key, cert: defaultCert.cert }, (_q, r) => r.end('ok'));
      await new Promise<void>((r) => srv.listen(port, '127.0.0.1', () => r()));
      const h = { close: () => new Promise<void>((r) => srv.close(() => r())) };
      servers.push(h);
      return h;
    },
    probe: async () => false,
    random: () => 0.5,
    ...over,
  };
}

describe('direct mode: CGNAT detection', () => {
  it('blocks activation when the router WAN IP differs from the public IP', async () => {
    igd.externalIp = '100.64.12.34';
    const d = new DirectMode(deps());
    const check = await d.check();
    expect(check.ok).toBe(false);
    expect(check.message).toBe(CGNAT_MESSAGE);
    await expect(d.enable()).rejects.toThrow(/CGNAT/);
    expect(igd.mappings.size).toBe(0);
  });

  it('blocks when the router reports a private WAN address even if equal', async () => {
    igd.externalIp = '10.0.0.2';
    const d = new DirectMode(deps({ publicIps: async () => ({ v4: '10.0.0.2' }) }));
    expect((await d.check()).ok).toBe(false);
  });

  it('offers public IPv6 when IPv4 is behind CGNAT', async () => {
    igd.externalIp = '100.64.1.1';
    const d = new DirectMode(deps({ publicIps: async () => ({ v4: '203.0.113.7', v6: '2001:db8::5' }), localAddresses: () => ['2001:db8::5'] }));
    const check = await d.check();
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.family).toBe(6);
  });

  it('without a router answer, requires an explicit manual port-forward choice', async () => {
    const d = new DirectMode(deps({ discoverMapper: async () => null }));
    const check = await d.check();
    expect(check.ok && check.needsManualForward).toBe(true);
    await expect(d.enable()).rejects.toThrow(/couldn't talk to your router/);
    const url = await d.enable({ manualPortForward: true });
    expect(url).toMatch(/^https:\/\/203\.0\.113\.7:\d+$/);
    expect(d.snapshot().mapping).toBe('manual');
    await d.disable();
  });

  it('classifies private ranges', () => {
    for (const ip of ['10.1.2.3', '100.64.0.1', '100.127.255.255', '172.16.0.1', '192.168.1.1', '127.0.0.1']) expect(isNonPublicIPv4(ip)).toBe(true);
    for (const ip of ['8.8.8.8', '100.63.0.1', '100.128.0.1', '172.32.0.1']) expect(isNonPublicIPv4(ip)).toBe(false);
  });
});

describe('direct mode: port mapping lifecycle', () => {
  it('opens exactly one random high port and removes it on disable', async () => {
    const state = new MemoryStateStore();
    const d = new DirectMode(deps({ state }));
    const url = await d.enable();
    expect(igd.mappings.size).toBe(1);
    const [port, m] = [...igd.mappings][0]!;
    expect(port).toBeGreaterThanOrEqual(20000);
    expect(port).toBeLessThan(60000);
    expect([1935, 8080, 8081]).not.toContain(port);
    expect(m.internalPort).toBe(port);
    expect(url).toBe(`https://203.0.113.7:${port}`);
    expect(state.state.activeMapping?.externalPort).toBe(port);
    expect(state.state.lastDirectIp).toBe('203.0.113.7');
    expect(d.certificateSource).toBe('self-signed');

    const r = await d.disable();
    expect(r.verified).toBe(true);
    expect(igd.mappings.size).toBe(0);
    expect(state.state.activeMapping).toBeNull();
    expect(d.certificateSource).toBeUndefined();
    expect(igd.calls).toContain('DeletePortMapping');
  });

  it('falls back to a permanent lease when the router requires it', async () => {
    igd.onlyPermanentLeases = true;
    const d = new DirectMode(deps());
    await d.enable();
    expect([...igd.mappings.values()][0]!.lease).toBe(0);
    await d.disable();
    expect(igd.mappings.size).toBe(0);
  });

  it('reports a failed verification when the port still answers from outside', async () => {
    const d = new DirectMode(deps({ probe: async () => true }));
    await d.enable();
    const r = await d.disable();
    expect(r.verified).toBe(false);
    expect(r.details.join()).toMatch(/still answers/);
  });

  it('cleans up a mapping left by a crash using the saved identifier', async () => {
    const state = new MemoryStateStore();
    const crashed = new DirectMode(deps({ state }));
    await crashed.enable();
    expect(igd.mappings.size).toBe(1);
    // Simulate a crash: a new instance starts with the saved state.
    const next = new DirectMode(deps({ state }));
    await next.init();
    expect(next.staleMapping).toBe(true);
    expect(await next.cleanupStale()).toBe(true);
    expect(igd.mappings.size).toBe(0);
    expect(next.snapshot().staleMappingWarning).toBe(false);
  });
});

describe('direct mode: IP change message', () => {
  it('says whether the IP changed since the last direct mode', async () => {
    const changed = new DirectMode(deps({ state: new MemoryStateStore({ lastDirectIp: '198.51.100.1' }) }));
    await changed.init();
    expect(changed.ipChanged).toBe(true);
    expect(ipChangeMessage(changed.ipChanged)).toBe('Your IP changed since you last used direct mode ✓');

    const same = new DirectMode(deps({ state: new MemoryStateStore({ lastDirectIp: '203.0.113.7' }) }));
    await same.init();
    expect(same.ipChanged).toBe(false);
    expect(ipChangeMessage(same.ipChanged)).toMatch(/still the same/);

    const never = new DirectMode(deps());
    await never.init();
    expect(ipChangeMessage(never.ipChanged)).toBeNull();
  });
});

describe('direct mode never turns itself on', () => {
  it('check() does not open ports', async () => {
    const d = new DirectMode(deps());
    await d.check();
    await d.check();
    expect(igd.calls).not.toContain('AddPortMapping');
    expect(d.active).toBe(false);
  });

  it('the controller only suggests it', async () => {
    const enable = vi.spyOn(DirectMode.prototype, 'enable');
    const { makeController } = await import('./live-helpers.js');
    const { live } = makeController(new DirectMode(deps()));
    live.access.begin();
    // Simulate a struggling tunnel.
    for (let i = 0; i < 3; i++) (live as unknown as { tunnelDrops: number }).tunnelDrops++;
    const snap = live.snapshot();
    expect(snap.direct.suggestion).toMatch(/Direct mode/);
    expect(snap.mode).toBe('secure');
    expect(enable).not.toHaveBeenCalled();
    enable.mockRestore();
  });
});

describe('controller: switching modes', () => {
  it('direct mode gives a new link, drops old sessions, and returning closes the port', async () => {
    const { makeController } = await import('./live-helpers.js');
    const direct = new DirectMode(deps());
    const { live } = makeController(direct);
    live.access.begin();
    (live as unknown as { baseUrl: string }).baseUrl = 'https://old.trycloudflare.com';
    const oldLink = live.liveLink!;
    const s = live.access.createSession({ nickname: 'a', deviceId: 'd', device: 'desktop', ip: 'ip' });

    const link = await live.enableDirect({});
    expect(link).toMatch(/^https:\/\/203\.0\.113\.7:\d+\/join\//);
    expect(link).not.toBe(oldLink);
    expect(live.mode).toBe('direct');
    expect(live.access.sessions.has(s.id)).toBe(false);
    expect(igd.mappings.size).toBe(1);

    const back = await live.disableDirect();
    expect(live.mode).toBe('secure');
    expect(back).not.toBe(link);
    expect(igd.mappings.size).toBe(0);
  });

  it('"Stop everything" removes the mapping too', async () => {
    const { makeController } = await import('./live-helpers.js');
    const direct = new DirectMode(deps());
    const { live } = makeController(direct);
    live.access.begin();
    live.phase = 'live';
    await live.enableDirect({});
    expect(igd.mappings.size).toBe(1);
    await live.stop();
    expect(igd.mappings.size).toBe(0);
    expect(live.phase).toBe('off');
    expect(live.steps.find((x) => x.id === 'tunnel')?.status).toBe('ok');
  });
});

describe('direct mode TLS without SNI (browsers never send SNI for an IP address)', () => {
  it('the app server answers https://<IP>:<port> using the default certificate', async () => {
    const { makeController } = await import('./live-helpers.js');
    const { live } = makeController(new DirectMode(deps()));
    const cert = await new SelfSignedIssuer().issue('127.0.0.1');
    const tls = await import('node:tls');
    const ctx = tls.createSecureContext({ key: cert.keyPem, cert: cert.certPem });
    const port = 41000 + Math.floor(Math.random() * 2000);
    const handle = await live.startDirectServer(port, '127.0.0.1', (_n, cb) => cb(null, ctx), { key: cert.keyPem, cert: cert.certPem });
    servers.push(handle);
    const body = await new Promise<string>((resolve, reject) => {
      // An IP host: Node (like browsers) sends no SNI.
      https
        .get({ host: '127.0.0.1', port, path: '/healthz', rejectUnauthorized: false }, (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve(`${res.statusCode} ${b}`));
        })
        .on('error', reject);
    });
    expect(body).toMatch(/^200 /);
  });
});

describe('direct mode: a port the computer can really open', () => {
  // Windows reserves whole ranges of high ports (Hyper-V/WinNAT); listening there fails with
  // EACCES. Such ports (and ports in use) are skipped before anything is mapped on the router.
  it('skips ports that cannot be bound and maps the first one that can', async () => {
    const seq = [0.1, 0.2, 0.3];
    let i = 0;
    const refused: number[] = [];
    const d = new DirectMode(
      deps({
        random: () => seq[Math.min(i++, seq.length - 1)]!,
        canBind: async (port, host) => {
          expect(host).toBe('0.0.0.0');
          if (port < 30000) {
            refused.push(port);
            return false;
          }
          return true;
        },
      }),
    );
    const url = await d.enable();
    expect(refused).toEqual([24000, 28000]);
    expect(url).toBe('https://203.0.113.7:32000');
    expect([...igd.mappings.keys()]).toEqual([32000]);
    await d.disable();
  });

  it('gives a clear error, and maps nothing, when no port can be opened', async () => {
    let n = 0;
    const d = new DirectMode(deps({ random: () => (n++ % 1000) / 1000, canBind: async () => false }));
    await expect(d.enable()).rejects.toMatchObject({ code: 'err.directNoPort' });
    expect(igd.mappings.size).toBe(0);
    expect(d.active).toBe(false);
  });

  it('canBindPort is false for a port another server holds', async () => {
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, '0.0.0.0', () => r()));
    const port = (srv.address() as net.AddressInfo).port;
    expect(await canBindPort(port, '0.0.0.0')).toBe(false);
    await new Promise<void>((r) => srv.close(() => r()));
    expect(await canBindPort(port, '0.0.0.0')).toBe(true);
  });
});
