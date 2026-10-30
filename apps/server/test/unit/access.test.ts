import { describe, expect, it, vi } from 'vitest';
import { JOIN_TICKET_TTL_S, SESSION_TTL_S } from '@swarmcast/shared';
import { AccessControl } from '../../src/access/access.js';
import { manualClock } from './helpers.js';
import { joinViewer } from './helpers-b.js';

/** An AccessControl whose live has begun, with its first secret. */
function liveAccess(now?: () => number): { a: AccessControl; secret: string } {
  const a = new AccessControl(now);
  const secret = a.begin();
  return { a, secret };
}

/**
 * `token` with one character of its signature changed. Not one of the last two: the last
 * base64url character of a 32-byte signature carries 2 unused bits, so changing it ("...xw" to
 * "...xx") left the signature the same about once in 1000 runs, and the token still verified.
 */
function tamperSignature(token: string): string {
  const i = token.length - 10;
  return token.slice(0, i) + (token[i] === 'A' ? 'B' : 'A') + token.slice(i + 1);
}

describe('AccessControl: live link', () => {
  it('generates a 256-bit secret per live and accepts only it', () => {
    // Arrange
    const a = new AccessControl();
    // Act
    const secret = a.begin();
    // Assert
    expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
    expect(a.checkSecret(secret)).toBe(true);
    expect(a.checkSecret(secret + 'x')).toBe(false);
    expect(a.checkSecret('')).toBe(false);
  });

  it('rejects everything when not live', () => {
    // Arrange
    const { a, secret } = liveAccess();
    // Act
    a.reset();
    // Assert
    expect(a.checkSecret(secret)).toBe(false);
  });

  it('a new live invalidates the previous link', () => {
    // Arrange
    const { a, secret: first } = liveAccess();
    a.reset();
    // Act
    const second = a.begin();
    // Assert
    expect(second).not.toBe(first);
    expect(a.checkSecret(first)).toBe(false);
    expect(a.checkSecret(second)).toBe(true);
  });

  it('rotating the link rejects the old link and old join tickets, but keeps sessions', async () => {
    // Arrange
    const { a, secret: old } = liveAccess();
    const ticket = await a.issueTicket();
    const s = joinViewer(a, 'ana');
    const token = await a.issueSessionToken(s);
    // Act
    const fresh = a.rotateLink();
    // Assert
    expect(a.checkSecret(old)).toBe(false);
    expect(a.checkSecret(fresh)).toBe(true);
    expect(await a.verifyTicket(ticket)).toBe(false);
    expect((await a.verifySessionToken(token))?.session.id).toBe(s.id);
  });

  it('accepts a join ticket of the current link', async () => {
    // Arrange
    const { a } = liveAccess();
    // Act
    const ticket = await a.issueTicket();
    // Assert
    expect(await a.verifyTicket(ticket)).toBe(true);
  });
});

describe('AccessControl: sessions (JWT)', () => {
  it('issues and verifies session tokens bound to the live', async () => {
    // Arrange
    const { a } = liveAccess();
    const s = joinViewer(a, 'bob');
    // Act
    const res = await a.verifySessionToken(await a.issueSessionToken(s));
    // Assert
    expect(res?.session.nickname).toBe('bob');
    expect(res?.renew).toBe(false);
  });

  it('rejects a tampered token and no token at all', async () => {
    // Arrange
    const { a } = liveAccess();
    const token = await a.issueSessionToken(joinViewer(a, 'c'));
    // Act
    const tampered = await a.verifySessionToken(tamperSignature(token));
    const missing = await a.verifySessionToken(undefined);
    // Assert
    expect(tampered).toBeNull();
    expect(missing).toBeNull();
  });

  it('rejects tokens after stop, and from another live', async () => {
    // Arrange
    const { a } = liveAccess();
    const token = await a.issueSessionToken(joinViewer(a, 'c'));
    // Act
    a.reset();
    // Assert
    expect(await a.verifySessionToken(token)).toBeNull();
    // Act
    a.begin();
    // Assert
    expect(await a.verifySessionToken(token)).toBeNull();
  });

  it('asks for renewal when less than half the lifetime is left', async () => {
    // Arrange
    const clock = manualClock(Date.UTC(2026, 9, 26));
    const { a } = liveAccess(clock.now);
    const token = await a.issueSessionToken(joinViewer(a, 'd'));
    // Act
    clock.advance(6 * 60_000);
    // Assert
    expect((await a.verifySessionToken(token))?.renew).toBe(true);
  });

  it('session tokens and join tickets expire on the clock the live runs on', async () => {
    // Arrange
    const clock = manualClock(Date.UTC(2026, 9, 26));
    const { a } = liveAccess(clock.now);
    const token = await a.issueSessionToken(joinViewer(a, 'd'));
    const ticket = await a.issueTicket();
    // Act
    clock.advance(Math.max(SESSION_TTL_S, JOIN_TICKET_TTL_S) * 1000 + 1000);
    // Assert
    expect(await a.verifySessionToken(token)).toBeNull();
    expect(await a.verifyTicket(ticket)).toBe(false);
  });

  it('rejects a ticket used as a session token', async () => {
    // Arrange
    const { a } = liveAccess();
    const ticket = await a.issueTicket();
    // Act
    const res = await a.verifySessionToken(ticket);
    // Assert
    expect(res).toBeNull();
  });
});

describe('AccessControl: kick and P2P', () => {
  it('kick drops the session and bans the device (not the shared IP) until the live ends', async () => {
    // Arrange
    const { a } = liveAccess();
    const onKick = vi.fn();
    a.on('kicked', onKick);
    const s = joinViewer(a, 'e', { deviceId: 'dev-x', ip: '9.9.9.9' });
    const token = await a.issueSessionToken(s);
    // Act
    a.kick(s.id);
    // Assert
    expect(onKick).toHaveBeenCalledOnce();
    expect(await a.verifySessionToken(token)).toBeNull();
    expect(a.isBanned('dev-x')).toBe(true);
    expect(a.isBanned('other-device-same-ip')).toBe(false);
    // Act
    a.reset();
    // Assert
    expect(a.isBanned('dev-x')).toBe(false);
  });

  it('disconnectAll drops sessions without banning', () => {
    // Arrange
    const { a } = liveAccess();
    const s = joinViewer(a, 'f');
    // Act
    a.disconnectAll();
    // Assert
    expect(a.sessions.size).toBe(0);
    expect(a.isBanned(s.deviceId)).toBe(false);
  });

  it('setP2PAllowed toggles and records auto removal', () => {
    // Arrange
    const { a } = liveAccess();
    const s = joinViewer(a, 'g');
    s.hashFailures = 3;
    // Act
    a.setP2PAllowed(s.id, false, true);
    // Assert
    expect(s.p2pAllowed).toBe(false);
    expect(s.autoRemovedFromP2P).toBe(true);
    // Act
    a.setP2PAllowed(s.id, true);
    // Assert
    expect(s.p2pAllowed).toBe(true);
    expect(s.hashFailures).toBe(0);
  });

  it('finds sessions by peer id', () => {
    // Arrange
    const { a } = liveAccess();
    const s = joinViewer(a, 'h');
    s.peerIds.add('ab'.repeat(20));
    // Act
    const found = a.sessionByPeerId('ab'.repeat(20));
    const unknown = a.sessionByPeerId('cd'.repeat(20));
    // Assert
    expect(found?.id).toBe(s.id);
    expect(unknown).toBeUndefined();
  });
});

describe('AccessControl: admission limits', () => {
  it('refuses new sessions when the stream is full', () => {
    // Arrange
    const { a } = liveAccess();
    joinViewer(a, 'a', { deviceId: 'd1' });
    joinViewer(a, 'b', { deviceId: 'd2' });
    // Act
    const atTwo = a.admit('d3', 2, 3);
    const atThree = a.admit('d3', 3, 3);
    // Assert
    expect(atTwo).toBe('full');
    expect(atThree).toBe('ok');
  });

  it('keeps each device to a few sessions by ending its oldest', () => {
    // Arrange
    let t = 1000;
    const { a } = liveAccess(() => t++);
    const first = joinViewer(a, 'a', { deviceId: 'dev' });
    joinViewer(a, 'a', { deviceId: 'dev' });
    // Act
    const verdict = a.admit('dev', 100, 2);
    // Assert
    expect(verdict).toBe('ok');
    expect(a.sessions.has(first.id)).toBe(false);
    expect(a.sessions.size).toBe(1);
  });
});
