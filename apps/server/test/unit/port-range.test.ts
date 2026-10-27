import https from 'node:https';
import net from 'node:net';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reservePort } from '../../src/core/ports.js';
import { MemoryStateStore } from '../../src/core/state.js';
import { SelfSignedIssuer } from '../../src/direct/certs.js';
import { DIRECT_PORT_MAX, DIRECT_PORT_MIN, DirectMode, type DirectDeps } from '../../src/direct/direct.js';
import { UpnpGateway, discoverUpnp } from '../../src/direct/upnp.js';
import { MockIgd } from './mock-igd.js';

// B6: Direct mode's port stays below Windows' dynamic range (49152–65535, where Hyper-V, WSL and
// Docker reserve blocks), and a port the OS refuses at listen time is retried with another one
// before anything is mapped on the router.

let igd: MockIgd;
const closers: Array<() => Promise<void>> = [];
beforeEach(async () => {
  igd = new MockIgd('203.0.113.7');
  await igd.start();
});
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  await igd.stop();
});

function capture(): { log: pino.Logger; lines: () => Array<Record<string, unknown>> } {
  const out: string[] = [];
  const log = pino({ level: 'debug' }, { write: (l: string) => void out.push(l) });
  return { log, lines: () => out.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

function deps(over: Partial<DirectDeps> = {}): DirectDeps {
  return {
    log: pino({ level: 'silent' }),
    state: new MemoryStateStore(),
    discoverMapper: () => discoverUpnp({ address: '127.0.0.1', port: igd.ssdpPort, timeoutMs: 400 }),
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
      closers.push(h.close);
      return h;
    },
    probe: async () => false,
    excludedPortRanges: async () => 'Start Port    End Port\n----------    --------\n     49709       49808',
    ...over,
  };
}

const listenError = (code: string, port: number): Error => Object.assign(new Error(`listen ${code}: 0.0.0.0:${port}`), { code });

describe('Direct mode port range', () => {
  it('stays within 20000–49151, both ends included', () => {
    expect([DIRECT_PORT_MIN, DIRECT_PORT_MAX]).toEqual([20000, 49151]);
    const at = (r: number): number => new DirectMode(deps({ random: () => r })).pickPort();
    expect(at(0)).toBe(20000);
    expect(at(0.999999999)).toBe(49151);
    // Even a random source returning 1 (out of contract) cannot reach the dynamic range.
    expect(at(1)).toBe(49151);
    const d = new DirectMode(deps());
    for (let i = 0; i < 20_000; i++) {
      const p = d.pickPort();
      expect(p).toBeGreaterThanOrEqual(20000);
      expect(p).toBeLessThan(49152);
    }
  });
});

describe('Direct mode: a real listen, retried on EACCES/EADDRINUSE before the router mapping', () => {
  it('retries after an injected EACCES on the first listen, logs it as "reserved by Windows" with the excluded ranges, then maps the port it holds', async () => {
    const { log, lines } = capture();
    const seq = [0.1, 0.5];
    let i = 0;
    const calls: number[] = [];
    let mappedWhileHeld: number[] | null = null;
    const d = new DirectMode(
      deps({
        log,
        random: () => seq[Math.min(i++, seq.length - 1)]!,
        reservePort: async (port, host) => {
          calls.push(port);
          // Nothing may be mapped on the router before a listen succeeded.
          expect(igd.mappings.size).toBe(0);
          if (calls.length === 1) throw listenError('EACCES', port);
          const r = await reservePort(port, host === '0.0.0.0' ? '127.0.0.1' : host);
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
    const url = await d.enable();
    const [first, second] = calls;
    expect(calls).toHaveLength(2);
    expect(first).toBe(22915);
    expect(second).toBe(34576);
    expect(url).toBe(`https://203.0.113.7:${second}`);
    // The router mapping was created while the port was still held, then the server took it over.
    expect(mappedWhileHeld).toEqual([second]);
    expect([...igd.mappings.keys()]).toEqual([second]);
    await expect.poll(() => lines().map((l) => l.msg)).toContain('direct mode: ports Windows keeps for itself');
    const reserved = lines().find((l) => String(l.msg).includes('reserved by Windows'));
    expect(reserved?.ports).toEqual([first]);
    expect(lines().find((l) => l.msg === 'direct mode: ports Windows keeps for itself')?.excludedPortRanges).toContain('49709');
    expect(lines().some((l) => String(l.msg).includes('used by another program'))).toBe(false);
    await d.disable();
  });

  it('tells "used by another program" (EADDRINUSE) apart from "reserved by Windows" (EACCES)', async () => {
    const { log, lines } = capture();
    const holder = net.createServer();
    await new Promise<void>((r) => holder.listen(0, '127.0.0.1', () => r()));
    closers.push(() => new Promise<void>((r) => holder.close(() => r())));
    const busy = (holder.address() as net.AddressInfo).port;
    // A real EADDRINUSE from a real listen on a port this test holds.
    await expect(reservePort(busy, '127.0.0.1')).rejects.toMatchObject({ code: 'EADDRINUSE' });
    let n = 0;
    const d = new DirectMode(
      deps({
        log,
        random: () => [0.2, 0.3, 0.4][n++]!,
        reservePort: async (port) => {
          if (n === 1) throw listenError('EADDRINUSE', port);
          if (n === 2) throw listenError('EACCES', port);
          return { port, release: async () => {} };
        },
      }),
    );
    await d.enable();
    expect(lines().find((l) => String(l.msg).includes('used by another program'))?.ports).toEqual([25830]);
    expect(lines().find((l) => String(l.msg).includes('reserved by Windows'))?.ports).toEqual([28745]);
    await d.disable();
  });

  it('gives up with the translated error after 25 refused ports, and maps nothing', async () => {
    let n = 0;
    const tried = new Set<number>();
    const d = new DirectMode(
      deps({
        random: () => (n++ % 1000) / 1000,
        reservePort: async (port) => {
          tried.add(port);
          throw listenError('EACCES', port);
        },
      }),
    );
    await expect(d.enable()).rejects.toMatchObject({ code: 'err.directNoPort' });
    expect(tried.size).toBe(25);
    expect(igd.mappings.size).toBe(0);
    expect(d.active).toBe(false);
  });

  it('a lost race between the release and the server listen is reported plainly and cleaned up', async () => {
    const d = new DirectMode(
      deps({
        reservePort: async (port) => ({ port, release: async () => {} }),
        startServer: async (port) => Promise.reject(listenError('EADDRINUSE', port)),
      }),
    );
    await expect(d.enable()).rejects.toMatchObject({ code: 'err.directNoPort' });
    expect(igd.mappings.size).toBe(0);
    expect(d.active).toBe(false);
  });

  it('reservePort really holds the port until released', async () => {
    const probe = net.createServer();
    await new Promise<void>((res) => probe.listen(0, '127.0.0.1', () => res()));
    const free = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((res) => probe.close(() => res()));
    const held = await reservePort(free, '127.0.0.1');
    expect(held.port).toBe(free);
    await expect(reservePort(free, '127.0.0.1')).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await held.release();
    await held.release(); // idempotent
    const again = await reservePort(free, '127.0.0.1');
    await again.release();
  });
});
