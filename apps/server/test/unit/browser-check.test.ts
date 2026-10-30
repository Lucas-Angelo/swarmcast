import crypto from 'node:crypto';
import { solveChallenge, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/web/sha';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_CHECK_TTL_S, VERIFIED_COOKIE } from '@swarmcast/shared';
import type { LiveController } from '../../src/core/live.js';
import { inactiveDirect, startController } from './live-helpers.js';

// The browser check (proof-of-work on join, security/pow.ts) against the real public server of a
// live: a browser that passed is remembered by a signed cookie (security/verified.ts) across new
// tabs, new links, "disconnect everyone" and new lives, at the level it solved.
//
// The server draws the PoW counter with crypto.randomInt; the stub below makes it draw the lowest
// counter of each level, so every solve is the same bounded work (pow.test.ts solves random ones).

beforeEach(() => {
  vi.spyOn(crypto, 'randomInt').mockImplementation(((a: number, b?: number) => (b === undefined ? 0 : a)) as typeof crypto.randomInt);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * One browser: its own cookies, for every address of `live` (cookies are not tied to a port, so a
 * new live on another port is still the same site to it). `setCookies` keeps every Set-Cookie line.
 * The jar keeps Secure cookies over plain HTTP too (a real browser would not), so a live with
 * Secure cookies can still be joined here.
 */
class Browser {
  cookies = new Map<string, string>();
  setCookies: string[] = [];
  constructor(private readonly live: LiveController) {}

  private get base(): string {
    return `http://127.0.0.1:${this.live.publicPort}`;
  }

  async fetch(p: string, init: RequestInit = {}): Promise<Response> {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(this.base + p, { ...init, redirect: 'manual', headers: { ...(init.headers as Record<string, string>), cookie } });
    for (const line of res.headers.getSetCookie()) {
      this.setCookies.push(line);
      const [pair] = line.split(';');
      const eq = pair!.indexOf('=');
      const k = pair!.slice(0, eq);
      const v = pair!.slice(eq + 1);
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(line) || v === '') this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    return res;
  }

  /** Opens the live link of now (a 303 to the join page when the link is valid). */
  open(): Promise<Response> {
    return this.fetch(`/join/${this.live.access.currentSecret}`);
  }

  async challengeRequired(): Promise<boolean> {
    const res = await this.fetch('/api/join/challenge');
    expect(res.status).toBe(200);
    return ((await res.json()) as { required: boolean }).required;
  }

  post(nickname: string, pow?: unknown): Promise<Response> {
    return this.fetch('/api/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pow ? { nickname, pow } : { nickname }) });
  }

  /** What the join page does: ask for a challenge, solve it if required, join. */
  async join(nickname: string): Promise<{ status: number; solved: boolean; code?: string }> {
    const ch = await this.fetch('/api/join/challenge');
    if (ch.status !== 200) return { status: ch.status, solved: false, code: ((await ch.json()) as { code: string }).code };
    const body = (await ch.json()) as { required: boolean; challenge?: Challenge };
    const pow = body.required ? { challenge: body.challenge!, solution: await solveChallenge({ challenge: body.challenge!, deriveKey }) } : undefined;
    const res = await this.post(nickname, pow);
    return { status: res.status, solved: !!pow, code: res.ok ? undefined : ((await res.json()) as { code: string }).code };
  }

  /** Opened the link and joined: the browser has solved the check once. */
  async verified(nickname: string): Promise<this> {
    await this.open();
    expect(await this.join(nickname)).toMatchObject({ status: 200, solved: true });
    return this;
  }
}

const live = async (secureCookies = false): Promise<LiveController> => (await startController(inactiveDirect(), { secureCookies })).live;

describe('browser check: on by default, remembered per browser', () => {
  it('is on by default: a browser without the proof is refused with a challenge', async () => {
    // Arrange
    const l = await live();
    const a = new Browser(l);
    // Act
    const opened = await a.open();
    const required = await a.challengeRequired();
    const refused = await a.post('Ana');
    // Assert
    expect(l.shield.powLevel()).toBe(1);
    expect(opened.status).toBe(303);
    expect(required).toBe(true);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe('viewer.err.checkRequired');
    expect(a.cookies.has(VERIFIED_COOKIE)).toBe(false);
  });

  it('a solved check sets the "verified" cookie: BROWSER_CHECK_TTL_S long, HttpOnly, Lax, site-wide, level 1', async () => {
    // Arrange
    const a = new Browser(await live());
    await a.open();
    // Act
    const joined = await a.join('Ana');
    // Assert
    expect(joined).toMatchObject({ status: 200, solved: true });
    const set = a.setCookies.find((c) => c.startsWith(`${VERIFIED_COOKIE}=`))!;
    expect(set).toMatch(new RegExp(`Max-Age=${BROWSER_CHECK_TTL_S}`));
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Lax/);
    expect(set).toMatch(/Path=\//);
    expect(set).not.toMatch(/Secure/);
    expect(a.cookies.get(VERIFIED_COOKIE)).toMatch(/^v1\.1\./);
  });

  it('a second tab (same cookies) opening the same link skips the check', async () => {
    // Arrange
    const a = await new Browser(await live()).verified('Ana');
    // Act
    const opened = await a.open();
    const required = await a.challengeRequired();
    const joined = await a.join('Ana2');
    // Assert
    expect(opened.status).toBe(303);
    expect(required).toBe(false);
    expect(joined).toMatchObject({ status: 200, solved: false });
  });

  it('"New link" and "Disconnect everyone" do not forget the browser, but the new link is still required', async () => {
    // Arrange
    const l = await live();
    const a = await new Browser(l).verified('Ana');
    // Act
    l.rotateLink();
    l.access.disconnectAll();
    const withOldLink = await a.join('Ana3');
    // Assert
    expect(withOldLink).toMatchObject({ status: 403, code: 'viewer.err.linkInvalid' });
    // Act
    const opened = await a.open();
    const withNewLink = await a.join('Ana3');
    // Assert
    expect(opened.status).toBe(303);
    expect(withNewLink).toMatchObject({ status: 200, solved: false });
  });

  it('another browser has to solve; copying the cookie without the device cookie does not help', async () => {
    // Arrange
    const l = await live();
    const a = await new Browser(l).verified('Ana');
    const b = new Browser(l);
    await b.open();
    // Act
    b.cookies.set(VERIFIED_COOKIE, a.cookies.get(VERIFIED_COOKIE)!);
    const required = await b.challengeRequired();
    const joined = await b.post('Bia');
    // Assert
    expect(required).toBe(true);
    expect(joined.status).toBe(403);
  });

  it('a new live (same app) still remembers the browser', async () => {
    // Arrange
    const l = await live();
    const a = await new Browser(l).verified('Ana');
    // Act
    await l.stop();
    await l.start();
    const opened = await a.open();
    const joined = await a.join('Ana4');
    // Assert
    expect(opened.status).toBe(303);
    expect(joined).toMatchObject({ status: 200, solved: false });
  });

  it('under attack (level 2) a level-1 browser solves again and is remembered at level 2', async () => {
    // Arrange
    const l = await live();
    const a = await new Browser(l).verified('Ana');
    // Act
    l.shield.setAutoPow(2);
    await a.open();
    const required = await a.challengeRequired();
    const withLevel1Cookie = await a.post('Ana2');
    const solvedAgain = await a.join('Ana2');
    // Assert
    expect(l.shield.powLevel()).toBe(2);
    expect(required).toBe(true);
    expect(withLevel1Cookie.status).toBe(403);
    expect(solvedAgain).toMatchObject({ status: 200, solved: true });
    expect(a.cookies.get(VERIFIED_COOKIE)).toMatch(/^v1\.2\./);
    // Act
    await a.open();
    const remembered = await a.join('Ana3');
    // Assert
    expect(remembered).toMatchObject({ status: 200, solved: false });
  });

  it('back to normal, a level-2 cookie covers level 1 too', async () => {
    // Arrange
    const l = await live();
    l.shield.setAutoPow(2);
    const a = await new Browser(l).verified('Ana');
    // Act
    l.shield.setAutoPow(0);
    await a.open();
    const joined = await a.join('Ana4');
    // Assert
    expect(a.cookies.get(VERIFIED_COOKIE)).toMatch(/^v1\.2\./);
    expect(joined).toMatchObject({ status: 200, solved: false });
  });

  it('a kicked (banned) device stays blocked even though its browser was verified', async () => {
    // Arrange
    const l = await live();
    const a = await new Browser(l).verified('Troll');
    await a.open();
    const session = [...l.access.sessions.values()].find((s) => s.nickname === 'Troll')!;
    // Act
    l.access.kick(session.id);
    const withSpareTicket = await a.join('Troll2');
    const reopened = await a.open();
    // Assert
    expect(withSpareTicket).toMatchObject({ status: 403, code: 'viewer.err.linkInvalid' });
    expect(reopened.status).toBe(403);
  });

  it('turning the check off simply stops requiring it', async () => {
    // Arrange
    const l = await live();
    const b = new Browser(l);
    // Act
    l.updateSecurity({ ...l.securitySettings(), requireBrowserCheck: false });
    await b.open();
    const required = await b.challengeRequired();
    const joined = await b.join('Bia');
    // Assert
    expect(required).toBe(false);
    expect(joined).toMatchObject({ status: 200, solved: false });
    expect(b.cookies.has(VERIFIED_COOKIE)).toBe(false);
  });

  it('the cookie is Secure when the other cookies are', async () => {
    // Arrange
    const a = new Browser(await live(true));
    await a.open();
    // Act
    const joined = await a.join('Ana');
    // Assert
    expect(joined).toMatchObject({ status: 200, solved: true });
    const set = a.setCookies.filter((c) => /^sc_(verified|device|session)=/.test(c));
    expect(set).toHaveLength(3);
    for (const c of set) expect(c).toMatch(/; Secure/);
  });

  it('a tampered cookie is ignored', async () => {
    // Arrange
    const a = await new Browser(await live()).verified('Ana');
    // Act
    a.cookies.set(VERIFIED_COOKIE, a.cookies.get(VERIFIED_COOKIE)!.replace(/^v1\.1\./, 'v1.2.'));
    await a.open();
    const required = await a.challengeRequired();
    const joined = await a.post('Ana2');
    // Assert
    expect(required).toBe(true);
    expect(joined.status).toBe(403);
  });
});
