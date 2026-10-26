import crypto from 'node:crypto';
import { BROWSER_CHECK_TTL_S } from '@swarmcast/shared';
import type { PowLevel } from './pow.js';

/**
 * "This browser already passed the browser check" cookie, so the join proof-of-work runs once
 * per browser instead of on every join. Format: `v1.<level>.<expires, unix s>.<mac>` where
 * mac = HMAC-SHA256(key, "v1|<device id>|<level>|<expires>") in base64url.
 *
 * - Bound to the device cookie: copying the cookie to another browser (another device id) fails.
 * - Records the level that was solved: when the shield asks for a higher level under attack,
 *   the browser solves again and gets a new cookie at that level.
 * - Fixed lifetime (BROWSER_CHECK_TTL_S, 30 days), not renewed on use.
 * - The key lives in secrets.json and survives new lives and restarts. "New link" and
 *   "Disconnect everyone" deliberately keep it: the check is about bots, not about who may watch
 *   (the link, the ticket and bans decide that, and they are always checked first).
 * - It only skips the proof-of-work; it never lets a browser past the link/ticket check or a ban.
 */
export class BrowserVerification {
  private readonly key: Buffer;

  constructor(
    key: string | Buffer,
    private readonly now: () => number = Date.now,
    private readonly ttlS = BROWSER_CHECK_TTL_S,
  ) {
    this.key = typeof key === 'string' ? Buffer.from(key, 'hex') : key;
    if (this.key.length < 32) throw new Error('browser check key must be at least 32 bytes');
  }

  issue(deviceId: string, level: 1 | 2): string {
    const exp = Math.floor(this.now() / 1000) + this.ttlS;
    return `v1.${level}.${exp}.${this.mac(deviceId, level, exp)}`;
  }

  /** Level the browser solved (1 or 2), or 0 when the cookie is missing, invalid, expired or for another device. */
  level(token: string | undefined, deviceId: string | undefined): PowLevel {
    if (!token || !deviceId || token.length > 200) return 0;
    const m = /^v1\.([12])\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!m) return 0;
    const level = Number(m[1]) as 1 | 2;
    const exp = Number(m[2]);
    const nowS = this.now() / 1000;
    // Expired, or further in the future than we ever issue (a minute of clock slack).
    if (exp <= nowS || exp > nowS + this.ttlS + 60) return 0;
    const expected = Buffer.from(this.mac(deviceId, level, exp), 'base64url');
    const given = Buffer.from(m[3]!, 'base64url');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return 0;
    return level;
  }

  /** The cookie covers the level required now (always true when no check is required). */
  covers(token: string | undefined, deviceId: string | undefined, required: PowLevel): boolean {
    return required === 0 || this.level(token, deviceId) >= required;
  }

  private mac(deviceId: string, level: number, exp: number): string {
    return crypto.createHmac('sha256', this.key).update(`v1|${deviceId}|${level}|${exp}`).digest('base64url');
  }
}
