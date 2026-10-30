import type pino from 'pino';
import { describe, expect, it, onTestFinished } from 'vitest';
import { EgressSet, EgressWatch, isLocalAddress, sameConnection } from '../../src/access/own-connection.js';
import type { PublicIps } from '../../src/direct/publicip.js';
import { clientIp } from '../../src/public/security.js';
import { captureLog, manualClock, silentLog } from './helpers.js';
import { requestFrom } from './helpers-b.js';

// "Is this viewer on the streamer's own internet connection?" P2P stays off for such sessions:
// their browser would offer the server's own public address to every other peer. The same
// connection is the same public IPv4 (also written as ::ffff:a.b.c.d) or an IPv6 in the same /64
// (another /64 of the same /48 or /56 is another network). Through the quick tunnel every request
// carries CF-Connecting-IP; one without it did not come through Cloudflare (something on this
// machine) and counts as the streamer's own, like private and link-local addresses.
//
// The watch looks the server's addresses up when the live starts, again after a while (the
// provider may hand out a new one: the old one is still hers) and at once when this machine's
// network changes. While no lookup has worked (or a network change is older than the stale time
// and lookups fail), the status is unknown: conservative, nobody can be told apart then. Its logs
// are at info level and never carry an address.

const EGRESS: PublicIps = { v4: '203.0.113.7', v6: '2001:db8:aa:bb::1' };
/** A client on another connection than the server's. */
const OTHER = '198.51.100.20';

/** A successful lookup is repeated this often (here). */
const REFRESH_MS = 600_000;
/** After a network change, the old answer counts this long before it is "unknown" (here). */
const STALE_MS = 120_000;
/** No automatic ticks: an hour between them, so only the test's tick() calls run. */
const MANUAL_TICKS_MS = 3_600_000;

/**
 * A watch whose lookups answer `results` in turn (the last one again and again), on a clock that
 * moves only by `advance`. `changes()` counts its 'changed' events, `calls()` its lookups, and
 * `settle()` resolves once no lookup is running. Stopped when the test finishes.
 */
function watch(results: Array<PublicIps | Error>, o: { interfaces?: () => string; log?: pino.Logger } = {}) {
  const clock = manualClock();
  let calls = 0;
  const w = new EgressWatch({
    lookup: async () => {
      const r = results[Math.min(calls++, results.length - 1)]!;
      if (r instanceof Error) throw r;
      return r;
    },
    log: o.log ?? silentLog,
    interfaces: o.interfaces ?? (() => 'eth0'),
    now: clock.now,
    tickMs: MANUAL_TICKS_MS,
    refreshMs: REFRESH_MS,
    staleMs: STALE_MS,
  });
  onTestFinished(() => w.stop());
  let changes = 0;
  w.on('changed', () => (changes += 1));
  return {
    w,
    advance: clock.advance,
    calls: () => calls,
    changes: () => changes,
    settle: () => w.idle(),
    /** One periodic step, and its lookup (if any) done. */
    tick: async () => {
      w.tick();
      await w.idle();
    },
  };
}

describe('same connection as the server', () => {
  it.each([
    ['the same IPv4 address', '203.0.113.7', EGRESS, true],
    ['the next IPv4 address', '203.0.113.8', EGRESS, false],
    ['another IPv4 network', OTHER, EGRESS, false],
    ['an IPv4 client when only the IPv6 address is known', '203.0.113.7', { v6: EGRESS.v6 }, false],
    ['an IPv6 address in the same /64', '2001:db8:aa:bb:1234:5678:9abc:def0', EGRESS, true],
    ['the same /64 written in full, upper case', '2001:0DB8:00AA:00BB:0000:0000:0000:0042', EGRESS, true],
    ['the same /64 with a zone index', '2001:db8:aa:bb::1%en0', EGRESS, true],
    ['another /64 of the same /48', '2001:db8:aa:bc::1', EGRESS, false],
    ['another /64 of the same /56', '2001:db8:aa:1bb::1', EGRESS, false],
    ['an IPv6 client when only the IPv4 address is known', '2001:db8:aa:bb::1', { v4: EGRESS.v4 }, false],
    ['IPv4-mapped IPv6, dotted', '::ffff:203.0.113.7', EGRESS, true],
    ['IPv4-mapped IPv6, hex', '::FFFF:cb00:7107', EGRESS, true],
    ['an IPv4 client against a mapped server address', '203.0.113.7', { v4: '::ffff:203.0.113.7' }, true],
    ['another IPv4-mapped address', '::ffff:203.0.113.8', EGRESS, false],
    ['a mapped IPv4 against an IPv6 /64 (mapped forms do not match IPv6)', '::ffff:203.0.113.7', { v6: '::ffff:0:0' }, false],
    ['no client address', undefined, EGRESS, false],
    ['an empty client address', '', EGRESS, false],
    ['junk', 'not-an-ip', EGRESS, false],
    ['anything, when no server address is known', '203.0.113.7', {}, false],
  ])('%s', (_what, client, egress, expected) => {
    // Act
    const same = sameConnection(client, egress);
    // Assert
    expect(same).toBe(expected);
  });

  it('keeps one entry per IPv4 address and per IPv6 /64, and ignores junk', () => {
    // Arrange
    const set = new EgressSet();
    // Act
    const added = ['junk', '203.0.113.7', '::ffff:203.0.113.7', '2001:db8:aa:bb::1', '2001:db8:aa:bb::2'].map((ip) => set.add(ip));
    // Assert
    expect(added).toEqual([false, true, false, true, false]);
    expect(set.size).toBe(2);
  });

  it.each([
    ['IPv4 loopback', requestFrom('127.0.0.1'), true],
    ['IPv6 loopback', requestFrom('::1'), true],
    ['mapped loopback with a header that is not an IP', requestFrom('::ffff:127.0.0.1', { 'cf-connecting-ip': 'garbage' }), true],
    ['a client named by the header', requestFrom('127.0.0.1', { 'cf-connecting-ip': OTHER }), false],
  ])('a request through the tunnel from %s: this machine = %s', (_what, req, local) => {
    // Act
    const ip = clientIp(req, true);
    // Assert
    expect(isLocalAddress(ip)).toBe(local);
  });

  it.each([undefined, '10.0.0.5', '192.168.1.20', '172.16.4.4', '169.254.1.1', 'fe80::1', 'fd12:3456::1', '0.0.0.0', '::'])('%s counts as this machine or its network', (ip) => {
    // Act
    const local = isLocalAddress(ip);
    // Assert
    expect(local).toBe(true);
  });

  it.each([OTHER, '2804:1b3:61c1:c649::5', '172.32.0.1', `::ffff:${OTHER}`])('%s is a public address', (ip) => {
    // Act
    const local = isLocalAddress(ip);
    // Assert
    expect(local).toBe(false);
  });
});

describe('own public address watch', () => {
  it('is unknown until the first lookup', () => {
    // Arrange
    const t = watch([EGRESS]);
    // Act
    const verdict = t.w.classify(OTHER);
    // Assert
    expect(t.w.status).toBe('unknown');
    expect(verdict).toBe('unknown');
  });

  it('knows the server\'s addresses once the first lookup answered', async () => {
    // Arrange
    const t = watch([EGRESS]);
    // Act
    t.w.start();
    await t.settle();
    // Assert
    expect(t.w.status).toBe('known');
    expect(t.changes()).toBe(1);
  });

  it.each([
    ['the server\'s IPv4', '203.0.113.7', 'own'],
    ['the server\'s IPv4, mapped', '::ffff:203.0.113.7', 'own'],
    ['an IPv6 in the server\'s /64', '2001:db8:aa:bb:dead:beef::1', 'own'],
    ['this machine, or a request without CF-Connecting-IP', '127.0.0.1', 'own'],
    ['another IPv4', OTHER, 'other'],
    ['another /64', '2001:db8:aa:cc::1', 'other'],
  ])('then tells %s apart: %s', async (_what, ip, verdict) => {
    // Arrange
    const t = watch([EGRESS]);
    t.w.start();
    await t.settle();
    // Act
    const got = t.w.classify(ip);
    // Assert
    expect(got).toBe(verdict);
  });

  it('a failed lookup leaves the status unknown (conservative)', async () => {
    // Arrange
    const t = watch([new Error('offline'), EGRESS]);
    // Act
    t.w.start();
    await t.settle();
    // Assert
    expect(t.w.status).toBe('unknown');
    expect(t.w.failing).toBe(true);
    expect(t.w.classify(OTHER)).toBe('unknown');
  });

  it('an answer with no address at all is a failure too', async () => {
    // Arrange
    const t = watch([new Error('offline'), {}, EGRESS]);
    t.w.start();
    await t.settle();
    // Act
    await t.tick();
    // Assert
    expect(t.w.status).toBe('unknown');
  });

  it('a failed lookup is retried on the next tick', async () => {
    // Arrange
    const t = watch([new Error('offline'), {}, EGRESS]);
    t.w.start();
    await t.settle();
    await t.tick();
    // Act
    await t.tick();
    // Assert
    expect(t.w.status).toBe('known');
    expect(t.w.failing).toBe(false);
    expect(t.calls()).toBe(3);
  });

  describe('during a live', () => {
    /** A watch on Wi-Fi "a" whose provider hands out a new address on the second lookup, a third one after a network change, then fails. */
    async function started() {
      const net = { iface: 'wifi-a' };
      const t = watch([{ v4: '203.0.113.7' }, { v4: '203.0.113.99' }, { v4: '192.0.2.50' }, new Error('down')], { interfaces: () => net.iface });
      t.w.start();
      await t.settle();
      return { ...t, net };
    }

    it('does not look up again before the refresh time', async () => {
      // Arrange
      const t = await started();
      // Act
      await t.tick();
      // Assert
      expect(t.calls()).toBe(1);
    });

    it('looks up again after the refresh time, and the old address is still hers', async () => {
      // Arrange
      const t = await started();
      t.advance(REFRESH_MS);
      // Act
      await t.tick();
      // Assert
      expect(t.calls()).toBe(2);
      expect(t.w.classify('203.0.113.7')).toBe('own');
      expect(t.w.classify('203.0.113.99')).toBe('own');
    });

    it('looks up at once when the network changes', async () => {
      // Arrange
      const t = await started();
      t.advance(REFRESH_MS);
      await t.tick();
      t.net.iface = 'wifi-b';
      // Act
      await t.tick();
      // Assert
      expect(t.calls()).toBe(3);
      expect(t.w.classify('192.0.2.50')).toBe('own');
    });

    /** Network changed twice; the lookup after the second change failed. */
    async function changedAndFailing() {
      const t = await started();
      t.advance(REFRESH_MS);
      await t.tick();
      t.net.iface = 'wifi-b';
      await t.tick();
      t.net.iface = 'mobile';
      await t.tick();
      return t;
    }

    it('after a network change whose lookup fails, the old answers count for a while', async () => {
      // Act
      const t = await changedAndFailing();
      // Assert
      expect(t.w.status).toBe('known');
    });

    it('then the status turns unknown until a lookup works again; her addresses stay hers', async () => {
      // Arrange
      const t = await changedAndFailing();
      t.advance(STALE_MS + 1000);
      // Act
      await t.tick();
      // Assert
      expect(t.w.status).toBe('unknown');
      expect(t.w.classify(OTHER)).toBe('unknown');
      expect(t.w.classify('192.0.2.50')).toBe('own');
    });
  });

  it('logs at info level, never the addresses', async () => {
    // Arrange
    const { log, lines } = captureLog();
    const net = { iface: 'a' };
    const t = watch([new Error('offline'), EGRESS], { log, interfaces: () => net.iface });
    // Act
    t.w.start();
    await t.settle();
    await t.tick();
    net.iface = 'b';
    await t.tick();
    // Assert
    expect(lines().length).toBeGreaterThanOrEqual(3);
    for (const l of lines()) {
      expect(l.level).toBe(30);
      expect(JSON.stringify(l)).not.toMatch(/203\.0\.113|2001:db8/);
    }
  });

  it('stop forgets everything (the next live looks again)', async () => {
    // Arrange
    const t = watch([EGRESS]);
    t.w.start();
    await t.settle();
    // Act
    t.w.stop();
    // Assert
    expect(t.w.active).toBe(false);
    expect(t.w.status).toBe('unknown');
    expect(t.w.classify('203.0.113.7')).toBe('unknown');
  });
});
