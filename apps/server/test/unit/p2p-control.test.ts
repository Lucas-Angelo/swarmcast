import { describe, expect, it } from 'vitest';
import { HASH_FAILURE_THRESHOLD, type ServerMessage } from '@swarmcast/shared';
import { defaultConfig, type AppConfig } from '../../src/core/config.js';
import type { LiveController } from '../../src/core/live.js';
import { controlSocket, directOff, joinViewer, nextJson, roundTrip, trackerSocket, upgradeServer, type TestSocket } from './helpers-b.js';
import { makeController } from './live-helpers.js';

// P2P control of the live, as the viewers' pages see it on their /control sockets (and their
// tracker sockets): "Remove from P2P" makes a session watch-only (it keeps watching), closes its
// tracker sockets and tells every viewer to drop its peers; kicking does the same for the peers of
// the kicked session. Repeated hash failures reported by other viewers remove the accused session
// automatically (a viewer cannot report itself). "Allow P2P for viewers" is the global switch,
// saved in the config. Frames reach the live's control channel through a real WebSocket, and a ping
// round trip (roundTrip) tells when the server has handled them. The peer ids a session announced
// are put on it directly (the tracker records them on announces: tracker.test.ts).

/** A peer id as sessions record it (hex of the 20-byte id). */
const PEER = 'aa'.repeat(20);

/** A live that began (no public server: the channels are reached through upgradeServer), and its ws:// base URL. */
async function liveWithChannels(over: { config?: AppConfig; saveConfig?: (c: AppConfig) => void } = {}): Promise<{ live: LiveController; url: string }> {
  const { live } = makeController(directOff(), over);
  live.access.begin();
  const url = await upgradeServer(live.access, { control: live.control, tracker: live.tracker });
  return { live, url };
}

/** What the server sent on `c` after its hello, parsed, without the viewer-count pushes (they go out on a timer of their own). */
const received = (c: TestSocket): ServerMessage[] => c.frames.slice(1).map((f) => JSON.parse(f) as ServerMessage).filter((m) => m.t !== 'viewers');

/** A stats report as the player sends it. */
const STATS = { t: 'stats', p2pEnabled: true, httpBytes: 1, p2pDownBytes: 0, p2pUpBytes: 0, peers: 0, http429: 0, device: 'desktop' };

describe('"remove from P2P"', () => {
  it('makes the session watch-only: P2P off for it, and it keeps watching', async () => {
    // Arrange
    const { live, url } = await liveWithChannels();
    const s = joinViewer(live.access, 'x');
    const own = await controlSocket(url, s);
    // Act
    const done = live.setP2P(s.id, false);
    await roundTrip(own.ws);
    // Assert
    expect(done).toBe(true);
    expect(s.p2pAllowed).toBe(false);
    expect(received(own)).toContainEqual({ t: 'p2p', allowed: false, forAll: true });
    expect(live.access.sessions.has(s.id)).toBe(true);
  });

  it('closes its tracker sockets', async () => {
    // Arrange
    const { live, url } = await liveWithChannels();
    const s = joinViewer(live.access, 'x');
    const tracker = await trackerSocket(url, s);
    // Act
    live.setP2P(s.id, false);
    // Assert
    expect(await tracker.closed).toBe(1006);
  });

  it('tells every viewer to drop its peers, and to take them back once allowed again', async () => {
    // Arrange
    const { live, url } = await liveWithChannels();
    const s = joinViewer(live.access, 'x');
    s.peerIds.add(PEER);
    const other = await controlSocket(url, joinViewer(live.access, 'other'));
    // Act
    live.setP2P(s.id, false);
    await roundTrip(other.ws);
    const blocked = [...live.control.blockedPeers];
    live.setP2P(s.id, true);
    await roundTrip(other.ws);
    // Assert
    expect(blocked).toEqual([PEER]);
    expect(received(other)).toEqual([
      { t: 'block-peers', peerIds: [PEER] },
      { t: 'unblock-peers', peerIds: [PEER] },
    ]);
    expect(live.control.blockedPeers.size).toBe(0);
  });

  it('kick also blocks the peers of the kicked session', async () => {
    // Arrange
    const { live, url } = await liveWithChannels();
    const s = joinViewer(live.access, 'x');
    s.peerIds.add('bb'.repeat(20));
    const kicked = await controlSocket(url, s);
    const other = await controlSocket(url, joinViewer(live.access, 'other'));
    // Act
    live.kick(s.id);
    await roundTrip(other.ws);
    // Assert
    expect(await kicked.closed).toBe(4003);
    expect(received(kicked)).toContainEqual({ t: 'kicked' });
    expect(received(other)).toContainEqual({ t: 'block-peers', peerIds: ['bb'.repeat(20)] });
  });

  it('repeated hash failures remove the accused session from P2P automatically', async () => {
    // Arrange
    const { live, url } = await liveWithChannels();
    const reporter = await controlSocket(url, joinViewer(live.access, 'honest'));
    const bad = joinViewer(live.access, 'evil');
    bad.peerIds.add('cc'.repeat(20));
    // Act
    for (let i = 0; i < HASH_FAILURE_THRESHOLD; i++) reporter.ws.send(JSON.stringify({ t: 'hash-fail', peerId: 'cc'.repeat(20), segment: 'p2p' }));
    await roundTrip(reporter.ws);
    // Assert
    expect(bad.hashFailures).toBe(HASH_FAILURE_THRESHOLD);
    expect(bad.p2pAllowed).toBe(false);
    expect(bad.autoRemovedFromP2P).toBe(true);
    expect(live.snapshot().warnings.join(' ')).toMatch(/removed from P2P automatically/);
  });

  it('a viewer cannot report itself, and junk messages are ignored', async () => {
    // Arrange
    const { live, url } = await liveWithChannels();
    const s = joinViewer(live.access, 'a');
    s.peerIds.add('dd'.repeat(20));
    const own = await controlSocket(url, s);
    // Act
    for (let i = 0; i < HASH_FAILURE_THRESHOLD + 2; i++) own.ws.send(JSON.stringify({ t: 'hash-fail', peerId: 'dd'.repeat(20), segment: 'x' }));
    own.ws.send('{not json');
    own.ws.send(JSON.stringify({ t: 'stats', p2pEnabled: 'yes' }));
    await roundTrip(own.ws);
    // Assert
    expect(s.hashFailures).toBe(0);
    expect(s.p2pAllowed).toBe(true);
    expect(own.ws.readyState).toBe(own.ws.OPEN);
  });

  it('the delay a player reports shows in the viewers table', async () => {
    // Arrange
    const { live, url } = await liveWithChannels();
    const own = await controlSocket(url, joinViewer(live.access, 'late'));
    const before = live.snapshot().viewers.find((v) => v.nickname === 'late')?.delayS;
    // Act
    own.ws.send(JSON.stringify({ ...STATS, delayS: 14 }));
    await roundTrip(own.ws);
    // Assert
    expect(before).toBeNull();
    expect(live.snapshot().viewers.find((v) => v.nickname === 'late')?.delayS).toBe(14);
  });

  it('an out-of-range delay is refused (the last one stays)', async () => {
    // Arrange
    const { live, url } = await liveWithChannels();
    const s = joinViewer(live.access, 'late');
    const own = await controlSocket(url, s);
    own.ws.send(JSON.stringify({ ...STATS, delayS: 14 }));
    // Act
    own.ws.send(JSON.stringify({ ...STATS, delayS: 9999 }));
    await roundTrip(own.ws);
    // Assert
    expect(s.delayS).toBe(14);
  });

  it('an older player without the delay field makes it unknown again', async () => {
    // Arrange
    const { live, url } = await liveWithChannels();
    const s = joinViewer(live.access, 'late');
    const own = await controlSocket(url, s);
    own.ws.send(JSON.stringify({ ...STATS, delayS: 14 }));
    // Act
    own.ws.send(JSON.stringify(STATS));
    await roundTrip(own.ws);
    // Assert
    expect(s.delayS).toBeNull();
  });

  it('floods on the control channel terminate the socket', async () => {
    // Arrange
    const { live, url } = await liveWithChannels();
    const own = await controlSocket(url, joinViewer(live.access, 'a'));
    // Act
    for (let i = 0; i < 40; i++) own.ws.send(JSON.stringify({ t: 'pong' }));
    // Assert
    expect(await own.closed).toBe(1006);
  });
});

describe('"Allow P2P for viewers" (global switch)', () => {
  it('is on by default', () => {
    // Act
    const config = defaultConfig();
    // Assert
    expect(config.allowViewerP2P).toBe(true);
  });

  it('persists in config', async () => {
    // Arrange
    const saved: boolean[] = [];
    const { live } = await liveWithChannels({ saveConfig: (c) => void saved.push(c.allowViewerP2P) });
    // Act
    live.updateSettings({ ...live.snapshot().settings, allowViewerP2P: false });
    // Assert
    expect(saved).toEqual([false]);
    expect(live.snapshot().settings.allowViewerP2P).toBe(false);
  });

  /** Viewers a and b on their pages; b was removed from P2P one by one before. */
  async function twoViewers() {
    const { live, url } = await liveWithChannels();
    const a = joinViewer(live.access, 'a');
    const b = joinViewer(live.access, 'b');
    const pageA = await controlSocket(url, a);
    const pageB = await controlSocket(url, b);
    live.setP2P(b.id, false);
    await roundTrip(pageB.ws);
    pageA.frames.splice(1);
    pageB.frames.splice(1);
    return { live, url, a, b, pageA, pageB };
  }

  it('turns P2P off live for every viewer', async () => {
    // Arrange
    const { live, url, a, pageA, pageB } = await twoViewers();
    const tracker = await trackerSocket(url, a);
    // Act
    live.updateSettings({ ...live.snapshot().settings, allowViewerP2P: false });
    await Promise.all([roundTrip(pageA.ws), roundTrip(pageB.ws)]);
    // Assert
    expect(received(pageA)).toEqual([{ t: 'p2p', allowed: false, forAll: false }]);
    expect(received(pageB)).toEqual([{ t: 'p2p', allowed: false, forAll: false }]);
    expect(await tracker.closed).toBe(1006);
    expect(live.access.p2pAllowed(a)).toBe(false);
    expect(live.activity.list().some((e) => e.code === 'log.p2pForAllOff')).toBe(true);
  });

  it('the tracker refuses announces while it is off', async () => {
    // Arrange
    const { live, url, a } = await twoViewers();
    live.updateSettings({ ...live.snapshot().settings, allowViewerP2P: false });
    const tracker = await trackerSocket(url, a);
    const reply = nextJson<Record<string, unknown>>(tracker.ws);
    // Act
    tracker.ws.send(JSON.stringify({ action: 'announce', info_hash: 'x'.repeat(20), peer_id: '-PM0400-000000000001', numwant: 0, offers: [], event: 'started' }));
    // Assert
    expect((await reply)['failure reason']).toBe('p2p not allowed');
  });

  it('turns P2P back on for every viewer, except viewers removed one by one', async () => {
    // Arrange
    const { live, a, b, pageA, pageB } = await twoViewers();
    live.updateSettings({ ...live.snapshot().settings, allowViewerP2P: false });
    await Promise.all([roundTrip(pageA.ws), roundTrip(pageB.ws)]);
    pageA.frames.splice(1);
    pageB.frames.splice(1);
    // Act
    live.updateSettings({ ...live.snapshot().settings, allowViewerP2P: true });
    await Promise.all([roundTrip(pageA.ws), roundTrip(pageB.ws)]);
    // Assert
    expect(received(pageA)).toEqual([{ t: 'p2p', allowed: true, forAll: true }]);
    expect(received(pageB)).toEqual([{ t: 'p2p', allowed: false, forAll: true }]);
    expect(live.access.p2pAllowed(a)).toBe(true);
    expect(live.access.p2pAllowed(b)).toBe(false);
  });

  it('a config saved with P2P off starts with P2P off', () => {
    // Act
    const { live } = makeController(directOff(), { config: { ...defaultConfig(), allowViewerP2P: false } });
    // Assert
    expect(live.access.p2pForAll).toBe(false);
  });
});
