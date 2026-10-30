import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { canBindPort } from '../../src/core/ports.js';
import { MemoryStateStore } from '../../src/core/state.js';
import { SelfSignedIssuer } from '../../src/direct/certs.js';
import { CGNAT_MESSAGE, DIRECT_PORT_MAX, DIRECT_PORT_MIN, DirectMode, ipChangeMessage, type DirectDeps } from '../../src/direct/direct.js';
import { UpnpGateway, discoverUpnp, parseDeviceDescription } from '../../src/direct/upnp.js';
import { isNonPublicIPv4 } from '../../src/direct/mapper.js';
import { NoTunnel, probeHealth } from '../../src/tunnel/provider.js';
import { allocPorts } from '../../../../scripts/test/lib/ports.mjs';
import { silentLog } from './helpers.js';
import { makeController, startController } from './live-helpers.js';
import { MockIgd } from './mock-igd.js';

// Direct mode (viewers connect to the streamer's public IP instead of the tunnel) against a mock
// UPnP router on 127.0.0.1. Its address in these tests is 203.0.113.7, a documentation range.
//
// "Stop everything" checks that the Direct-mode address no longer answers. 203.0.113.7 never
// does: a real probe would wait out its 5 s timeout, after a DNS-over-HTTPS query to 1.1.1.1. The
// probe answers "gone" at once instead.
vi.mock('../../src/tunnel/provider.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/tunnel/provider.js')>()),
  probeHealth: vi.fn(async () => null),
}));

/** The public IP of these tests. */
const PUBLIC_IP = '203.0.113.7';
/**
 * SSDP discovery collects answers for its whole window. Only the SSDP test pays it: the others
 * find the mock router from its description URL. Long enough for a loaded runner to answer on
 * loopback, which takes a millisecond when idle.
 */
const SSDP_WINDOW_MS = 400;

/** The `random` that makes Direct mode pick exactly `port` (DirectMode.pickPort). */
const randomFor = (port: number) => (): number => (port - DIRECT_PORT_MIN + 0.5) / (DIRECT_PORT_MAX - DIRECT_PORT_MIN + 1);

/**
 * The mock router (until the test finishes) and Direct mode's dependencies around it. Direct mode
 * picks `directPort`, and really listens on it: a port from this worker's block, since a fixed
 * `random` would give every test file the same port (port-range.test.ts listens on 34576 and
 * 28745, which `0.5` gave too). The HTTPS server binds loopback; the real app binds 0.0.0.0.
 */
async function directFixture() {
  const igd = new MockIgd(PUBLIC_IP);
  await igd.start();
  onTestFinished(() => igd.stop());
  const [directPort] = (await allocPorts(1)) as [number];
  /** The mock router, found from its description URL (no SSDP window). */
  const mockGateway = async (): Promise<UpnpGateway | null> => {
    const location = `http://127.0.0.1:${igd.httpPort}/desc.xml`;
    const service = parseDeviceDescription(await (await fetch(location)).text(), location);
    return service ? new UpnpGateway(service, location) : null;
  };
  const deps = (over: Partial<DirectDeps> = {}): DirectDeps => ({
    log: silentLog,
    state: new MemoryStateStore(),
    discoverMapper: mockGateway,
    mapperFromId: (_k, id) => UpnpGateway.fromId(id),
    publicIps: async () => ({ v4: PUBLIC_IP }),
    localAddress: async () => '127.0.0.1',
    localAddresses: () => ['127.0.0.1'],
    issuer: new SelfSignedIssuer(),
    startServer: async (port, _host, sni, defaultCert) => {
      const srv = https.createServer({ SNICallback: sni, key: defaultCert.key, cert: defaultCert.cert }, (_q, r) => r.end('ok'));
      await new Promise<void>((r) => srv.listen(port, '127.0.0.1', () => r()));
      const close = () => new Promise<void>((r) => srv.close(() => r()));
      onTestFinished(close);
      return { close };
    },
    probe: async () => false,
    random: randomFor(directPort),
    ...over,
  });
  return { igd, directPort, deps };
}

describe('direct mode: finding the router', () => {
  it('finds the router by SSDP and talks to it', async () => {
    // Arrange
    const { igd } = await directFixture();
    // Act
    const gw = await discoverUpnp({ address: '127.0.0.1', port: igd.ssdpPort, timeoutMs: SSDP_WINDOW_MS });
    // Assert
    expect(gw?.location).toBe(`http://127.0.0.1:${igd.httpPort}/desc.xml`);
    expect(await gw!.externalIp()).toBe(PUBLIC_IP);
  });
});

describe('direct mode: CGNAT detection', () => {
  it('blocks activation when the router WAN IP differs from the public IP', async () => {
    // Arrange
    const { igd, deps } = await directFixture();
    igd.externalIp = '100.64.12.34';
    const d = new DirectMode(deps());
    // Act
    const check = await d.check();
    const enable = d.enable();
    // Assert
    expect(check.ok).toBe(false);
    expect(check.message).toBe(CGNAT_MESSAGE);
    await expect(enable).rejects.toThrow(/CGNAT/);
    expect(igd.mappings.size).toBe(0);
  });

  it('blocks when the router reports a private WAN address even if equal', async () => {
    // Arrange
    const { igd, deps } = await directFixture();
    igd.externalIp = '10.0.0.2';
    const d = new DirectMode(deps({ publicIps: async () => ({ v4: '10.0.0.2' }) }));
    // Act
    const check = await d.check();
    // Assert
    expect(check.ok).toBe(false);
  });

  it('offers public IPv6 when IPv4 is behind CGNAT', async () => {
    // Arrange
    const { igd, deps } = await directFixture();
    igd.externalIp = '100.64.1.1';
    const d = new DirectMode(deps({ publicIps: async () => ({ v4: PUBLIC_IP, v6: '2001:db8::5' }), localAddresses: () => ['2001:db8::5'] }));
    // Act
    const check = await d.check();
    // Assert
    expect(check.ok).toBe(true);
    expect(check.ok && check.family).toBe(6);
  });

  it('without a router answer, requires an explicit manual port-forward choice', async () => {
    // Arrange
    const { deps } = await directFixture();
    const d = new DirectMode(deps({ discoverMapper: async () => null }));
    // Act
    const check = await d.check();
    const withoutChoice = d.enable();
    // Assert
    expect(check.ok && check.needsManualForward).toBe(true);
    await expect(withoutChoice).rejects.toThrow(/couldn't talk to your router/);
    // Act
    const url = await d.enable({ manualPortForward: true });
    // Assert
    expect(url).toMatch(/^https:\/\/203\.0\.113\.7:\d+$/);
    expect(d.snapshot().mapping).toBe('manual');
    await d.disable();
  });

  it.each(['10.1.2.3', '100.64.0.1', '100.127.255.255', '172.16.0.1', '192.168.1.1', '127.0.0.1'])('%s is a private range', (ip) => {
    // Act
    const nonPublic = isNonPublicIPv4(ip);
    // Assert
    expect(nonPublic).toBe(true);
  });

  it.each(['8.8.8.8', '100.63.0.1', '100.128.0.1', '172.32.0.1'])('%s is public', (ip) => {
    // Act
    const nonPublic = isNonPublicIPv4(ip);
    // Assert
    expect(nonPublic).toBe(false);
  });
});

describe('direct mode: port mapping lifecycle', () => {
  it('opens exactly one random high port, never one of the app ports', async () => {
    // Arrange
    const { igd, deps } = await directFixture();
    const state = new MemoryStateStore();
    const d = new DirectMode(deps({ state }));
    // Act
    const url = await d.enable();
    // Assert
    expect(igd.mappings.size).toBe(1);
    const [port, m] = [...igd.mappings][0]!;
    expect(port).toBeGreaterThanOrEqual(20000);
    expect(port).toBeLessThan(60000);
    expect([1935, 8080, 8081]).not.toContain(port);
    expect(m.internalPort).toBe(port);
    expect(url).toBe(`https://${PUBLIC_IP}:${port}`);
    expect(state.state.activeMapping?.externalPort).toBe(port);
    expect(state.state.lastDirectIp).toBe(PUBLIC_IP);
    expect(d.certificateSource).toBe('self-signed');
  });

  it('removes the mapping on disable, and verifies it', async () => {
    // Arrange
    const { igd, deps } = await directFixture();
    const state = new MemoryStateStore();
    const d = new DirectMode(deps({ state }));
    await d.enable();
    // Act
    const r = await d.disable();
    // Assert
    expect(r.verified).toBe(true);
    expect(igd.mappings.size).toBe(0);
    expect(state.state.activeMapping).toBeNull();
    expect(d.certificateSource).toBeUndefined();
    expect(igd.calls).toContain('DeletePortMapping');
  });

  it('falls back to a permanent lease when the router requires it', async () => {
    // Arrange
    const { igd, deps } = await directFixture();
    igd.onlyPermanentLeases = true;
    const d = new DirectMode(deps());
    // Act
    await d.enable();
    // Assert
    expect([...igd.mappings.values()][0]!.lease).toBe(0);
    // Act
    await d.disable();
    // Assert
    expect(igd.mappings.size).toBe(0);
  });

  it('reports a failed verification when the port still answers from outside', async () => {
    // Arrange
    const { deps } = await directFixture();
    const d = new DirectMode(deps({ probe: async () => true }));
    await d.enable();
    // Act
    const r = await d.disable();
    // Assert
    expect(r.verified).toBe(false);
    expect(r.details.join()).toMatch(/still answers/);
  });

  it('cleans up a mapping left by a crash using the saved identifier', async () => {
    // Arrange
    const { igd, deps } = await directFixture();
    const state = new MemoryStateStore();
    await new DirectMode(deps({ state })).enable();
    const next = new DirectMode(deps({ state }));
    // Act
    await next.init();
    // Assert
    expect(igd.mappings.size).toBe(1);
    expect(next.staleMapping).toBe(true);
    // Act
    const cleaned = await next.cleanupStale();
    // Assert
    expect(cleaned).toBe(true);
    expect(igd.mappings.size).toBe(0);
    expect(next.snapshot().staleMappingWarning).toBe(false);
  });
});

describe('direct mode: IP change message', () => {
  it.each([
    ['changed since the last direct mode', '198.51.100.1', true, 'Your IP changed since you last used direct mode ✓'],
    ['the same', PUBLIC_IP, false, expect.stringMatching(/still the same/)],
  ])('says whether the IP %s', async (_what, lastDirectIp, changed, message) => {
    // Arrange
    const { deps } = await directFixture();
    const d = new DirectMode(deps({ state: new MemoryStateStore({ lastDirectIp }) }));
    // Act
    await d.init();
    // Assert
    expect(d.ipChanged).toBe(changed);
    expect(ipChangeMessage(d.ipChanged)).toEqual(message);
  });

  it('says nothing before the first direct mode', async () => {
    // Arrange
    const { deps } = await directFixture();
    const d = new DirectMode(deps());
    // Act
    await d.init();
    // Assert
    expect(ipChangeMessage(d.ipChanged)).toBeNull();
  });
});

describe('direct mode never turns itself on', () => {
  it('check() does not open ports', async () => {
    // Arrange
    const { igd, deps } = await directFixture();
    const d = new DirectMode(deps());
    // Act
    await d.check();
    await d.check();
    // Assert
    expect(igd.calls).not.toContain('AddPortMapping');
    expect(d.active).toBe(false);
  });

  it('the controller only suggests it when the tunnel struggles', async () => {
    // Arrange
    const { deps } = await directFixture();
    const enable = vi.spyOn(DirectMode.prototype, 'enable');
    onTestFinished(() => enable.mockRestore());
    const tunnel = new NoTunnel();
    const { live } = makeController(new DirectMode(deps()), { tunnel });
    live.access.begin();
    // Act
    for (let i = 0; i < 3; i++) tunnel.emit('down', 'connection lost');
    const snap = live.snapshot();
    // Assert
    expect(snap.direct.suggestion).toMatch(/Direct mode/);
    expect(snap.mode).toBe('secure');
    expect(enable).not.toHaveBeenCalled();
  });
});

describe('controller: switching modes', () => {
  it('direct mode gives a new link and drops old sessions; returning gives another link and closes the port', async () => {
    // Arrange
    const { igd, deps } = await directFixture();
    const { live } = await startController(new DirectMode(deps()));
    const oldLink = live.liveLink!;
    const s = live.access.createSession({ nickname: 'a', deviceId: 'd', device: 'desktop', ip: 'ip' });
    // Act
    const link = await live.enableDirect({});
    // Assert
    expect(link).toMatch(/^https:\/\/203\.0\.113\.7:\d+\/join\//);
    expect(link).not.toBe(oldLink);
    expect(live.mode).toBe('direct');
    expect(live.access.sessions.has(s.id)).toBe(false);
    expect(igd.mappings.size).toBe(1);
    // Act
    const back = await live.disableDirect();
    // Assert
    expect(live.mode).toBe('secure');
    expect(back).not.toBe(link);
    expect(igd.mappings.size).toBe(0);
  });

  it('"Stop everything" removes the mapping too, and checks the address is gone', async () => {
    // Arrange
    const { igd, deps } = await directFixture();
    const { live } = await startController(new DirectMode(deps()));
    await live.enableDirect({});
    // Act
    const verified = await live.stop();
    // Assert
    expect(verified).toBe(true);
    expect(igd.mappings.size).toBe(0);
    expect(live.phase).toBe('off');
    expect(live.steps.find((x) => x.id === 'tunnel')?.status).toBe('ok');
    expect(live.steps.find((x) => x.id === 'verify')?.status).toBe('ok');
    expect(vi.mocked(probeHealth)).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/203\.0\.113\.7:\d+$/));
  });
});

describe('direct mode TLS without SNI (browsers never send SNI for an IP address)', () => {
  // An IP host: Node, like browsers, sends no SNI. The certificate is verified, pinned to the one
  // issued here (it names 127.0.0.1).
  it('the app server answers https://<IP>:<port> using the default certificate', async () => {
    // Arrange
    const { deps } = await directFixture();
    const { live } = makeController(new DirectMode(deps()));
    const cert = await new SelfSignedIssuer().issue('127.0.0.1');
    const ctx = tls.createSecureContext({ key: cert.keyPem, cert: cert.certPem });
    const [port] = (await allocPorts(1)) as [number];
    const handle = await live.startDirectServer(port, '127.0.0.1', (_n, cb) => cb(null, ctx), { key: cert.keyPem, cert: cert.certPem });
    onTestFinished(() => handle.close());
    // Act
    const body = await new Promise<string>((resolve, reject) => {
      https
        .get({ host: '127.0.0.1', port, path: '/healthz', ca: cert.certPem }, (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve(`${res.statusCode} ${b}`));
        })
        .on('error', reject);
    });
    // Assert
    expect(body).toMatch(/^200 /);
  });
});

describe('direct mode: a port the computer can really open', () => {
  // Windows reserves whole ranges of high ports (Hyper-V/WinNAT); listening there fails with
  // EACCES. Such ports (and ports in use) are skipped before anything is mapped on the router.
  it('skips ports that cannot be bound and maps the first one that can', async () => {
    // Arrange
    const { igd, directPort, deps } = await directFixture();
    const [a, b] = (await allocPorts(2)) as [number, number];
    const seq = [a, b, directPort].map((p) => randomFor(p)());
    let i = 0;
    const refused: number[] = [];
    const hosts: string[] = [];
    const d = new DirectMode(
      deps({
        random: () => seq[Math.min(i++, seq.length - 1)]!,
        reservePort: async (port, host) => {
          hosts.push(host);
          if (port !== directPort) {
            refused.push(port);
            throw Object.assign(new Error(`listen EACCES ${host}:${port}`), { code: 'EACCES' });
          }
          return { port, release: async () => {} };
        },
      }),
    );
    // Act
    const url = await d.enable();
    // Assert
    expect(refused).toEqual([a, b]);
    expect(hosts.every((h) => h === '0.0.0.0')).toBe(true);
    expect(url).toBe(`https://${PUBLIC_IP}:${directPort}`);
    expect([...igd.mappings.keys()]).toEqual([directPort]);
    await d.disable();
  });

  it('gives a clear error, and maps nothing, when no port can be opened', async () => {
    // Arrange
    const { igd, deps } = await directFixture();
    let n = 0;
    const d = new DirectMode(deps({ random: () => (n++ % 1000) / 1000, reservePort: async () => Promise.reject(Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })) }));
    // Act
    const enable = d.enable();
    // Assert
    await expect(enable).rejects.toMatchObject({ code: 'err.directNoPort' });
    expect(igd.mappings.size).toBe(0);
    expect(d.active).toBe(false);
  });

  it('canBindPort is false for a port another server holds, true once it let go', async () => {
    // Arrange
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, '0.0.0.0', () => r()));
    const port = (srv.address() as net.AddressInfo).port;
    // Act
    const held = await canBindPort(port, '0.0.0.0');
    await new Promise<void>((r) => srv.close(() => r()));
    const released = await canBindPort(port, '0.0.0.0');
    // Assert
    expect(held).toBe(false);
    expect(released).toBe(true);
  });
});
