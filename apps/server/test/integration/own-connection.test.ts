import { Writable } from 'node:stream';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { ServerMessage, ViewerConfig } from '@swarmcast/shared';
import type { LiveController } from '../../src/core/live.js';
import type { DirectMode } from '../../src/direct/direct.js';
import type { PublicIps } from '../../src/direct/publicip.js';
import { infoHashHexFor } from '../../src/tracker/tracker.js';
import { TunnelProvider } from '../../src/tunnel/provider.js';
import { makeController } from '../unit/live-helpers.js';
import { Jar, joinAs } from './helpers.js';

// A live in Secure mode behind a (fake) quick tunnel: the real public server, the real join flow,
// /control and the tracker, with CF-Connecting-IP set as cloudflared would. The server's own
// public address comes from a fake lookup instead of Cloudflare's trace endpoint.

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

const direct = { noteViewer: vi.fn(), snapshot: () => ({ active: false, viewersSeen: 0 }), active: false, ipChanged: null } as unknown as DirectMode;
const lives: LiveController[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const l of lives.splice(0)) await l.stop().catch(() => {});
});

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
  const { live } = makeController(direct, { tunnel, log, egress: { lookup, interfaces: () => 'test-net', tickMs: 3_600_000 } });
  lives.push(live);
  await live.start();
  await live.egress.idle();
  const base = `http://127.0.0.1:${live.publicPort}`;
  return { live, base, link: live.liveLink!, lines };
}

async function viewerConfig(jar: Jar): Promise<ViewerConfig> {
  const res = await jar.fetch('/api/config');
  expect(res.status).toBe(200);
  return (await res.json()) as ViewerConfig;
}

/** The viewer page's /control socket: JSON messages and tracker frames, as they arrive. */
async function openControl(base: string, jar: ViewerJar) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/control`, { origin: base, headers: { cookie: jar.header(), 'cf-connecting-ip': jar.ip } });
  sockets.push(ws);
  const messages: ServerMessage[] = [];
  const frames: string[] = [];
  ws.on('message', (d) => {
    const text = String(d);
    if (text.startsWith('~')) frames.push(text);
    else messages.push(JSON.parse(text) as ServerMessage);
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  await vi.waitFor(() => expect(messages.some((m) => m.t === 'hello')).toBe(true));
  return { ws, messages, frames, hello: messages.find((m) => m.t === 'hello') as Extract<ServerMessage, { t: 'hello' }> };
}

/** Status of a plain /tracker upgrade (101 = opened). */
function trackerUpgrade(base: string, jar: ViewerJar): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/tracker`, { origin: base, headers: { cookie: jar.header(), 'cf-connecting-ip': jar.ip } });
    sockets.push(ws);
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('open', () => resolve(101));
    ws.on('error', () => resolve(-1));
  });
}

const toBinary = (hex: string): string => Buffer.from(hex, 'hex').toString('latin1');
const announceFrame = (live: LiveController, channel: number, peer: string): string =>
  `~d${channel} ${JSON.stringify({ action: 'announce', info_hash: toBinary(infoHashHexFor(live.access.liveId, 'main')), peer_id: peer, numwant: 0, offers: [], event: 'started' })}`;

describe("no P2P on the streamer's own connection (Secure mode)", () => {
  it('a session whose CF-Connecting-IP is the server\'s own public IP gets P2P off; the tracker refuses it', async () => {
    let egress: PublicIps = { v4: HOME_V4, v6: HOME_V6 };
    const { live, base, link, lines } = await startLive(async () => egress);
    expect(live.egress.status).toBe('known');
    const guest = await joinAs(base, link, 'guest', new ViewerJar(base, GUEST_V4));
    const home = await joinAs(base, link, 'home', new ViewerJar(base, HOME_V4));
    const phone = await joinAs(base, link, 'phone', new ViewerJar(base, '2001:db8:aa:bb:1234:5678:9abc:def0'));
    const mapped = await joinAs(base, link, 'mapped', new ViewerJar(base, `::ffff:${HOME_V4}`));
    const neighbour = await joinAs(base, link, 'neighbour', new ViewerJar(base, '2001:db8:aa:bc::9'));

    for (const jar of [home, phone, mapped]) {
      expect(await viewerConfig(jar)).toMatchObject({ p2pAllowed: false, p2pBlock: 'own-connection' });
    }
    for (const jar of [guest, neighbour]) {
      const cfg = await viewerConfig(jar);
      expect(cfg.p2pAllowed).toBe(true);
      expect(cfg.p2pBlock).toBeUndefined();
    }
    const byNick = (n: string) => [...live.access.sessions.values()].find((s) => s.nickname === n)!;
    expect(byNick('home').ownConnection).toBe(true);
    expect(live.snapshot().viewers.find((v) => v.nickname === 'home')).toMatchObject({ ownConnection: true });
    expect(live.snapshot().viewers.find((v) => v.nickname === 'guest')?.ownConnection).toBeUndefined();
    expect(live.activity.list().filter((e) => e.code === 'log.p2pOwnConnection').map((e) => e.params?.nickname)).toEqual(['home', 'phone', 'mapped']);

    // The tracker: a plain /tracker socket is refused, so is a channel inside /control.
    expect(await trackerUpgrade(base, home as ViewerJar)).toBe(403);
    expect(await trackerUpgrade(base, guest as ViewerJar)).toBe(101);
    const homeCtl = await openControl(base, home as ViewerJar);
    expect(homeCtl.hello).toMatchObject({ p2pAllowed: false, p2pBlock: 'own-connection' });
    homeCtl.ws.send('~o1');
    await vi.waitFor(() => expect(homeCtl.frames).toContain('~c1'));
    const check = (live.tracker as unknown as { check(h: string, p: unknown): Error | null }).check.bind(live.tracker);
    expect(check(infoHashHexFor(live.access.liveId, 'main'), { socket: { sessionId: byNick('home').id }, peer_id: 'x' })?.message).toBe('p2p not allowed');

    // The guest announces fine over its channel.
    const guestCtl = await openControl(base, guest as ViewerJar);
    expect(guestCtl.hello.p2pAllowed).toBe(true);
    expect(guestCtl.hello.p2pBlock).toBeUndefined();
    guestCtl.ws.send('~o1');
    guestCtl.ws.send(announceFrame(live, 1, '-PM0400-000000000001'));
    await vi.waitFor(() => expect(guestCtl.frames.some((f) => f.startsWith('~d1 '))).toBe(true));
    expect(guestCtl.frames.find((f) => f.startsWith('~d1 '))).not.toContain('failure reason');
    expect(byNick('guest').peerIds.size).toBe(1);

    // The streamer's connection changes and the guest turns out to be on it (say, the streamer
    // moved to the guest's Wi-Fi): P2P goes off for the guest at once, the swarm drops it.
    const guestPeers = [...byNick('guest').peerIds];
    egress = { v4: GUEST_V4 };
    await live.egress.refresh('test');
    await vi.waitFor(() => expect(guestCtl.messages).toContainEqual({ t: 'p2p', allowed: false, forAll: true, reason: 'own-connection' }));
    await vi.waitFor(() => expect(guestCtl.frames).toContain('~c1'));
    expect(live.control.blockedPeers.has(guestPeers[0]!)).toBe(true);
    guestCtl.ws.send('~o2');
    await vi.waitFor(() => expect(guestCtl.frames).toContain('~c2'));
    // The earlier address still counts: home stays off.
    expect(live.access.p2pAllowed(byNick('home'))).toBe(false);
    expect(live.access.p2pAllowed(byNick('neighbour'))).toBe(true);

    // Info-level lines only, and no address of anyone in them.
    const ours = lines.filter((l) => /own internet connection|public address/.test(l));
    expect(ours.length).toBeGreaterThan(0);
    for (const l of ours) expect(JSON.parse(l).level).toBe(30);
    for (const l of lines) expect(l).not.toMatch(/203\.0\.113\.7|198\.51\.100\.20|2001:db8/);
  });

  it('while the own address is unknown (lookup failed), P2P waits for everyone and resumes once it is known', async () => {
    let result: PublicIps | Error = new Error('offline');
    const { live, base, link } = await startLive(async () => {
      if (result instanceof Error) throw result;
      return result;
    });
    expect(live.egress.status).toBe('unknown');
    expect(live.access.p2pChecking).toBe(true);
    const guest = (await joinAs(base, link, 'guest', new ViewerJar(base, GUEST_V4))) as ViewerJar;
    expect(await viewerConfig(guest)).toMatchObject({ p2pAllowed: false, p2pBlock: 'checking' });
    expect(await trackerUpgrade(base, guest)).toBe(403);
    const ctl = await openControl(base, guest);
    expect(ctl.hello).toMatchObject({ p2pAllowed: false, p2pBlock: 'checking' });
    expect(live.snapshot().warningCodes.map((w) => w.code)).toContain('warn.p2pChecking');

    result = { v4: HOME_V4 };
    await live.egress.refresh('test');
    await vi.waitFor(() => expect(ctl.messages).toContainEqual({ t: 'p2p', allowed: true, forAll: true }));
    expect(live.access.p2pChecking).toBe(false);
    expect(live.snapshot().warningCodes.map((w) => w.code)).not.toContain('warn.p2pChecking');
    expect(await viewerConfig(guest)).toMatchObject({ p2pAllowed: true });
    expect(await trackerUpgrade(base, guest)).toBe(101);
  });

  it('without a trusted tunnel (no tunnel, external proxy, Direct mode) nothing is looked up or changed', async () => {
    const { NoTunnel } = await import('../../src/tunnel/provider.js');
    const lookup = vi.fn(async () => ({ v4: HOME_V4 }));
    const { live, base, link } = await startLive(lookup, new NoTunnel());
    expect(live.egress.active).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
    // The header is not trusted here, so it changes nothing either.
    const jar = (await joinAs(base, link, 'local', new ViewerJar(base, HOME_V4))) as ViewerJar;
    expect(await viewerConfig(jar)).toMatchObject({ p2pAllowed: true });
  });
});
