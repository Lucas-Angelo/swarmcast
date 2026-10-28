import https from 'node:https';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canBindPort } from '../../src/core/ports.js';
import { MemoryStateStore } from '../../src/core/state.js';
import { SelfSignedIssuer } from '../../src/direct/certs.js';
import { CGNAT_MESSAGE, DIRECT_PORT_MAX, DIRECT_PORT_MIN, DirectMode, ipChangeMessage, type DirectDeps } from '../../src/direct/direct.js';
import { UpnpGateway, discoverUpnp, parseDeviceDescription } from '../../src/direct/upnp.js';
import { isNonPublicIPv4 } from '../../src/direct/mapper.js';
import { probeHealth } from '../../src/tunnel/provider.js';
import { allocPorts } from '../../../../scripts/test/lib/ports.mjs';
import { MockIgd } from './mock-igd.js';
import { silentLog } from './helpers.js';

// "Stop everything" checks that the Direct-mode address no longer answers. The address of these
// tests (203.0.113.7, a documentation range) never does: a real probe would wait out its 5 s
// timeout, after a DNS-over-HTTPS query to 1.1.1.1. It answers "gone" at once instead.
vi.mock('../../src/tunnel/provider.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/tunnel/provider.js')>()),
  probeHealth: vi.fn(async () => null),
}));

let igd: MockIgd;
const servers: Array<{ close(): Promise<void> }> = [];

/** The `random` that makes Direct mode pick exactly `port` (DirectMode.pickPort). */
const randomFor = (port: number) => (): number => (port - DIRECT_PORT_MIN + 0.5) / (DIRECT_PORT_MAX - DIRECT_PORT_MIN + 1);
/**
 * The port Direct mode picks in these tests, and really listens on. A fixed `random` would give
 * every test file the same port (port-range.test.ts listens on 34576 and 28745, which `0.5` and
 * the old sequence below gave too): a port from this worker's block instead.
 */
let directPort: number;

beforeEach(async () => {
  igd = new MockIgd('203.0.113.7');
  await igd.start();
  [directPort] = (await allocPorts(1)) as [number];
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  await igd.stop();
});

/**
 * The mock router, found from its description URL. SSDP discovery collects answers for its whole
 * window (400 ms here, every time); only the SSDP test below needs that.
 */
async function mockGateway(): Promise<UpnpGateway | null> {
  const location = `http://127.0.0.1:${igd.httpPort}/desc.xml`;
  const service = parseDeviceDescription(await (await fetch(location)).text(), location);
  return service ? new UpnpGateway(service, location) : null;
}

function deps(over: Partial<DirectDeps> = {}): DirectDeps {
  return {
    log: silentLog,
    state: new MemoryStateStore(),
    discoverMapper: mockGateway,
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
    random: randomFor(directPort),
    ...over,
  };
}

describe('direct mode: finding the router', () => {
  it('finds the router by SSDP and talks to it', async () => {
    const gw = await discoverUpnp({ address: '127.0.0.1', port: igd.ssdpPort, timeoutMs: 400 });
    expect(gw?.location).toBe(`http://127.0.0.1:${igd.httpPort}/desc.xml`);
    expect(await gw!.externalIp()).toBe('203.0.113.7');
  });
});

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
    expect(live.steps.find((x) => x.id === 'verify')?.status).toBe('ok');
    expect(vi.mocked(probeHealth)).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/203\.0\.113\.7:\d+$/));
  });
});

describe('direct mode TLS without SNI (browsers never send SNI for an IP address)', () => {
  it('the app server answers https://<IP>:<port> using the default certificate', async () => {
    const { makeController } = await import('./live-helpers.js');
    const { live } = makeController(new DirectMode(deps()));
    const cert = await new SelfSignedIssuer().issue('127.0.0.1');
    const tls = await import('node:tls');
    const ctx = tls.createSecureContext({ key: cert.keyPem, cert: cert.certPem });
    const port = (await allocPorts(1))[0]!;
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
    const [a, b] = (await allocPorts(2)) as [number, number];
    const seq = [a, b, directPort].map((p) => randomFor(p)());
    let i = 0;
    const refused: number[] = [];
    const d = new DirectMode(
      deps({
        random: () => seq[Math.min(i++, seq.length - 1)]!,
        reservePort: async (port, host) => {
          expect(host).toBe('0.0.0.0');
          if (port !== directPort) {
            refused.push(port);
            throw Object.assign(new Error(`listen EACCES ${host}:${port}`), { code: 'EACCES' });
          }
          return { port, release: async () => {} };
        },
      }),
    );
    const url = await d.enable();
    expect(refused).toEqual([a, b]);
    expect(url).toBe(`https://203.0.113.7:${directPort}`);
    expect([...igd.mappings.keys()]).toEqual([directPort]);
    await d.disable();
  });

  it('gives a clear error, and maps nothing, when no port can be opened', async () => {
    let n = 0;
    const d = new DirectMode(deps({ random: () => (n++ % 1000) / 1000, reservePort: async () => Promise.reject(Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })) }));
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
