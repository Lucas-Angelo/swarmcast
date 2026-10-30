import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BROWSER_CHECK_TTL_S } from '@swarmcast/shared';
import { BrowserVerification } from '../../src/security/verified.js';

// The "verified" cookie remembers that a browser passed the browser check (proof-of-work), and at
// which level: `v1.<level>.<expiry>.<MAC>`, bound to the device cookie. A token issued "in the
// future", or with an expiry further away than the server ever issues (a forged huge TTL, even by
// someone with the key), is refused.

const KEY = crypto.randomBytes(32).toString('hex');
const DEV = 'device-abcdefghijklmnop';

/** A clock that moves only when the test says so. */
function clock(start = 1_800_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

/** The four dot-separated parts of a token. */
function partsOf(token: string): { ver: string; exp: string; mac: string } {
  const [ver, , exp, mac] = token.split('.') as [string, string, string, string];
  return { ver, exp, mac };
}

/**
 * The MAC with its second-to-last character changed. Not the last one: part of its bits are
 * base64 padding, so a change there can decode to the very same MAC.
 */
function flipped(mac: string): string {
  return mac.slice(0, -2) + (mac.at(-2) === 'A' ? 'B' : 'A') + mac.at(-1);
}

describe('browser check "verified" cookie', () => {
  it.each([1, 2] as const)('round-trips solved level %i for the same device', (level) => {
    // Arrange
    const v = new BrowserVerification(KEY);
    // Act
    const token = v.issue(DEV, level);
    // Assert
    expect(v.level(token, DEV)).toBe(level);
  });

  it('has the documented format', () => {
    // Act
    const token = new BrowserVerification(KEY).issue(DEV, 1);
    // Assert
    expect(token).toMatch(/^v1\.1\.\d+\.[A-Za-z0-9_-]{43}$/);
  });

  it.each([
    ['another device', 'another-device-123456'],
    ['no device cookie', undefined],
    ['an empty device cookie', ''],
  ])('is bound to the device cookie: %s gets level 0', (_what, device) => {
    // Arrange
    const v = new BrowserVerification(KEY);
    const token = v.issue(DEV, 2);
    // Act
    const level = v.level(token, device);
    // Assert
    expect(level).toBe(0);
  });

  describe('rejects tampering', () => {
    const v = new BrowserVerification(KEY);
    const token = v.issue(DEV, 1);
    const { ver, exp, mac } = partsOf(token);

    it.each([
      ['a level raised without the key', `${ver}.2.${exp}.${mac}`],
      ['a pushed expiry', `${ver}.1.${Number(exp) + 1}.${mac}`],
      ['one character of the MAC flipped', `${ver}.1.${exp}.${flipped(mac)}`],
      ['an empty token', ''],
      ['garbage', 'garbage'],
      ['another version', `v2.1.${exp}.${mac}`],
      ['a level that does not exist', `v1.3.${exp}.${mac}`],
      ['level 0', `v1.0.${exp}.${mac}`],
      ['a missing MAC', `v1.1.${exp}`],
      ['an extra part', `${token}.x`],
      ['an oversized MAC', `v1.1.1.${'A'.repeat(300)}`],
    ])('%s', (_what, forged) => {
      // Act
      const level = v.level(forged, DEV);
      // Assert
      expect(level).toBe(0);
    });

    it('a token of another key', () => {
      // Act
      const level = new BrowserVerification(crypto.randomBytes(32)).level(token, DEV);
      // Assert
      expect(level).toBe(0);
    });
  });

  it('is valid until 30 days have passed', () => {
    // Arrange
    const c = clock();
    const v = new BrowserVerification(KEY, c.now);
    const token = v.issue(DEV, 1);
    // Act
    c.advance((BROWSER_CHECK_TTL_S - 60) * 1000);
    // Assert
    expect(v.level(token, DEV)).toBe(1);
    // Act
    c.advance(61_000);
    // Assert
    expect(v.level(token, DEV)).toBe(0);
  });

  it.each([
    ['issued an hour in the future', (c: ReturnType<typeof clock>) => new BrowserVerification(KEY, () => c.now() + 3_600_000)],
    ['issued with twice the lifetime', (c: ReturnType<typeof clock>) => new BrowserVerification(KEY, c.now, BROWSER_CHECK_TTL_S * 2)],
  ])('refuses a token %s (an expiry further away than it ever issues)', (_what, issuer) => {
    // Arrange
    const c = clock();
    const v = new BrowserVerification(KEY, c.now);
    const token = issuer(c).issue(DEV, 1);
    // Act
    const level = v.level(token, DEV);
    // Assert
    expect(level).toBe(0);
  });

  it.each([
    ['level 1 covers level 1', 1, 1, true],
    ['level 1 does not cover level 2', 1, 2, false],
    ['level 2 covers level 2', 2, 2, true],
    ['level 2 covers level 1', 2, 1, true],
  ] as const)('covers the required level only when the solved level is at least as high: %s', (_what, solved, required, expected) => {
    // Arrange
    const v = new BrowserVerification(KEY);
    const token = v.issue(DEV, solved);
    // Act
    const covered = v.covers(token, DEV, required);
    // Assert
    expect(covered).toBe(expected);
  });

  it('no cookie covers no required level', () => {
    // Act
    const covered = new BrowserVerification(KEY).covers(undefined, DEV, 1);
    // Assert
    expect(covered).toBe(false);
  });

  it('nothing to skip when nothing is required', () => {
    // Act
    const covered = new BrowserVerification(KEY).covers(undefined, undefined, 0);
    // Assert
    expect(covered).toBe(true);
  });

  it('refuses short keys', () => {
    // Act
    const make = () => new BrowserVerification('abcd');
    // Assert
    expect(make).toThrow(/32 bytes/);
  });
});
