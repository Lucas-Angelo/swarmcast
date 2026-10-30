import https from 'node:https';
import net from 'node:net';
import { describe, expect, it, onTestFinished } from 'vitest';
import { reservePort, type PortReservation } from '../../src/core/ports.js';
import { MemoryStateStore } from '../../src/core/state.js';
import { SelfSignedIssuer } from '../../src/direct/certs.js';
import { DIRECT_PORT_MAX, DIRECT_PORT_MIN, DirectMode, type DirectDeps } from '../../src/direct/direct.js';
import { UpnpGateway } from '../../src/direct/upnp.js';
import { allocPorts } from '../../../../scripts/test/lib/ports.mjs';
import { captureLog, silentLog } from './helpers.js';
import { mockRouter } from './helpers-b.js';
import type { MockIgd } from './mock-igd.js';

// B6: Direct mode's port stays below Windows' dynamic range (49152–65535, where Hyper-V, WSL and
// Docker reserve blocks), and a port the OS refuses at listen time is retried with another one
// before anything is mapped on the router: nothing may be mapped before a listen succeeded, and the
// mapping is made while the port is still held, then the server takes it over. Ports Direct mode
// really listens on come from this worker's block (allocPorts): a fixed `random` would give the same
// port in every run and every file, so a test running next to this one (or another copy of the
// suite) could hold it. Everything listens on 127.0.0.1 (the app binds all interfaces; a test must
// not, nor trigger a firewall prompt).

/** The `random` value that makes pickPort() return `port`. */
const randomFor = (port: number): number => (port - DIRECT_PORT_MIN + 0.5) / (DIRECT_PORT_MAX - DIRECT_PORT_MIN + 1);

/** What `netsh int ipv4 show excludedportrange protocol=tcp` prints on a Windows with Hyper-V. */
const EXCLUDED_RANGES = 'Start Port    End Port\n----------    --------\n     49709       49808';

const listenError = (code: string, port: number): Error => Object.assign(new Error(`listen ${code}: 0.0.0.0:${port}`), { code });

/** A real exclusive listen on 127.0.0.1 instead of the wildcard address the app uses. */
const reserveOnLoopback = (port: number, host: string): Promise<PortReservation> => reservePort(port, host === '0.0.0.0' ? '127.0.0.1' : host);

/**
 * Direct mode's dependencies around the mock router `igd` (none: no router found); HTTPS servers it
 * starts are closed when the test finishes. `random` must be given: a port Direct mode really
 * listens on comes from allocPorts.
 */
function deps(igd: MockIgd | null, over: Partial<DirectDeps> = {}): DirectDeps {
  return {
    log: silentLog,
    state: new MemoryStateStore(),
    discoverMapper: async () => (igd ? igd.gateway() : null),
    mapperFromId: (_k, id) => UpnpGateway.fromId(id),
    publicIps: async () => ({ v4: '203.0.113.7' }),
    localAddress: async () => '127.0.0.1',
    localAddresses: () => ['127.0.0.1'],
    issuer: new SelfSignedIssuer(),
    startServer: async (port, _host, sni, defaultCert) => {
      const srv = https.createServer({ SNICallback: sni, key: defaultCert.key, cert: defaultCert.cert }, (_q, r) => r.end('ok'));
      await new Promise<void>((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(port, '127.0.0.1', () => resolve());
      });
      const h = { close: () => new Promise<void>((r) => srv.close(() => r())) };
      onTestFinished(h.close);
      return h;
    },
    probe: async () => false,
    random: () => {
      throw new Error('this test gives Direct mode no random source: pick its port from allocPorts');
    },
    excludedPortRanges: async () => EXCLUDED_RANGES,
    ...over,
  };
}

/** A `random` that returns the values for `ports` in turn (then the last one again). */
function pickInTurn(ports: number[]): () => number {
  let i = 0;
  return () => randomFor(ports[Math.min(i++, ports.length - 1)]!);
}

describe('Direct mode port range', () => {
  it('is 20000–49151, below the dynamic range', () => {
    // Assert
    expect([DIRECT_PORT_MIN, DIRECT_PORT_MAX]).toEqual([20000, 49151]);
  });

  it.each([
    ['the lowest random value', 0, 20000],
    ['the highest random value', 0.999999999, 49151],
    ['a random source returning 1 (out of contract)', 1, 49151],
  ])('picks both ends included: %s (%d) gives %i', (_what, r, port) => {
    // Arrange
    const d = new DirectMode(deps(null, { random: () => r }));
    // Act
    const picked = d.pickPort();
    // Assert
    expect(picked).toBe(port);
  });

  it('never picks a port in the dynamic range', () => {
    // Arrange
    const d = new DirectMode(deps(null, { random: Math.random }));
    // Act
    const picked = Array.from({ length: 20_000 }, () => d.pickPort());
    // Assert
    expect(Math.min(...picked)).toBeGreaterThanOrEqual(20000);
    expect(Math.max(...picked)).toBeLessThan(49152);
  });
});

describe('Direct mode: a real listen, retried on EACCES/EADDRINUSE before the router mapping', () => {
  /** Direct mode whose first listen fails with EACCES (an excluded range) and whose second one really listens; `log` keeps its lines. */
  async function refusedOnceThenListens() {
    const igd = await mockRouter();
    const { log, lines } = captureLog();
    const [refusedPort, freePort] = (await allocPorts(2)) as [number, number];
    const tried: number[] = [];
    const mappedAtListen: number[] = [];
    let mappedWhileHeld: number[] | null = null;
    const d = new DirectMode(
      deps(igd, {
        log,
        random: pickInTurn([refusedPort, freePort]),
        reservePort: async (port, host) => {
          tried.push(port);
          mappedAtListen.push(igd.mappings.size);
          if (tried.length === 1) throw listenError('EACCES', port);
          const r = await reserveOnLoopback(port, host);
          return {
            port,
            release: async () => {
              mappedWhileHeld ??= [...igd.mappings.keys()];
              await r.release();
            },
          };
        },
      }),
    );
    onTestFinished(async () => void (await d.disable()));
    return { igd, d, lines, refusedPort, freePort, tried, mappedAtListen, mappedWhileHeld: () => mappedWhileHeld };
  }

  it('retries after an EACCES on the first listen, and maps the port it holds', async () => {
    // Arrange
    const t = await refusedOnceThenListens();
    // Act
    const url = await t.d.enable();
    // Assert
    expect(t.tried).toEqual([t.refusedPort, t.freePort]);
    expect(t.mappedAtListen).toEqual([0, 0]);
    expect(url).toBe(`https://203.0.113.7:${t.freePort}`);
    expect(t.mappedWhileHeld()).toEqual([t.freePort]);
    expect([...t.igd.mappings.keys()]).toEqual([t.freePort]);
  });

  it('logs the refused port as "reserved by Windows", with the excluded ranges', async () => {
    // Arrange
    const t = await refusedOnceThenListens();
    // Act
    await t.d.enable();
    // Assert
    await expect.poll(() => t.lines().map((l) => l.msg)).toContain('direct mode: ports Windows keeps for itself');
    expect(t.lines().find((l) => String(l.msg).includes('reserved by Windows'))?.ports).toEqual([t.refusedPort]);
    expect(t.lines().find((l) => l.msg === 'direct mode: ports Windows keeps for itself')?.excludedPortRanges).toContain('49709');
    expect(t.lines().some((l) => String(l.msg).includes('used by another program'))).toBe(false);
  });

  it('a real listen on a port another program holds fails with EADDRINUSE', async () => {
    // Arrange
    const holder = net.createServer();
    await new Promise<void>((r) => holder.listen(0, '127.0.0.1', () => r()));
    onTestFinished(() => new Promise<void>((r) => holder.close(() => r())));
    const busy = (holder.address() as net.AddressInfo).port;
    // Act
    const reserving = reservePort(busy, '127.0.0.1');
    // Assert
    await expect(reserving).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });

  it('tells "used by another program" (EADDRINUSE) apart from "reserved by Windows" (EACCES)', async () => {
    // Arrange
    const igd = await mockRouter();
    const { log, lines } = captureLog();
    const [inUse, refused, listened] = (await allocPorts(3)) as [number, number, number];
    const errors = [listenError('EADDRINUSE', inUse), listenError('EACCES', refused)];
    const d = new DirectMode(
      deps(igd, {
        log,
        random: pickInTurn([inUse, refused, listened]),
        reservePort: async (port) => {
          const err = errors.shift();
          if (err) throw err;
          return { port, release: async () => {} };
        },
      }),
    );
    onTestFinished(async () => void (await d.disable()));
    // Act
    await d.enable();
    // Assert
    expect(lines().find((l) => String(l.msg).includes('used by another program'))?.ports).toEqual([inUse]);
    expect(lines().find((l) => String(l.msg).includes('reserved by Windows'))?.ports).toEqual([refused]);
  });

  it('gives up with the translated error after 25 refused ports, and maps nothing', async () => {
    // Arrange
    const igd = await mockRouter();
    let n = 0;
    const tried = new Set<number>();
    const d = new DirectMode(
      deps(igd, {
        random: () => (n++ % 1000) / 1000,
        reservePort: async (port) => {
          tried.add(port);
          throw listenError('EACCES', port);
        },
      }),
    );
    // Act
    const enabling = d.enable();
    // Assert
    await expect(enabling).rejects.toMatchObject({ code: 'err.directNoPort' });
    expect(tried.size).toBe(25);
    expect(igd.mappings.size).toBe(0);
    expect(d.active).toBe(false);
  });

  it('a lost race between the release and the server listen is reported plainly and cleaned up', async () => {
    // Arrange
    const igd = await mockRouter();
    const [port] = (await allocPorts(1)) as [number];
    const d = new DirectMode(
      deps(igd, {
        random: () => randomFor(port),
        reservePort: async (p) => ({ port: p, release: async () => {} }),
        startServer: async (p) => Promise.reject(listenError('EADDRINUSE', p)),
      }),
    );
    // Act
    const enabling = d.enable();
    // Assert
    await expect(enabling).rejects.toMatchObject({ code: 'err.directNoPort' });
    expect(igd.mappings.size).toBe(0);
    expect(d.active).toBe(false);
  });

  it('reservePort really holds the port: another listen on it fails', async () => {
    // Arrange
    const [free] = (await allocPorts(1)) as [number];
    const held = await reservePort(free, '127.0.0.1');
    onTestFinished(() => held.release());
    // Act
    const second = reservePort(free, '127.0.0.1');
    // Assert
    expect(held.port).toBe(free);
    await expect(second).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });

  it('reservePort gives the port back on release (twice is harmless)', async () => {
    // Arrange
    const [free] = (await allocPorts(1)) as [number];
    const held = await reservePort(free, '127.0.0.1');
    // Act
    await held.release();
    await held.release();
    const again = await reservePort(free, '127.0.0.1');
    onTestFinished(() => again.release());
    // Assert
    expect(again.port).toBe(free);
  });
});
