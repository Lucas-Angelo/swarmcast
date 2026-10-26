import { solveChallenge, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/web/sha';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_CHECK_TTL_S, VERIFIED_COOKIE } from '@swarmcast/shared';
import { defaultConfig } from '../../src/core/config.js';
import type { LiveController } from '../../src/core/live.js';
import type { DirectMode } from '../../src/direct/direct.js';
import type { PowLevel } from '../../src/security/pow.js';
import { makeController } from './live-helpers.js';

const direct = { noteViewer: vi.fn(), snapshot: () => ({ active: false, viewersSeen: 0 }), active: false, ipChanged: null } as unknown as DirectMode;
const PORTS = { rtmp: 39411, public: 39412, admin: 39413, mediamtxHls: 39414 };
const base = `http://127.0.0.1:${PORTS.public}`;

/** One browser: its own cookies. */
class Browser {
  cookies = new Map<string, string>();
  setCookies: string[] = [];
  async fetch(p: string, init: RequestInit = {}): Promise<Response> {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(p.startsWith('http') ? p : base + p, { ...init, redirect: 'manual', headers: { ...(init.headers as Record<string, string>), cookie } });
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
  open(link: string): Promise<Response> {
    return this.fetch(link);
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
}

const forceLevel = (live: LiveController, level: PowLevel): void => (live.shield as unknown as { setAutoPow(l: PowLevel): void }).setAutoPow(level);

const lives: LiveController[] = [];
afterEach(async () => {
  for (const l of lives.splice(0)) await l.stop().catch(() => {});
});

async function start(secureCookies = false): Promise<LiveController> {
  const config = defaultConfig();
  config.ports = PORTS;
  const { live } = makeController(direct, { config, secureCookies });
  lives.push(live);
  await live.start();
  return live;
}

const link = (live: LiveController): string => `${base}/join/${live.access.currentSecret}`;

describe('browser check: on by default, remembered per browser', () => {
  it('solves once, then new tabs, new links, "disconnect everyone" and a new live skip it', async () => {
    const live = await start();
    expect(live.shield.powLevel()).toBe(1);
    const a = new Browser();
    expect((await a.open(link(live))).status).toBe(303);
    expect(await a.challengeRequired()).toBe(true);
    // No proof → refused with a challenge, as before.
    const refused = await a.post('Ana');
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe('viewer.err.checkRequired');
    expect(a.cookies.has(VERIFIED_COOKIE)).toBe(false);

    expect(await a.join('Ana')).toMatchObject({ status: 200, solved: true });
    const set = a.setCookies.find((c) => c.startsWith(`${VERIFIED_COOKIE}=`))!;
    expect(set).toMatch(new RegExp(`Max-Age=${BROWSER_CHECK_TTL_S}`));
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Lax/);
    expect(set).toMatch(/Path=\//);
    expect(set).not.toMatch(/Secure/); // plain-HTTP test server, like the other cookies
    expect(a.cookies.get(VERIFIED_COOKIE)).toMatch(/^v1\.1\./);

    // A second tab (same cookies) opening the same link.
    expect((await a.open(link(live))).status).toBe(303);
    expect(await a.challengeRequired()).toBe(false);
    expect(await a.join('Ana2')).toMatchObject({ status: 200, solved: false });

    // "New link" and "Disconnect everyone" do not forget the browser (bots, not access)…
    live.rotateLink();
    live.access.disconnectAll();
    // …but the new link is still required.
    expect(await a.join('Ana3')).toMatchObject({ status: 403, code: 'viewer.err.linkInvalid' });
    expect((await a.open(link(live))).status).toBe(303);
    expect(await a.join('Ana3')).toMatchObject({ status: 200, solved: false });

    // Another browser has to solve; copying the cookie without the device cookie does not help.
    const b = new Browser();
    await b.open(link(live));
    b.cookies.set(VERIFIED_COOKIE, a.cookies.get(VERIFIED_COOKIE)!);
    expect(await b.challengeRequired()).toBe(true);
    expect(await b.post('Bia')).toHaveProperty('status', 403);

    // A new live (same app): still remembered.
    await live.stop();
    await live.start();
    expect((await a.open(link(live))).status).toBe(303);
    expect(await a.join('Ana4')).toMatchObject({ status: 200, solved: false });
  });

  it('under attack (level 2) a level-1 browser solves again and is remembered at level 2', async () => {
    const live = await start();
    const a = new Browser();
    await a.open(link(live));
    expect(await a.join('Ana')).toMatchObject({ status: 200, solved: true });

    forceLevel(live, 2);
    expect(live.shield.powLevel()).toBe(2);
    await a.open(link(live));
    expect(await a.challengeRequired()).toBe(true);
    // The level-1 cookie alone is not enough to join.
    expect(await a.post('Ana2')).toHaveProperty('status', 403);
    expect(await a.join('Ana2')).toMatchObject({ status: 200, solved: true });
    expect(a.cookies.get(VERIFIED_COOKIE)).toMatch(/^v1\.2\./);
    await a.open(link(live));
    expect(await a.join('Ana3')).toMatchObject({ status: 200, solved: false });

    // Back to normal: the level-2 cookie covers level 1 too.
    forceLevel(live, 0);
    await a.open(link(live));
    expect(await a.join('Ana4')).toMatchObject({ status: 200, solved: false });
  });

  it('a kicked (banned) device stays blocked even though its browser was verified', async () => {
    const live = await start();
    const a = new Browser();
    await a.open(link(live));
    expect(await a.join('Troll')).toMatchObject({ status: 200, solved: true });
    // A spare ticket from before the kick.
    await a.open(link(live));
    const session = [...live.access.sessions.values()].find((s) => s.nickname === 'Troll')!;
    live.access.kick(session.id);
    expect(await a.join('Troll2')).toMatchObject({ status: 403, code: 'viewer.err.linkInvalid' });
    expect((await a.open(link(live))).status).toBe(403);
  });

  it('turning the check off simply stops requiring it', async () => {
    const live = await start();
    live.updateSecurity({ ...live.securitySettings(), requireBrowserCheck: false });
    const b = new Browser();
    await b.open(link(live));
    expect(await b.challengeRequired()).toBe(false);
    expect(await b.join('Bia')).toMatchObject({ status: 200, solved: false });
    expect(b.cookies.has(VERIFIED_COOKIE)).toBe(false);
  });

  it('the cookie is Secure when the other cookies are', async () => {
    const live = await start(true);
    const a = new Browser();
    await a.open(link(live));
    // Node's fetch ignores the Secure attribute over http, so the jar still works here.
    expect(await a.join('Ana')).toMatchObject({ status: 200, solved: true });
    const set = a.setCookies.filter((c) => /^sc_(verified|device|session)=/.test(c));
    expect(set).toHaveLength(3);
    for (const c of set) expect(c).toMatch(/; Secure/);
  });

  it('a tampered cookie is ignored', async () => {
    const live = await start();
    const a = new Browser();
    await a.open(link(live));
    await a.join('Ana');
    a.cookies.set(VERIFIED_COOKIE, a.cookies.get(VERIFIED_COOKIE)!.replace(/^v1\.1\./, 'v1.2.'));
    await a.open(link(live));
    expect(await a.challengeRequired()).toBe(true);
    expect(await a.post('Ana2')).toHaveProperty('status', 403);
  });
});
