import { Writable } from 'node:stream';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ViewerConfig } from '@swarmcast/shared';
import type { LiveController } from '../../src/core/live.js';
import type { PublicIps } from '../../src/direct/publicip.js';
import { infoHashHexFor } from '../../src/tracker/tracker.js';
import { NoTunnel, TunnelProvider } from '../../src/tunnel/provider.js';
import { Jar, joinAs } from './helpers.js';
import { openControl, startViewerLive, stopViewerLives, upgradeStatus, type ControlClient } from './viewers.js';

// A live in Secure mode behind a (fake) quick tunnel: the real public server, the real join flow,
// /control and the tracker, with CF-Connecting-IP set as cloudflared would. The server's own
// public address comes from a fake lookup instead of Cloudflare's trace endpoint (a service on
// the internet). That the tracker refuses an announce of such a session is unit-tested
// (tracker.test.ts); here, that the session never gets that far.

const HOME_V4 = '203.0.113.7';
const HOME_V6 = '2001:db8:aa:bb::1';
const GUEST_V4 = '198.51.100.20';

/** Looks like the quick tunnel (so CF-Connecting-IP is trusted) but serves the local port. */
class FakeQuickTunnel extends TunnelProvider {
  readonly name = 'cloudflare-quick';
  private current: string | null = null;
  async start(localPort: number): Promise<string> {
    this.current = `http://127.0.0.1:${localPort}`;
    return this.current;
  }
  async stop(): Promise<void> {
    this.current = null;
  }
  get url(): string | null {
    return this.current;
  }
}

/** A browser behind a given public address, as Cloudflare reports it to the local connector. */
class ViewerJar extends Jar {
  constructor(
    base: string,
    readonly ip: string,
  ) {
    super(base);
  }
  override fetch(p: string, init: RequestInit = {}): Promise<Response> {
    return super.fetch(p, { ...init, headers: { ...(init.headers as Record<string, string>), 'cf-connecting-ip': this.ip } });
  }
}

afterEach(stopViewerLives);

/**
 * A live behind `tunnel` whose own public address comes from `lookup` (the hourly re-check is
 * pushed out of the test's way), and its log lines.
 */
async function startLive(lookup: () => Promise<PublicIps>, tunnel: TunnelProvider = new FakeQuickTunnel()) {
  const lines: string[] = [];
  const log = pino(
    { level: 'debug' },
    new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    }),
  );
  const started = await startViewerLive({ deps: { tunnel, log, egress: { lookup, interfaces: () => 'test-net', tickMs: 3_600_000 } } });
  await started.live.egress.idle();
  return { ...started, lines };
}

/** A viewer joined from `ip`. */
async function joinFrom(base: string, link: string, nickname: string, ip: string): Promise<ViewerJar> {
  return (await joinAs(base, link, nickname, new ViewerJar(base, ip))) as ViewerJar;
}

/** What the watch page reads first (GET /api/config). */
async function viewerConfig(jar: Jar): Promise<ViewerConfig> {
  return (await (await jar.fetch('/api/config')).json()) as ViewerConfig;
}

/** The watch page's /control socket, from the viewer's address. */
function control(base: string, jar: ViewerJar): Promise<ControlClient> {
  return openControl(base, jar, { headers: { 'cf-connecting-ip': jar.ip } });
}

/** Status of a plain /tracker upgrade (101: opened). */
function trackerUpgrade(base: string, jar: ViewerJar): Promise<number> {
  return upgradeStatus(`${base.replace('http', 'ws')}/tracker`, { origin: base, headers: { cookie: jar.header(), 'cf-connecting-ip': jar.ip } });
}

const toBinary = (hex: string): string => Buffer.from(hex, 'hex').toString('latin1');
const announceFrame = (live: LiveController, channel: number, peer: string): string =>
  `~d${channel} ${JSON.stringify({ action: 'announce', info_hash: toBinary(infoHashHexFor(live.access.liveId, 'main')), peer_id: peer, numwant: 0, offers: [], event: 'started' })}`;

describe("no P2P on the streamer's own connection (Secure mode)", () => {
  it("a session whose CF-Connecting-IP is the server's own public IP gets P2P off; the tracker refuses it", async () => {
    // Arrange
    let egress: PublicIps = { v4: HOME_V4, v6: HOME_V6 };
    const { live, base, link, lines } = await startLive(async () => egress);
    const guest = await joinFrom(base, link, 'guest', GUEST_V4);
    const home = await joinFrom(base, link, 'home', HOME_V4);
    const phone = await joinFrom(base, link, 'phone', '2001:db8:aa:bb:1234:5678:9abc:def0');
    const mapped = await joinFrom(base, link, 'mapped', `::ffff:${HOME_V4}`);
    const neighbour = await joinFrom(base, link, 'neighbour', '2001:db8:aa:bc::9');
    const byNick = (n: string) => [...live.access.sessions.values()].find((s) => s.nickname === n)!;
    // Act
    const configs = Object.fromEntries(await Promise.all(Object.entries({ home, phone, mapped, guest, neighbour }).map(async ([n, jar]) => [n, await viewerConfig(jar)] as const)));
    const trackerStatus = { home: await trackerUpgrade(base, home), guest: await trackerUpgrade(base, guest) };
    const homeCtl = await control(base, home);
    homeCtl.sendFrame('~o1');
    await homeCtl.frame((f) => f === '~c1', 'the home channel to be closed');
    const guestCtl = await control(base, guest);
    guestCtl.sendFrame('~o1');
    guestCtl.sendFrame(announceFrame(live, 1, '-PM0400-000000000001'));
    const guestAnswer = await guestCtl.frame((f) => f.startsWith('~d1 '), 'the tracker answer to the guest');
    // Assert
    expect(live.egress.status).toBe('known');
    for (const n of ['home', 'phone', 'mapped']) expect(configs[n], n).toMatchObject({ p2pAllowed: false, p2pBlock: 'own-connection' });
    for (const n of ['guest', 'neighbour']) expect(configs[n], n).toMatchObject({ p2pAllowed: true });
    for (const n of ['guest', 'neighbour']) expect(configs[n]!.p2pBlock, n).toBeUndefined();
    expect(byNick('home').ownConnection).toBe(true);
    expect(live.snapshot().viewers.find((v) => v.nickname === 'home')).toMatchObject({ ownConnection: true });
    expect(live.snapshot().viewers.find((v) => v.nickname === 'guest')?.ownConnection).toBeUndefined();
    expect(live.activity.list().filter((e) => e.code === 'log.p2pOwnConnection').map((e) => e.params?.nickname)).toEqual(['home', 'phone', 'mapped']);
    expect(trackerStatus).toEqual({ home: 403, guest: 101 });
    expect(homeCtl.hello).toMatchObject({ p2pAllowed: false, p2pBlock: 'own-connection' });
    expect(guestCtl.hello.p2pAllowed).toBe(true);
    expect(guestCtl.hello.p2pBlock).toBeUndefined();
    expect(guestAnswer).not.toContain('failure reason');
    expect(byNick('guest').peerIds.size).toBe(1);
    // Act
    const guestPeers = [...byNick('guest').peerIds];
    egress = { v4: GUEST_V4 };
    await live.egress.refresh('test');
    await guestCtl.next('p2p', (m) => !m.allowed);
    await guestCtl.frame((f) => f === '~c1', 'the guest channel to be closed');
    guestCtl.sendFrame('~o2');
    await guestCtl.frame((f) => f === '~c2', 'a new guest channel to be refused');
    // Assert
    expect(guestCtl.last('p2p')).toEqual({ t: 'p2p', allowed: false, forAll: true, reason: 'own-connection' });
    expect(live.control.blockedPeers.has(guestPeers[0]!)).toBe(true);
    expect(live.access.p2pAllowed(byNick('home'))).toBe(false);
    expect(live.access.p2pAllowed(byNick('neighbour'))).toBe(true);
    const ours = lines.filter((l) => /own internet connection|public address/.test(l));
    expect(ours.length).toBeGreaterThan(0);
    for (const l of ours) expect(JSON.parse(l).level).toBe(30);
    for (const l of lines) expect(l).not.toMatch(/203\.0\.113\.7|198\.51\.100\.20|2001:db8/);
  });

  it('while the own address is unknown (lookup failed), P2P waits for everyone and resumes once it is known', async () => {
    // Arrange
    let result: PublicIps | Error = new Error('offline');
    const { live, base, link } = await startLive(async () => {
      if (result instanceof Error) throw result;
      return result;
    });
    const guest = await joinFrom(base, link, 'guest', GUEST_V4);
    // Act
    const waiting = { egress: live.egress.status, checking: live.access.p2pChecking, config: await viewerConfig(guest), tracker: await trackerUpgrade(base, guest), warnings: live.snapshot().warningCodes.map((w) => w.code) };
    const ctl = await control(base, guest);
    // Assert
    expect(waiting).toMatchObject({ egress: 'unknown', checking: true, config: { p2pAllowed: false, p2pBlock: 'checking' }, tracker: 403 });
    expect(waiting.warnings).toContain('warn.p2pChecking');
    expect(ctl.hello).toMatchObject({ p2pAllowed: false, p2pBlock: 'checking' });
    // Act
    result = { v4: HOME_V4 };
    await live.egress.refresh('test');
    const resumed = await ctl.next('p2p', (m) => m.allowed);
    // Assert
    expect(resumed).toEqual({ t: 'p2p', allowed: true, forAll: true });
    expect(live.access.p2pChecking).toBe(false);
    expect(live.snapshot().warningCodes.map((w) => w.code)).not.toContain('warn.p2pChecking');
    expect(await viewerConfig(guest)).toMatchObject({ p2pAllowed: true });
    expect(await trackerUpgrade(base, guest)).toBe(101);
  });

  it('without a trusted tunnel (no tunnel, external proxy, Direct mode) nothing is looked up or changed', async () => {
    // Arrange
    const lookup = vi.fn(async () => ({ v4: HOME_V4 }));
    const { live, base, link } = await startLive(lookup, new NoTunnel());
    // Act
    const local = await joinFrom(base, link, 'local', HOME_V4);
    const config = await viewerConfig(local);
    // Assert
    expect(live.egress.active).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
    expect(config).toMatchObject({ p2pAllowed: true });
  });
});
