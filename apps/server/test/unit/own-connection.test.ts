import { Writable } from 'node:stream';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { EgressSet, EgressWatch, isLocalAddress, sameConnection } from '../../src/access/own-connection.js';
import type { PublicIps } from '../../src/direct/publicip.js';
import { clientIp } from '../../src/public/security.js';
import { silentLog } from './helpers.js';

const EGRESS: PublicIps = { v4: '203.0.113.7', v6: '2001:db8:aa:bb::1' };

describe('same connection as the server', () => {
  it('IPv4: the same address only', () => {
    expect(sameConnection('203.0.113.7', EGRESS)).toBe(true);
    expect(sameConnection('203.0.113.8', EGRESS)).toBe(false);
    expect(sameConnection('198.51.100.20', EGRESS)).toBe(false);
    expect(sameConnection('203.0.113.7', { v6: EGRESS.v6 })).toBe(false);
  });

  it('IPv6: any address in the same /64, written in any form', () => {
    expect(sameConnection('2001:db8:aa:bb:1234:5678:9abc:def0', EGRESS)).toBe(true);
    expect(sameConnection('2001:0DB8:00AA:00BB:0000:0000:0000:0042', EGRESS)).toBe(true);
    expect(sameConnection('2001:db8:aa:bb::1%en0', EGRESS)).toBe(true);
    // Same /48 or /56 but another /64: another network.
    expect(sameConnection('2001:db8:aa:bc::1', EGRESS)).toBe(false);
    expect(sameConnection('2001:db8:aa:1bb::1', EGRESS)).toBe(false);
    expect(sameConnection('2001:db8:aa:bb::1', { v4: EGRESS.v4 })).toBe(false);
  });

  it('IPv4-mapped IPv6 is the IPv4 address (dotted or hex, on either side)', () => {
    expect(sameConnection('::ffff:203.0.113.7', EGRESS)).toBe(true);
    expect(sameConnection('::FFFF:cb00:7107', EGRESS)).toBe(true);
    expect(sameConnection('203.0.113.7', { v4: '::ffff:203.0.113.7' })).toBe(true);
    expect(sameConnection('::ffff:203.0.113.8', EGRESS)).toBe(false);
    // Mapped forms do not make an IPv4 address match an IPv6 /64.
    expect(sameConnection('::ffff:203.0.113.7', { v6: '::ffff:0:0' })).toBe(false);
  });

  it('nothing matches without an address, and junk is never "the same"', () => {
    expect(sameConnection(undefined, EGRESS)).toBe(false);
    expect(sameConnection('', EGRESS)).toBe(false);
    expect(sameConnection('not-an-ip', EGRESS)).toBe(false);
    expect(sameConnection('203.0.113.7', {})).toBe(false);
    const set = new EgressSet();
    expect(set.add('junk')).toBe(false);
    expect(set.add('203.0.113.7')).toBe(true);
    expect(set.add('::ffff:203.0.113.7')).toBe(false);
    expect(set.add('2001:db8:aa:bb::1')).toBe(true);
    expect(set.add('2001:db8:aa:bb::2')).toBe(false);
    expect(set.size).toBe(2);
  });

  it('a missing CF-Connecting-IP leaves a loopback address, which counts as this machine', () => {
    const req = (remoteAddress: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress }, headers });
    // Through the quick tunnel every request carries the header; one without it did not come
    // through Cloudflare (something on this machine), so it is treated as the streamer's own.
    expect(isLocalAddress(clientIp(req('127.0.0.1'), true))).toBe(true);
    expect(isLocalAddress(clientIp(req('::1'), true))).toBe(true);
    expect(isLocalAddress(clientIp(req('::ffff:127.0.0.1', { 'cf-connecting-ip': 'garbage' }), true))).toBe(true);
    expect(isLocalAddress(clientIp(req('127.0.0.1', { 'cf-connecting-ip': '198.51.100.20' }), true))).toBe(false);
    expect(isLocalAddress(undefined)).toBe(true);
    for (const ip of ['10.0.0.5', '192.168.1.20', '172.16.4.4', '169.254.1.1', 'fe80::1', 'fd12:3456::1', '0.0.0.0', '::']) expect(isLocalAddress(ip), ip).toBe(true);
    for (const ip of ['198.51.100.20', '2804:1b3:61c1:c649::5', '172.32.0.1', '::ffff:198.51.100.20']) expect(isLocalAddress(ip), ip).toBe(false);
  });
});

describe('own public address watch', () => {
  const watches: EgressWatch[] = [];
  afterEach(() => {
    for (const w of watches.splice(0)) w.stop();
  });

  function setup(results: Array<PublicIps | Error>, o: { interfaces?: () => string; log?: pino.Logger } = {}) {
    let now = 1_000_000;
    let calls = 0;
    const w = new EgressWatch({
      lookup: async () => {
        const r = results[Math.min(calls++, results.length - 1)]!;
        if (r instanceof Error) throw r;
        return r;
      },
      log: o.log ?? silentLog,
      interfaces: o.interfaces ?? (() => 'eth0'),
      now: () => now,
      // Ticks only when the test calls tick().
      tickMs: 3_600_000,
      refreshMs: 600_000,
      staleMs: 120_000,
    });
    watches.push(w);
    let changes = 0;
    w.on('changed', () => (changes += 1));
    return {
      w,
      advance: (ms: number) => (now += ms),
      calls: () => calls,
      changes: () => changes,
      settle: () => w.idle(),
    };
  }

  it('is unknown until the first lookup, then tells the server\'s connection from others', async () => {
    const t = setup([EGRESS]);
    expect(t.w.status).toBe('unknown');
    expect(t.w.classify('198.51.100.20')).toBe('unknown');
    t.w.start();
    await t.settle();
    expect(t.w.status).toBe('known');
    expect(t.changes()).toBe(1);
    expect(t.w.classify('203.0.113.7')).toBe('own');
    expect(t.w.classify('::ffff:203.0.113.7')).toBe('own');
    expect(t.w.classify('2001:db8:aa:bb:dead:beef::1')).toBe('own');
    expect(t.w.classify('198.51.100.20')).toBe('other');
    expect(t.w.classify('2001:db8:aa:cc::1')).toBe('other');
    // This machine, or a request without CF-Connecting-IP.
    expect(t.w.classify('127.0.0.1')).toBe('own');
  });

  it('a failed lookup leaves the status unknown (conservative) and is retried on the next tick', async () => {
    const t = setup([new Error('offline'), {}, EGRESS]);
    t.w.start();
    await t.settle();
    expect(t.w.status).toBe('unknown');
    expect(t.w.failing).toBe(true);
    expect(t.w.classify('198.51.100.20')).toBe('unknown');
    t.w.tick();
    await t.settle();
    // An answer with no address at all is a failure too.
    expect(t.w.status).toBe('unknown');
    t.w.tick();
    await t.settle();
    expect(t.w.status).toBe('known');
    expect(t.w.failing).toBe(false);
    expect(t.calls()).toBe(3);
  });

  it('keeps every address seen during the live, refreshes after a while and at once on a network change', async () => {
    let iface = 'wifi-a';
    const t = setup([{ v4: '203.0.113.7' }, { v4: '203.0.113.99' }, { v4: '192.0.2.50' }, new Error('down')], { interfaces: () => iface });
    t.w.start();
    await t.settle();
    t.w.tick();
    await t.settle();
    expect(t.calls()).toBe(1); // nothing due yet
    t.advance(600_000);
    t.w.tick();
    await t.settle();
    expect(t.calls()).toBe(2);
    // The provider gave a new address; the old one is still the streamer's.
    expect(t.w.classify('203.0.113.7')).toBe('own');
    expect(t.w.classify('203.0.113.99')).toBe('own');
    iface = 'wifi-b';
    t.w.tick();
    await t.settle();
    expect(t.calls()).toBe(3);
    expect(t.w.classify('192.0.2.50')).toBe('own');
    // Another network change, and the lookups now fail: the old answers count for a while,
    // then the status turns unknown until a lookup works again.
    iface = 'mobile';
    t.w.tick();
    await t.settle();
    expect(t.w.status).toBe('known');
    t.advance(121_000);
    t.w.tick();
    await t.settle();
    expect(t.w.status).toBe('unknown');
    expect(t.w.classify('198.51.100.20')).toBe('unknown');
    expect(t.w.classify('192.0.2.50')).toBe('own');
  });

  it('logs at info level, never the addresses', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const log = pino({ level: 'debug' }, sink);
    let iface = 'a';
    const t = setup([new Error('offline'), EGRESS], { log, interfaces: () => iface });
    t.w.start();
    await t.settle();
    t.w.tick();
    await t.settle();
    iface = 'b';
    t.w.tick();
    await t.settle();
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const l of lines) {
      expect(JSON.parse(l).level).toBe(30);
      expect(l).not.toMatch(/203\.0\.113|2001:db8/);
    }
  });

  it('stop forgets everything (the next live looks again)', async () => {
    const t = setup([EGRESS]);
    t.w.start();
    await t.settle();
    t.w.stop();
    expect(t.w.active).toBe(false);
    expect(t.w.status).toBe('unknown');
    expect(t.w.classify('203.0.113.7')).toBe('unknown');
  });
});
