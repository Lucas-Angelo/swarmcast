import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import { HASH_FAILURE_THRESHOLD, encodeTrackerFrame, type ServerMessage } from '@swarmcast/shared';
import type { Session } from '../../src/access/access.js';
import { defaultConfig, type AppConfig } from '../../src/core/config.js';
import type { LiveController } from '../../src/core/live.js';
import { FakeControlSocket, announceFrame, joinViewer, nextJson, trackerSocket, upgradeServer } from './helpers-b.js';
import { inactiveDirect, makeController } from './live-helpers.js';

// P2P control of the live, as the viewers' pages see it on their /control sockets: "Remove from
// P2P" makes a session watch-only (it keeps watching), closes its tracker connections and tells
// every viewer to drop its peers; kicking does the same for the peers of the kicked session.
// Repeated hash failures reported by other viewers remove the accused session automatically (a
// viewer cannot report itself). "Allow P2P for viewers" is the global switch, saved in the
// config. The pages' sockets are fakes the control channel takes over directly (attach): the
// network is not the subject here (tracker-mux.test.ts has the real one). A page's tracker
// connection is a channel inside its /control socket, as the viewer opens it. The peer ids a
// session announced are put on it directly (the tracker records them on announces).

/** The upgrade request of a page's /control socket. */
const REQ = { url: '/control' } as IncomingMessage;

/** A peer id as sessions record it (hex of the 20-byte id). */
const PEER = 'aa'.repeat(20);

/** A stats report as the player sends it. */
const STATS = { t: 'stats', p2pEnabled: true, httpBytes: 1, p2pDownBytes: 0, p2pUpBytes: 0, peers: 0, http429: 0, device: 'desktop' };

/** A live that began (not started: no public server). */
function liveOn(over: { config?: AppConfig; saveConfig?: (c: AppConfig) => void } = {}): LiveController {
  const { live } = makeController(inactiveDirect(), over);
  live.access.begin();
  return live;
}

/** The page of `s` on /control. */
function page(live: LiveController, s: Session): FakeControlSocket {
  const sock = new FakeControlSocket();
  live.control.attach(sock as unknown as WebSocket, s, REQ);
  return sock;
}

/** The page of `s` with its tracker connection open: channel 1 inside its /control socket. */
function pageWithTracker(live: LiveController, s: Session): FakeControlSocket {
  const sock = page(live, s);
  sock.receive(encodeTrackerFrame({ op: 'open', id: 1 }));
  return sock;
}

/** What the server sent on `sock` after its hello, parsed: control messages only, without the viewer-count pushes (they go out on a timer of their own). */
const received = (sock: FakeControlSocket): ServerMessage[] =>
  sock.sent
    .slice(1)
    .filter((f) => !f.startsWith('~'))
    .map((f) => JSON.parse(f) as ServerMessage)
    .filter((m) => m.t !== 'viewers');

/** True once the server closed the tracker channel inside `sock`. */
const trackerClosed = (sock: FakeControlSocket): boolean => sock.sent.includes(encodeTrackerFrame({ op: 'close', id: 1 }));

/** Forgets what the server sent on `sock` so far, except its hello. */
const seen = (sock: FakeControlSocket): void => void sock.sent.splice(1);

describe('"remove from P2P"', () => {
  it('makes the session watch-only: P2P off for it, and it keeps watching', () => {
    // Arrange
    const live = liveOn();
    const s = joinViewer(live.access, 'x');
    const own = page(live, s);
    // Act
    const done = live.setP2P(s.id, false);
    // Assert
    expect(done).toBe(true);
    expect(s.p2pAllowed).toBe(false);
    expect(received(own)).toContainEqual({ t: 'p2p', allowed: false, forAll: true });
    expect(live.access.sessions.has(s.id)).toBe(true);
  });

  it('closes its tracker connections', () => {
    // Arrange
    const live = liveOn();
    const s = joinViewer(live.access, 'x');
    const own = pageWithTracker(live, s);
    // Act
    live.setP2P(s.id, false);
    // Assert
    expect(trackerClosed(own)).toBe(true);
  });

  it('tells every viewer to drop its peers, and to take them back once allowed again', () => {
    // Arrange
    const live = liveOn();
    const s = joinViewer(live.access, 'x');
    s.peerIds.add(PEER);
    const other = page(live, joinViewer(live.access, 'other'));
    // Act
    live.setP2P(s.id, false);
    const blocked = [...live.control.blockedPeers];
    live.setP2P(s.id, true);
    // Assert
    expect(blocked).toEqual([PEER]);
    expect(received(other)).toEqual([
      { t: 'block-peers', peerIds: [PEER] },
      { t: 'unblock-peers', peerIds: [PEER] },
    ]);
    expect(live.control.blockedPeers.size).toBe(0);
  });

  it('kick also blocks the peers of the kicked session', () => {
    // Arrange
    const live = liveOn();
    const s = joinViewer(live.access, 'x');
    s.peerIds.add('bb'.repeat(20));
    const kicked = page(live, s);
    const other = page(live, joinViewer(live.access, 'other'));
    // Act
    live.kick(s.id);
    // Assert
    expect(received(kicked)).toContainEqual({ t: 'kicked' });
    expect(kicked.close).toHaveBeenCalledWith(4003, 'kicked');
    expect(received(other)).toContainEqual({ t: 'block-peers', peerIds: ['bb'.repeat(20)] });
  });

  it('repeated hash failures remove the accused session from P2P automatically', () => {
    // Arrange
    const live = liveOn();
    const reporter = page(live, joinViewer(live.access, 'honest'));
    const bad = joinViewer(live.access, 'evil');
    bad.peerIds.add('cc'.repeat(20));
    // Act
    for (let i = 0; i < HASH_FAILURE_THRESHOLD; i++) reporter.receive(JSON.stringify({ t: 'hash-fail', peerId: 'cc'.repeat(20), segment: 'p2p' }));
    // Assert
    expect(bad.hashFailures).toBe(HASH_FAILURE_THRESHOLD);
    expect(bad.p2pAllowed).toBe(false);
    expect(bad.autoRemovedFromP2P).toBe(true);
    expect(live.snapshot().warnings.join(' ')).toMatch(/removed from P2P automatically/);
  });

  it('a viewer cannot report itself, and junk messages are ignored', () => {
    // Arrange
    const live = liveOn();
    const s = joinViewer(live.access, 'a');
    s.peerIds.add('dd'.repeat(20));
    const own = page(live, s);
    // Act
    for (let i = 0; i < HASH_FAILURE_THRESHOLD + 2; i++) own.receive(JSON.stringify({ t: 'hash-fail', peerId: 'dd'.repeat(20), segment: 'x' }));
    own.receive('{not json');
    own.receive(JSON.stringify({ t: 'stats', p2pEnabled: 'yes' }));
    // Assert
    expect(s.hashFailures).toBe(0);
    expect(s.p2pAllowed).toBe(true);
    expect(own.terminate).not.toHaveBeenCalled();
  });

  it('the delay a player reports shows in the viewers table', () => {
    // Arrange
    const live = liveOn();
    const own = page(live, joinViewer(live.access, 'late'));
    const before = live.snapshot().viewers.find((v) => v.nickname === 'late')?.delayS;
    // Act
    own.receive(JSON.stringify({ ...STATS, delayS: 14 }));
    // Assert
    expect(before).toBeNull();
    expect(live.snapshot().viewers.find((v) => v.nickname === 'late')?.delayS).toBe(14);
  });

  it('an out-of-range delay is refused (the last one stays)', () => {
    // Arrange
    const live = liveOn();
    const s = joinViewer(live.access, 'late');
    const own = page(live, s);
    own.receive(JSON.stringify({ ...STATS, delayS: 14 }));
    // Act
    own.receive(JSON.stringify({ ...STATS, delayS: 9999 }));
    // Assert
    expect(s.delayS).toBe(14);
  });

  it('an older player without the delay field makes it unknown again', () => {
    // Arrange
    const live = liveOn();
    const s = joinViewer(live.access, 'late');
    const own = page(live, s);
    own.receive(JSON.stringify({ ...STATS, delayS: 14 }));
    // Act
    own.receive(JSON.stringify(STATS));
    // Assert
    expect(s.delayS).toBeNull();
  });

  it('floods on the control channel terminate the socket', () => {
    // Arrange
    const live = liveOn();
    const own = page(live, joinViewer(live.access, 'a'));
    // Act
    for (let i = 0; i < 40; i++) own.receive(JSON.stringify({ t: 'pong' }));
    // Assert
    expect(own.terminate).toHaveBeenCalled();
  });
});

describe('"Allow P2P for viewers" (global switch)', () => {
  it('is on by default', () => {
    // Act
    const config = defaultConfig();
    // Assert
    expect(config.allowViewerP2P).toBe(true);
  });

  it('persists in config', () => {
    // Arrange
    const saved: boolean[] = [];
    const live = liveOn({ saveConfig: (c) => void saved.push(c.allowViewerP2P) });
    // Act
    live.updateSettings({ ...live.snapshot().settings, allowViewerP2P: false });
    // Assert
    expect(saved).toEqual([false]);
    expect(live.snapshot().settings.allowViewerP2P).toBe(false);
  });

  /** Viewers a and b on their pages (a with its tracker connection); b was removed from P2P one by one before. */
  function twoViewers() {
    const live = liveOn();
    const a = joinViewer(live.access, 'a');
    const b = joinViewer(live.access, 'b');
    const pageA = pageWithTracker(live, a);
    const pageB = page(live, b);
    live.setP2P(b.id, false);
    seen(pageA);
    seen(pageB);
    return { live, a, b, pageA, pageB };
  }

  it('turns P2P off live for every viewer', () => {
    // Arrange
    const { live, a, pageA, pageB } = twoViewers();
    // Act
    live.updateSettings({ ...live.snapshot().settings, allowViewerP2P: false });
    // Assert
    expect(received(pageA)).toEqual([{ t: 'p2p', allowed: false, forAll: false }]);
    expect(received(pageB)).toEqual([{ t: 'p2p', allowed: false, forAll: false }]);
    expect(trackerClosed(pageA)).toBe(true);
    expect(live.access.p2pAllowed(a)).toBe(false);
    expect(live.activity.list().some((e) => e.code === 'log.p2pForAllOff')).toBe(true);
  });

  it('the tracker refuses announces while it is off', async () => {
    // Arrange
    const { live, a } = twoViewers();
    live.updateSettings({ ...live.snapshot().settings, allowViewerP2P: false });
    const url = await upgradeServer(live.access, { tracker: live.tracker });
    const tracker = await trackerSocket(url, a);
    const reply = nextJson<Record<string, unknown>>(tracker.ws);
    // Act
    tracker.ws.send(announceFrame('00'.repeat(20), 1));
    // Assert
    expect((await reply)['failure reason']).toBe('p2p not allowed');
  });

  it('turns P2P back on for every viewer, except viewers removed one by one', () => {
    // Arrange
    const { live, a, b, pageA, pageB } = twoViewers();
    live.updateSettings({ ...live.snapshot().settings, allowViewerP2P: false });
    seen(pageA);
    seen(pageB);
    // Act
    live.updateSettings({ ...live.snapshot().settings, allowViewerP2P: true });
    // Assert
    expect(received(pageA)).toEqual([{ t: 'p2p', allowed: true, forAll: true }]);
    expect(received(pageB)).toEqual([{ t: 'p2p', allowed: false, forAll: true }]);
    expect(live.access.p2pAllowed(a)).toBe(true);
    expect(live.access.p2pAllowed(b)).toBe(false);
  });

  it('a config saved with P2P off starts with P2P off', () => {
    // Act
    const { live } = makeController(inactiveDirect(), { config: { ...defaultConfig(), allowViewerP2P: false } });
    // Assert
    expect(live.access.p2pForAll).toBe(false);
  });
});
