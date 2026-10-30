import type http from 'node:http';
import { computeInfoHash } from 'p2p-media-loader-core/server';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type WebSocket from 'ws';
import { AccessControl } from '../../src/access/access.js';
import { MAX_OFFERS_PER_ANNOUNCE, TrackerService, infoHashHexFor, streamSwarmIdFor, variantInfoHashHex } from '../../src/tracker/tracker.js';
import { silentLog } from './helpers.js';
import { announceFrame, joinViewer, nextJson, peerHex, roundTrip, trackerSocket, upgradeServer } from './helpers-b.js';

// The embedded WebTorrent tracker is the only signaling path between viewers, so refusing a session
// there keeps it out of P2P. It accepts the current live's swarms only (one per served video
// variant, plus the legacy per-type ids), from sessions that may use P2P: not removed one by one,
// not on the streamer's own connection, and nobody while that address is still unknown. A socket
// keeps the peer id of its first announce (otherwise a client could "stop" or impersonate other
// peers), and an announce reaches at most MAX_OFFERS_PER_ANNOUNCE peers (each offer goes to one
// random peer: the cap limits how fast one member learns other viewers' addresses).

type Reply = Record<string, unknown>;

/** The tracker of a live that just began, its swarms allowed, reachable on /tracker. Closed when the test finishes. */
async function trackerOnline() {
  const access = new AccessControl();
  access.begin();
  const tracker = new TrackerService(access, silentLog);
  tracker.setSwarm(access.liveId);
  onTestFinished(() => tracker.close());
  const url = await upgradeServer(access, { tracker });
  return { access, tracker, url, mainSwarm: infoHashHexFor(access.liveId, 'main') };
}

/** Announces `peer` on `swarm` over `ws` and resolves with the tracker's reply. */
async function announce(ws: WebSocket, swarm: string, peer: number, extra: Record<string, unknown> = {}): Promise<Reply> {
  const reply = nextJson<Reply>(ws);
  ws.send(announceFrame(swarm, peer, extra));
  return reply;
}

/** A control socket the tracker channel would ride on: open, swallowing what it is sent. */
const carrier = { readyState: 1, OPEN: 1, send: () => {} } as unknown as WebSocket;
/** The upgrade request of that control socket (the tracker only keeps it). */
const upgradeReq = {} as http.IncomingMessage;

describe('tracker infohash allowlist', () => {
  it('matches the infohash p2p-media-loader computes for our swarm ids', () => {
    // Act
    const ascii = computeInfoHash(streamSwarmIdFor('abc', 'main'));
    // Assert
    expect(ascii).toHaveLength(20);
    expect(infoHashHexFor('abc', 'main')).toBe(Buffer.from(ascii, 'latin1').toString('hex'));
    expect(infoHashHexFor('abc', 'main')).not.toBe(infoHashHexFor('abc', 'secondary'));
    expect(infoHashHexFor('abc', 'main')).not.toBe(infoHashHexFor('abd', 'main'));
  });

  it('allowlists one swarm per height for the served variants (plus height 0 and the two legacy ids)', () => {
    // Arrange
    const tracker = new TrackerService(new AccessControl(), silentLog);
    onTestFinished(() => tracker.close());
    tracker.setSwarm('live1');
    // Act
    tracker.setVariants([1080, 720, 480]);
    // Assert
    const allowed = new Set(tracker.allowedInfoHashes());
    for (const h of [0, 480, 720, 1080]) expect(allowed.has(variantInfoHashHex('live1', h))).toBe(true);
    expect(allowed.has(variantInfoHashHex('live1', 360))).toBe(false);
    expect(allowed.size).toBe(2 + 4);
  });
});

describe('tracker filter', () => {
  it('accepts the current stream for an allowed session and maps peer ids', async () => {
    // Arrange
    const t = await trackerOnline();
    const s = joinViewer(t.access, 'a');
    const sock = await trackerSocket(t.url, s);
    // Act
    const reply = await announce(sock.ws, t.mainSwarm, 1);
    // Assert
    expect(reply['failure reason']).toBeUndefined();
    expect(s.peerIds.has(peerHex(1))).toBe(true);
  });

  it('rejects other infohashes', async () => {
    // Arrange
    const t = await trackerOnline();
    const sock = await trackerSocket(t.url, joinViewer(t.access, 'a'));
    // Act
    const reply = await announce(sock.ws, infoHashHexFor('another-live', 'main'), 2);
    // Assert
    expect(reply['failure reason']).toBe('unknown stream');
  });

  it('rejects sessions removed from P2P', async () => {
    // Arrange
    const t = await trackerOnline();
    const s = joinViewer(t.access, 'a');
    t.access.setP2PAllowed(s.id, false);
    const sock = await trackerSocket(t.url, s);
    // Act
    const reply = await announce(sock.ws, t.mainSwarm, 3);
    // Assert
    expect(reply['failure reason']).toBe('p2p not allowed');
  });

  it("rejects a session on the streamer's own connection, and records no peer id for it", async () => {
    // Arrange
    const t = await trackerOnline();
    const home = joinViewer(t.access, 'home', { device: 'mobile', ip: '203.0.113.7' });
    home.ownConnection = true;
    const sock = await trackerSocket(t.url, home);
    // Act
    const reply = await announce(sock.ws, t.mainSwarm, 7);
    // Assert
    expect(reply['failure reason']).toBe('p2p not allowed');
    expect(home.peerIds.size).toBe(0);
  });

  it("refuses a tracker channel inside /control for a session on the streamer's own connection, before it opens", async () => {
    // Arrange
    const t = await trackerOnline();
    const home = joinViewer(t.access, 'home', { device: 'mobile', ip: '203.0.113.7' });
    home.ownConnection = true;
    // Act
    const channel = t.tracker.openChannel(carrier, 1, upgradeReq, home);
    // Assert
    expect(channel).toBeNull();
    expect(t.access.p2pBlock(home)).toBe('own-connection');
  });

  it('rejects every session while the own address is unknown', async () => {
    // Arrange
    const t = await trackerOnline();
    const guest = joinViewer(t.access, 'guest');
    const sock = await trackerSocket(t.url, guest);
    t.access.p2pChecking = true;
    // Act
    const reply = await announce(sock.ws, t.mainSwarm, 8);
    const channel = t.tracker.openChannel(carrier, 2, upgradeReq, guest);
    // Assert
    expect(reply['failure reason']).toBe('p2p not allowed');
    expect(channel).toBeNull();
    expect(t.access.p2pBlock(guest)).toBe('checking');
  });

  it('accepts them again once the own address is known', async () => {
    // Arrange
    const t = await trackerOnline();
    const guest = joinViewer(t.access, 'guest');
    const sock = await trackerSocket(t.url, guest);
    t.access.p2pChecking = true;
    await announce(sock.ws, t.mainSwarm, 8);
    // Act
    t.access.p2pChecking = false;
    const reply = await announce(sock.ws, t.mainSwarm, 8);
    // Assert
    expect(reply['failure reason']).toBeUndefined();
    expect(t.access.p2pBlock(guest)).toBeUndefined();
  });

  it('rejects sessions that ended (kicked) on a socket opened before', async () => {
    // Arrange
    const t = await trackerOnline();
    const s = joinViewer(t.access, 'a');
    const sock = await trackerSocket(t.url, s);
    t.access.kick(s.id);
    // Act
    const reply = await announce(sock.ws, t.mainSwarm, 4, { event: undefined });
    // Assert
    expect(reply['failure reason']).toBe('session ended');
  });

  it('rejects a socket that switches to another peer id', async () => {
    // Arrange
    const t = await trackerOnline();
    const sock = await trackerSocket(t.url, joinViewer(t.access, 'a'));
    await announce(sock.ws, t.mainSwarm, 5);
    // Act
    const reply = await announce(sock.ws, t.mainSwarm, 6, { event: 'stopped' });
    // Assert
    expect(reply['failure reason']).toBe('peer id mismatch');
  });

  it('disconnectSession removes the peer from the swarm', async () => {
    // Arrange
    const t = await trackerOnline();
    const s = joinViewer(t.access, 'a');
    const sock = await trackerSocket(t.url, s);
    await announce(sock.ws, t.mainSwarm, 7);
    const before = t.tracker.peerCount();
    // Act
    t.tracker.disconnectSession(s.id);
    await sock.closed;
    // Assert
    expect(before).toBe(1);
    await vi.waitFor(() => expect(t.tracker.peerCount()).toBe(0));
  });
});

describe('tracker offer cap', () => {
  it('relays the offers of one announce to at most MAX_OFFERS_PER_ANNOUNCE peers', async () => {
    // Arrange
    const t = await trackerOnline();
    const waiting = [];
    for (let n = 1; n <= MAX_OFFERS_PER_ANNOUNCE + 2; n++) {
      const sock = await trackerSocket(t.url, joinViewer(t.access, `peer${n}`));
      await announce(sock.ws, t.mainSwarm, n);
      waiting.push(sock);
    }
    const offerer = await trackerSocket(t.url, joinViewer(t.access, 'offerer'));
    const offers = Array.from({ length: 40 }, (_, i) => ({ offer_id: `o${i}`, offer: { type: 'offer', sdp: 'v=0' } }));
    // Act
    const reply = await announce(offerer.ws, t.mainSwarm, 99, { numwant: 40, offers });
    await Promise.all(waiting.map((p) => roundTrip(p.ws)));
    // Assert
    const relayed = waiting.flatMap((p) => p.frames.map((f) => JSON.parse(f) as Reply)).filter((m) => m.offer !== undefined);
    expect(reply['failure reason']).toBeUndefined();
    expect(relayed).toHaveLength(MAX_OFFERS_PER_ANNOUNCE);
  });
});
