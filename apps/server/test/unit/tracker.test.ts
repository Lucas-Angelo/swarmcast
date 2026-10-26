import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { computeInfoHash } from 'p2p-media-loader-core/server';
import { AccessControl, type Session } from '../../src/access/access.js';
import { TrackerService, infoHashHexFor, streamSwarmIdFor } from '../../src/tracker/tracker.js';
import { silentLog } from './helpers.js';

const toBinary = (hex: string): string => Buffer.from(hex, 'hex').toString('latin1');
const peerAscii = (n: number): string => `-PM0400-${String(n).padStart(12, '0')}`;
const peerHex = (n: number): string => Buffer.from(peerAscii(n), 'latin1').toString('hex');

interface Env {
  server: http.Server;
  url: string;
  access: AccessControl;
  tracker: TrackerService;
}
const envs: Env[] = [];

async function setup(): Promise<Env> {
  const access = new AccessControl();
  access.begin();
  const tracker = new TrackerService(access, silentLog);
  tracker.setSwarm(access.liveId);
  const server = http.createServer();
  const sessions = new Map<string, Session>();
  server.on('upgrade', (req, socket, head) => {
    const sid = new URL(req.url!, 'http://x').searchParams.get('sid')!;
    const s = sessions.get(sid) ?? access.sessions.get(sid);
    if (!s) return socket.destroy();
    tracker.handleUpgrade(req, socket, head, s);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const env = { server, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, access, tracker };
  envs.push(env);
  return env;
}

afterEach(async () => {
  for (const e of envs.splice(0)) {
    e.tracker.close();
    await new Promise((r) => e.server.close(r));
  }
});

function announce(url: string, sid: string, infoHashHex: string, peer: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url}/?sid=${sid}`);
    ws.on('open', () => ws.send(JSON.stringify({ action: 'announce', info_hash: toBinary(infoHashHex), peer_id: peer, numwant: 0, offers: [], event: 'started' })));
    ws.on('message', (d) => {
      resolve(JSON.parse(d.toString()) as Record<string, unknown>);
      ws.close();
    });
    ws.on('error', reject);
  });
}

describe('tracker infohash allowlist', () => {
  it('matches the infohash p2p-media-loader computes for our swarm ids', () => {
    const ascii = computeInfoHash(streamSwarmIdFor('abc', 'main'));
    expect(ascii).toHaveLength(20);
    expect(infoHashHexFor('abc', 'main')).toBe(Buffer.from(ascii, 'latin1').toString('hex'));
    expect(infoHashHexFor('abc', 'main')).not.toBe(infoHashHexFor('abc', 'secondary'));
    expect(infoHashHexFor('abc', 'main')).not.toBe(infoHashHexFor('abd', 'main'));
  });
});

describe('tracker filter', () => {
  it('accepts the current stream for an allowed session and maps peer ids', async () => {
    const e = await setup();
    const s = e.access.createSession({ nickname: 'a', deviceId: 'd', device: 'desktop', ip: 'ip' });
    const res = await announce(e.url, s.id, infoHashHexFor(e.access.liveId, 'main'), peerAscii(1));
    expect(res['failure reason']).toBeUndefined();
    expect(s.peerIds.has(peerHex(1))).toBe(true);
  });

  it('rejects other infohashes', async () => {
    const e = await setup();
    const s = e.access.createSession({ nickname: 'a', deviceId: 'd', device: 'desktop', ip: 'ip' });
    const res = await announce(e.url, s.id, infoHashHexFor('another-live', 'main'), peerAscii(2));
    expect(res['failure reason']).toBe('unknown stream');
  });

  it('rejects sessions removed from P2P', async () => {
    const e = await setup();
    const s = e.access.createSession({ nickname: 'a', deviceId: 'd', device: 'desktop', ip: 'ip' });
    e.access.setP2PAllowed(s.id, false);
    const res = await announce(e.url, s.id, infoHashHexFor(e.access.liveId, 'main'), peerAscii(3));
    expect(res['failure reason']).toBe('p2p not allowed');
  });

  it('rejects sessions that ended (kicked)', async () => {
    const e = await setup();
    const s = e.access.createSession({ nickname: 'a', deviceId: 'd', device: 'desktop', ip: 'ip' });
    // Keep a reference so the upgrade still finds it, then end the session.
    const ws = new WebSocket(`${e.url}/?sid=${s.id}`);
    await new Promise((r) => ws.on('open', r));
    e.access.kick(s.id);
    const reply = await new Promise<Record<string, unknown>>((resolve) => {
      ws.on('message', (d) => resolve(JSON.parse(d.toString()) as Record<string, unknown>));
      ws.send(JSON.stringify({ action: 'announce', info_hash: toBinary(infoHashHexFor(e.access.liveId, 'main')), peer_id: peerAscii(4), numwant: 0, offers: [] }));
    });
    ws.close();
    expect(reply['failure reason']).toBe('session ended');
  });

  it('rejects a socket that switches to another peer id', async () => {
    const e = await setup();
    const s = e.access.createSession({ nickname: 'a', deviceId: 'd', device: 'desktop', ip: 'ip' });
    const ih = toBinary(infoHashHexFor(e.access.liveId, 'main'));
    const ws = new WebSocket(`${e.url}/?sid=${s.id}`);
    await new Promise((r) => ws.on('open', r));
    const replies: Record<string, unknown>[] = [];
    ws.on('message', (d) => replies.push(JSON.parse(d.toString()) as Record<string, unknown>));
    ws.send(JSON.stringify({ action: 'announce', info_hash: ih, peer_id: peerAscii(5), numwant: 0, offers: [], event: 'started' }));
    await new Promise((r) => setTimeout(r, 150));
    ws.send(JSON.stringify({ action: 'announce', info_hash: ih, peer_id: peerAscii(6), numwant: 0, offers: [], event: 'stopped' }));
    await new Promise((r) => setTimeout(r, 150));
    ws.close();
    expect(replies.some((r) => r['failure reason'] === 'peer id mismatch')).toBe(true);
  });

  it('disconnectSession removes the peer from the swarm', async () => {
    const e = await setup();
    const s = e.access.createSession({ nickname: 'a', deviceId: 'd', device: 'desktop', ip: 'ip' });
    const ws = new WebSocket(`${e.url}/?sid=${s.id}`);
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ action: 'announce', info_hash: toBinary(infoHashHexFor(e.access.liveId, 'main')), peer_id: peerAscii(7), numwant: 0, offers: [], event: 'started' }));
    await new Promise((r) => ws.once('message', r));
    expect(e.tracker.peerCount()).toBe(1);
    const closed = new Promise((r) => ws.on('close', r));
    e.tracker.disconnectSession(s.id);
    await closed;
    await new Promise((r) => setTimeout(r, 50));
    expect(e.tracker.peerCount()).toBe(0);
  });
});

describe('tracker offer cap', () => {
  it('relays at most MAX_OFFERS_PER_ANNOUNCE offers per announce', async () => {
    const { MAX_OFFERS_PER_ANNOUNCE } = await import('../../src/tracker/tracker.js');
    const e = await setup();
    const s = e.access.createSession({ nickname: 'a', deviceId: 'd', device: 'desktop', ip: 'ip' });
    const params = { socket: { sessionId: s.id }, peer_id: peerHex(9), offers: Array.from({ length: 40 }, (_, i) => ({ offer_id: String(i) })), numwant: 40 };
    const err = (e.tracker as unknown as { check(ih: string, p: unknown): Error | null }).check(infoHashHexFor(e.access.liveId, 'main'), params);
    expect(err).toBeNull();
    expect(params.offers).toHaveLength(MAX_OFFERS_PER_ANNOUNCE);
    expect(params.numwant).toBe(MAX_OFFERS_PER_ANNOUNCE);
  });
});
