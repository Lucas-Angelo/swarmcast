import { solveChallenge, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/web/sha';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_COOKIE, TICKET_COOKIE, securitySettingsSchema, settingsSchema } from '@swarmcast/shared';
import { configSchema, defaultConfig, type AppConfig } from '../../src/core/config.js';
import type { LiveController } from '../../src/core/live.js';
import type { DirectMode } from '../../src/direct/direct.js';
import { makeController } from './live-helpers.js';

const direct = { noteViewer: vi.fn(), snapshot: () => ({ active: false, viewersSeen: 0 }), active: false, ipChanged: null } as unknown as DirectMode;

function setup(ports = { rtmp: 39361, public: 39362, admin: 39363, mediamtxHls: 39364 }) {
  let now = 1_800_000_000_000;
  const saved: AppConfig[] = [];
  const config = defaultConfig();
  config.ports = ports;
  const { live } = makeController(direct, { config, now: () => now, saveConfig: (c) => void saved.push(JSON.parse(JSON.stringify(c)) as AppConfig) });
  const advance = (ms = 1000): void => {
    now += ms;
    live.shield.tick();
  };
  return { live, saved, advance, base: `http://127.0.0.1:${ports.public}` };
}

const lives: LiveController[] = [];
afterEach(async () => {
  for (const l of lives.splice(0)) await l.stop().catch(() => {});
});

describe('settings round-trip: admission limits and protection switches', () => {
  it('max viewers / sessions per browser are validated, persisted and applied to new joins only', () => {
    const { live, saved } = setup();
    live.access.begin();
    for (const n of ['a', 'b', 'c']) live.access.createSession({ nickname: n, deviceId: `dev-${n}`, device: 'desktop', ip: '1.1.1.1' });
    const body = settingsSchema.parse({ ...live.snapshot().settings, maxViewers: 2, maxSessionsPerDevice: 1 });
    live.updateSettings(body);
    expect(live.snapshot().settings).toMatchObject({ maxViewers: 2, maxSessionsPerDevice: 1 });
    expect(saved.at(-1)).toMatchObject({ maxViewers: 2, maxSessionsPerDevice: 1 });
    expect(configSchema.parse(saved.at(-1))).toMatchObject({ maxViewers: 2, maxSessionsPerDevice: 1 });
    // Lowering the cap never drops anyone already watching; new people get "full".
    expect(live.access.sessions.size).toBe(3);
    expect(live.access.admit('dev-new', live.shield.effectiveLimits().maxViewers, live.shield.effectiveLimits().maxSessionsPerDevice)).toBe('full');
    // Omitted values are kept (older panels / API clients).
    live.updateSettings(settingsSchema.parse({ uploadLimitMbps: 10, autoStopMinutes: 10, alsoStreamingElsewhere: false }));
    expect(live.snapshot().settings.maxViewers).toBe(2);
    for (const bad of [{ maxViewers: 0 }, { maxViewers: 100_001 }, { maxSessionsPerDevice: 0 }, { maxSessionsPerDevice: 21 }, { maxViewers: 1.5 }]) {
      expect(settingsSchema.safeParse({ ...live.snapshot().settings, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('protection switches have safe defaults and round-trip through config', () => {
    const { live, saved } = setup();
    expect(live.snapshot().security.settings).toEqual({
      blockKnownBadIps: true,
      requireBrowserCheck: false,
      autoTighten: true,
      autoBrowserCheck: true,
      autoNewLink: false,
      autoSecureFromDirect: true,
      autoStopIfDirectFails: true,
      stopOnAttack: false,
    });
    const next = securitySettingsSchema.parse({ ...live.snapshot().security.settings, requireBrowserCheck: true, autoNewLink: true, blockKnownBadIps: false });
    live.updateSecurity(next);
    expect(live.snapshot().security.settings).toEqual(next);
    const reloaded = configSchema.parse(saved.at(-1));
    expect(reloaded.security).toMatchObject(next);
    expect(reloaded.security.blocklists).toEqual(['spamhaus-drop', 'spamhaus-drop-v6', 'firehol-level1']);
    expect(live.snapshot().security.browserCheck).toBe(1);
    expect(securitySettingsSchema.safeParse({ ...next, stopOnAttack: 'yes' }).success).toBe(false);
    expect(configSchema.safeParse({ security: { extraBlocklistUrls: ['http://insecure.example/list.txt'] } }).success).toBe(false);
  });
});

describe('attack flow through the real public server', () => {
  it('a flood of invalid /join links → warning, tighter limits and proof-of-work; a real viewer still joins', async () => {
    const { live, advance, base } = setup();
    lives.push(live);
    await live.start();
    // Drive the detector with the fake clock only.
    clearInterval((live.shield as unknown as { timer: NodeJS.Timeout }).timer);

    const statuses: number[] = [];
    for (let s = 0; s < 8; s++) {
      const res = await Promise.all(Array.from({ length: 30 }, (_, j) => fetch(`${base}/join/not-the-secret-${s}-${j}`)));
      statuses.push(...res.map((r) => r.status));
      advance();
    }
    // Per-IP join limit (120/min, generous for mobile CGNAT), divided once the shield tightens.
    expect(statuses.filter((x) => x === 404).length).toBeLessThanOrEqual(120);
    expect(statuses.filter((x) => x === 429).length).toBeGreaterThan(100);

    const snap = live.snapshot();
    expect(live.shield.detector.state).toBe('attack');
    expect(snap.warningCodes[0]).toMatchObject({ code: 'warn.attackDetected' });
    expect(snap.warnings[0]).toMatch(/^Possible attack: /);
    expect(snap.security).toMatchObject({ threat: 'attack', browserCheck: 2, tightened: true, effectiveMaxSessionsPerDevice: 1 });
    expect(snap.security.effectiveMaxViewers).toBeLessThan(snap.settings.maxViewers!);
    const codes = live.activity.list().map((e) => e.code);
    expect(codes).toEqual(expect.arrayContaining(['log.attackDetected', 'log.react.tightened', 'log.react.browserCheck']));

    // A viewer who opened the real link (ticket cookie) must now pass the browser check.
    const cookie = `${TICKET_COOKIE}=${await live.access.issueTicket()}; ${DEVICE_COOKIE}=device-abcdefghijklmnop`;
    const post = (body: unknown): Promise<Response> =>
      fetch(`${base}/api/join`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const challengeRes = await fetch(`${base}/api/join/challenge`, { headers: { cookie } });
    const challenge = (await challengeRes.json()) as { required: boolean; challenge: Challenge };
    expect(challenge.required).toBe(true);

    const refused = await post({ nickname: 'Ana' });
    expect(refused.status).toBe(403);
    const refusedBody = (await refused.json()) as { code: string; pow: Challenge };
    expect(refusedBody.code).toBe('viewer.err.checkRequired');
    const solution = await solveChallenge({ challenge: refusedBody.pow, deriveKey });
    const pow = { challenge: refusedBody.pow, solution };
    const ok = await post({ nickname: 'Ana', pow });
    expect(ok.status).toBe(200);
    expect([...live.access.sessions.values()].map((s) => s.nickname)).toEqual(['Ana']);
    // The same proof cannot be used twice.
    const replay = await post({ nickname: 'Bia', pow });
    expect(replay.status).toBe(403);

    // "End alert" → back to normal right away.
    live.clearAttackAlert();
    expect(live.snapshot().security).toMatchObject({ threat: 'normal', browserCheck: 0, tightened: false });
    expect(live.snapshot().warningCodes.map((w) => w.code)).not.toContain('warn.attackDetected');
  });

  it('refuses IPs on the public blocklists on /join, /api/join and WebSocket upgrades (counted, logged as a prefix)', async () => {
    const { PublicBlocklists } = await import('../../src/security/blocklists.js');
    const { silentLog } = await import('./helpers.js');
    const bl = new PublicBlocklists({ dir: '/nonexistent', log: silentLog, sources: () => [] });
    bl.enabled = true;
    // Loopback is never blocked, so simulate a listed public client.
    vi.spyOn(bl, 'isBlocked').mockImplementation((ip) => ip === '127.0.0.1');
    const config = defaultConfig();
    config.ports = { rtmp: 39371, public: 39372, admin: 39373, mediamtxHls: 39374 };
    const { live } = makeController(direct, { config, blocklists: bl });
    lives.push(live);
    await live.start();
    const base = 'http://127.0.0.1:39372';
    const page = await fetch(`${base}/join/${live.access.currentSecret}`, { redirect: 'manual' });
    expect(page.status).toBe(403);
    expect(page.headers.get('x-swarmcast-refused')).toBe('blocklist');
    const api = await fetch(`${base}/api/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"nickname":"x"}' });
    expect(((await api.json()) as { code: string }).code).toBe('viewer.err.blocked');
    const { default: WebSocket } = await import('ws');
    const wsStatus = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:39372/control`, { origin: base });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve(-1));
    });
    expect(wsStatus).toBe(403);
    expect(live.snapshot().security.blockedByLists).toBe(3);
    const logged = live.activity.list().filter((e) => e.code === 'log.blocklistBlocked');
    expect(logged).toHaveLength(1); // one entry per network per 10 minutes
    expect(logged[0]!.params).toEqual({ prefix: '127.0.0.*' });
    // Switched off in the panel → not refused any more.
    live.updateSecurity({ ...live.securitySettings(), blockKnownBadIps: false });
    expect((await fetch(`${base}/join/${live.access.currentSecret}`, { redirect: 'manual' })).status).toBe(303);
  });
});

describe('controller reactions in Direct mode', () => {
  const attack = (live: LiveController, advance: () => void): void => {
    for (let i = 0; i < 6; i++) {
      live.shield.tlsError();
      live.shield.detector.record('tlsErrors', 30);
      advance();
    }
  };

  it('goes back to Secure mode at the first attack signs and explains it afterwards', async () => {
    const { live, advance } = setup();
    live.access.begin();
    live.mode = 'direct';
    const back = vi.spyOn(live, 'disableDirect').mockImplementation(async () => {
      live.mode = 'secure';
      return 'https://new.example/join/x';
    });
    const stop = vi.spyOn(live, 'stop');
    attack(live, advance);
    await vi.waitFor(() => expect(live.snapshot().warningCodes.map((w) => w.code)).toContain('react.backToSecure'));
    expect(back).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    // The detector starts over in Secure mode.
    expect(live.shield.detector.state).toBe('normal');
  });

  it('stops everything when going back fails', async () => {
    const { live, advance } = setup({ rtmp: 39381, public: 39382, admin: 39383, mediamtxHls: 39384 });
    live.access.begin();
    live.phase = 'live';
    live.mode = 'direct';
    vi.spyOn(live, 'disableDirect').mockRejectedValue(new Error('tunnel did not answer'));
    const stop = vi.spyOn(live, 'stop');
    attack(live, advance);
    await vi.waitFor(() => expect(live.snapshot().warningCodes.map((w) => w.code)).toContain('react.backToSecureFailedStopped'), { timeout: 10_000 });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(live.phase).toBe('off');
  });
});
