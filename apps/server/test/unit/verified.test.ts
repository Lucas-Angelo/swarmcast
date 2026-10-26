import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BROWSER_CHECK_TTL_S } from '@swarmcast/shared';
import { BrowserVerification } from '../../src/security/verified.js';

const KEY = crypto.randomBytes(32).toString('hex');
const DEV = 'device-abcdefghijklmnop';

function clock(start = 1_800_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe('browser check "verified" cookie', () => {
  it('round-trips the solved level for the same device', () => {
    const v = new BrowserVerification(KEY);
    expect(v.level(v.issue(DEV, 1), DEV)).toBe(1);
    expect(v.level(v.issue(DEV, 2), DEV)).toBe(2);
    expect(v.issue(DEV, 1)).toMatch(/^v1\.1\.\d+\.[A-Za-z0-9_-]{43}$/);
  });

  it('is bound to the device cookie', () => {
    const v = new BrowserVerification(KEY);
    const token = v.issue(DEV, 2);
    expect(v.level(token, 'another-device-123456')).toBe(0);
    expect(v.level(token, undefined)).toBe(0);
    expect(v.level(token, '')).toBe(0);
  });

  it('rejects tampering: level, expiry, MAC, format, other key', () => {
    const v = new BrowserVerification(KEY);
    const token = v.issue(DEV, 1);
    const [ver, , exp, mac] = token.split('.');
    // Raising the recorded level without the key.
    expect(v.level(`${ver}.2.${exp}.${mac}`, DEV)).toBe(0);
    // Pushing the expiry.
    expect(v.level(`${ver}.1.${Number(exp) + 1}.${mac}`, DEV)).toBe(0);
    // One character of the MAC flipped.
    const flipped = mac!.slice(0, -2) + (mac!.at(-2) === 'A' ? 'B' : 'A') + mac!.at(-1);
    expect(v.level(`${ver}.1.${exp}.${flipped}`, DEV)).toBe(0);
    for (const bad of ['', 'garbage', `v2.1.${exp}.${mac}`, `v1.3.${exp}.${mac}`, `v1.0.${exp}.${mac}`, `v1.1.${exp}`, `${token}.x`, 'v1.1.1.' + 'A'.repeat(300)]) {
      expect(v.level(bad, DEV), bad).toBe(0);
    }
    expect(new BrowserVerification(crypto.randomBytes(32)).level(token, DEV)).toBe(0);
  });

  it('expires after 30 days and refuses expiries further away than it ever issues', () => {
    const c = clock();
    const v = new BrowserVerification(KEY, c.now);
    const token = v.issue(DEV, 1);
    c.advance((BROWSER_CHECK_TTL_S - 60) * 1000);
    expect(v.level(token, DEV)).toBe(1);
    c.advance(61_000);
    expect(v.level(token, DEV)).toBe(0);

    // A token issued "in the future" (or with a forged huge TTL by someone with the key) is refused.
    const future = new BrowserVerification(KEY, () => c.now() + 3_600_000).issue(DEV, 1);
    expect(v.level(future, DEV)).toBe(0);
    const long = new BrowserVerification(KEY, c.now, BROWSER_CHECK_TTL_S * 2).issue(DEV, 1);
    expect(v.level(long, DEV)).toBe(0);
  });

  it('covers the required level only when the solved level is at least as high', () => {
    const v = new BrowserVerification(KEY);
    const l1 = v.issue(DEV, 1);
    const l2 = v.issue(DEV, 2);
    expect(v.covers(l1, DEV, 1)).toBe(true);
    expect(v.covers(l1, DEV, 2)).toBe(false);
    expect(v.covers(l2, DEV, 2)).toBe(true);
    expect(v.covers(l2, DEV, 1)).toBe(true);
    expect(v.covers(undefined, DEV, 1)).toBe(false);
    // Nothing required: nothing to skip.
    expect(v.covers(undefined, undefined, 0)).toBe(true);
  });

  it('refuses short keys', () => {
    expect(() => new BrowserVerification('abcd')).toThrow(/32 bytes/);
  });
});
