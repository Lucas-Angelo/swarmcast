import { describe, expect, it, vi } from 'vitest';
import { AccessControl } from '../../src/access/access.js';

describe('AccessControl: live link', () => {
  it('generates a 256-bit secret per live and accepts only it', () => {
    const a = new AccessControl();
    const secret = a.begin();
    expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
    expect(a.checkSecret(secret)).toBe(true);
    expect(a.checkSecret(secret + 'x')).toBe(false);
    expect(a.checkSecret('')).toBe(false);
  });

  it('rejects everything when not live', () => {
    const a = new AccessControl();
    const secret = a.begin();
    a.reset();
    expect(a.checkSecret(secret)).toBe(false);
  });

  it('a new live invalidates the previous link', () => {
    const a = new AccessControl();
    const first = a.begin();
    a.reset();
    const second = a.begin();
    expect(second).not.toBe(first);
    expect(a.checkSecret(first)).toBe(false);
    expect(a.checkSecret(second)).toBe(true);
  });

  it('rotating the link rejects the old link and old join tickets, but keeps sessions', async () => {
    const a = new AccessControl();
    const old = a.begin();
    const ticket = await a.issueTicket();
    expect(await a.verifyTicket(ticket)).toBe(true);
    const s = a.createSession({ nickname: 'ana', deviceId: 'dev-1', device: 'desktop', ip: '1.2.3.4' });
    const token = await a.issueSessionToken(s);

    const fresh = a.rotateLink();
    expect(a.checkSecret(old)).toBe(false);
    expect(a.checkSecret(fresh)).toBe(true);
    expect(await a.verifyTicket(ticket)).toBe(false);
    expect((await a.verifySessionToken(token))?.session.id).toBe(s.id);
  });
});

describe('AccessControl: sessions (JWT)', () => {
  it('issues and verifies session tokens bound to the live', async () => {
    const a = new AccessControl();
    a.begin();
    const s = a.createSession({ nickname: 'bob', deviceId: 'd', device: 'mobile', ip: 'ip' });
    const token = await a.issueSessionToken(s);
    const res = await a.verifySessionToken(token);
    expect(res?.session.nickname).toBe('bob');
    expect(res?.renew).toBe(false);
  });

  it('rejects tokens after stop, from another live, or tampered', async () => {
    const a = new AccessControl();
    a.begin();
    const s = a.createSession({ nickname: 'c', deviceId: 'd', device: 'desktop', ip: 'ip' });
    const token = await a.issueSessionToken(s);
    expect(await a.verifySessionToken(token.slice(0, -2) + 'xx')).toBeNull();
    expect(await a.verifySessionToken(undefined)).toBeNull();
    a.reset();
    expect(await a.verifySessionToken(token)).toBeNull();
    a.begin();
    expect(await a.verifySessionToken(token)).toBeNull();
  });

  it('asks for renewal when less than half the lifetime is left', async () => {
    let now = Date.now();
    const a = new AccessControl(() => now);
    a.begin();
    const s = a.createSession({ nickname: 'd', deviceId: 'd', device: 'desktop', ip: 'ip' });
    const token = await a.issueSessionToken(s);
    now += 6 * 60_000;
    expect((await a.verifySessionToken(token))?.renew).toBe(true);
  });

  it('rejects a ticket used as a session token', async () => {
    const a = new AccessControl();
    a.begin();
    expect(await a.verifySessionToken(await a.issueTicket())).toBeNull();
  });
});

describe('AccessControl: kick and P2P', () => {
  it('kick drops the session and bans the device (not the shared IP) until the live ends', async () => {
    const a = new AccessControl();
    a.begin();
    const onKick = vi.fn();
    a.on('kicked', onKick);
    const s = a.createSession({ nickname: 'e', deviceId: 'dev-x', device: 'desktop', ip: '9.9.9.9' });
    const token = await a.issueSessionToken(s);
    a.kick(s.id);
    expect(onKick).toHaveBeenCalledOnce();
    expect(await a.verifySessionToken(token)).toBeNull();
    expect(a.isBanned('dev-x')).toBe(true);
    expect(a.isBanned('other-device-same-ip')).toBe(false);
    a.reset();
    expect(a.isBanned('dev-x')).toBe(false);
  });

  it('disconnectAll drops sessions without banning', async () => {
    const a = new AccessControl();
    a.begin();
    const s = a.createSession({ nickname: 'f', deviceId: 'dev', device: 'desktop', ip: 'ip' });
    a.disconnectAll();
    expect(a.sessions.size).toBe(0);
    expect(a.isBanned(s.deviceId)).toBe(false);
  });

  it('setP2PAllowed toggles and records auto removal', () => {
    const a = new AccessControl();
    a.begin();
    const s = a.createSession({ nickname: 'g', deviceId: 'dev', device: 'desktop', ip: 'ip' });
    s.hashFailures = 3;
    a.setP2PAllowed(s.id, false, true);
    expect(s.p2pAllowed).toBe(false);
    expect(s.autoRemovedFromP2P).toBe(true);
    a.setP2PAllowed(s.id, true);
    expect(s.p2pAllowed).toBe(true);
    expect(s.hashFailures).toBe(0);
  });

  it('finds sessions by peer id', () => {
    const a = new AccessControl();
    a.begin();
    const s = a.createSession({ nickname: 'h', deviceId: 'dev', device: 'desktop', ip: 'ip' });
    s.peerIds.add('ab'.repeat(20));
    expect(a.sessionByPeerId('ab'.repeat(20))?.id).toBe(s.id);
    expect(a.sessionByPeerId('cd'.repeat(20))).toBeUndefined();
  });
});

describe('AccessControl: admission limits', () => {
  it('refuses new sessions when the stream is full', () => {
    const a = new AccessControl();
    a.begin();
    a.createSession({ nickname: 'a', deviceId: 'd1', device: 'desktop', ip: 'ip' });
    a.createSession({ nickname: 'b', deviceId: 'd2', device: 'desktop', ip: 'ip' });
    expect(a.admit('d3', 2, 3)).toBe('full');
    expect(a.admit('d3', 3, 3)).toBe('ok');
  });

  it('keeps each device to a few sessions by ending its oldest', () => {
    let now = 1000;
    const a = new AccessControl(() => now++);
    a.begin();
    const first = a.createSession({ nickname: 'a', deviceId: 'dev', device: 'desktop', ip: 'ip' });
    a.createSession({ nickname: 'a', deviceId: 'dev', device: 'desktop', ip: 'ip' });
    expect(a.admit('dev', 100, 2)).toBe('ok');
    expect(a.sessions.has(first.id)).toBe(false);
    expect(a.sessions.size).toBe(1);
  });
});
