import { solveChallenge, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/web/sha';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import WebSocket from 'ws';
import { DEVICE_COOKIE, TICKET_COOKIE, securitySettingsSchema, settingsSchema } from '@swarmcast/shared';
import { configSchema, defaultConfig, type AppConfig } from '../../src/core/config.js';
import type { LiveController } from '../../src/core/live.js';
import type { DirectMode } from '../../src/direct/direct.js';
import { PublicBlocklists } from '../../src/security/blocklists.js';
import { until } from '../../../../scripts/test/lib/wait.mjs';
import { manualClock, silentLog } from './helpers.js';
import { droppingPort, joinViewer } from './helpers-b.js';
import { inactiveDirect, makeController, startController } from './live-helpers.js';

// The protection settings and the attack flow through the real public server (port 0) and the
// live controller's reactions.
// - Admission limits are validated and saved; lowering the cap never drops anyone already watching
//   (new people get "full"); values an older panel or API client leaves out are kept.
// - The per-IP join limit (120 a minute, generous for mobile CGNAT) is divided once the shield
//   tightens. A flood of invalid /join links turns on tighter limits and the strong browser check;
//   a viewer with the real link must then solve it, once ("End alert" goes back to normal at once,
//   the light check that is on by default stays).
// - Loopback is never on a blocklist, so the blocklist test makes 127.0.0.1 a listed public client.
// - In Direct mode, the first attack signs go back to Secure mode; when that fails, Stop
//   everything. That stop verifies its ports and the public address: Direct mode's address is a
//   local port that drops connections, so the check answers at once (a documentation address
//   would wait out the probe's 5 s timeout).
//
// The live's clock moves only by `advance()`, which also runs one shield sample (once a second in
// the app). Its periodic work (that sampling, the stats and quality ticks) is frozen with fake
// intervals, so nothing samples on its own.

/** How long a reaction may take to show in the panel: it is a few milliseconds of work, plus a Stop's port checks. */
const REACTION_TIMEOUT_MS = 5000;

/** Periodic work does not run on its own; restored when the test finishes. */
function freezePeriodicWork(): void {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  onTestFinished(() => void vi.useRealTimers());
}

/** The live's dependencies here: a clock that moves only by hand, every config it saves kept in `saved` (port 0 unless `ports`). */
function liveDeps(o: { ports?: AppConfig['ports']; blocklists?: PublicBlocklists } = {}) {
  const clock = manualClock(1_800_000_000_000);
  const saved: AppConfig[] = [];
  const config = defaultConfig();
  config.ports = o.ports ?? { rtmp: 0, public: 0, admin: 0, mediamtxHls: 0 };
  const over = { config, now: clock.now, saveConfig: (c: AppConfig) => void saved.push(JSON.parse(JSON.stringify(c)) as AppConfig), ...(o.blocklists ? { blocklists: o.blocklists } : {}) };
  return { clock, saved, over };
}

/** A live that is never started, for the settings: its ports are the defaults (>= 1), so a saved config passes the config schema. */
function idleLive() {
  const d = liveDeps({ ports: defaultConfig().ports });
  return { live: makeController(inactiveDirect(), d.over).live, saved: d.saved };
}

/** A started live whose clock moves only by `advance(ms)`, which also runs one shield sample. Stopped when the test finishes. */
async function startedLive(o: { direct?: DirectMode; blocklists?: PublicBlocklists } = {}) {
  const d = liveDeps(o);
  const { live } = await startController(o.direct ?? inactiveDirect(), d.over);
  const advance = (ms = 1000): void => {
    d.clock.advance(ms);
    live.shield.tick();
  };
  return { live, advance };
}

/**
 * Eight seconds of a flood of invalid /join links on `live`'s public server: 30 at once each
 * second, then one shield sample (`advance`). The statuses the flood got.
 */
async function floodInvalidLinks(live: LiveController, advance: () => void): Promise<number[]> {
  const base = `http://127.0.0.1:${live.publicPort}`;
  const statuses: number[] = [];
  for (let s = 0; s < 8; s++) {
    const res = await Promise.all(Array.from({ length: 30 }, (_, j) => fetch(`${base}/join/not-the-secret-${s}-${j}`)));
    statuses.push(...res.map((r) => r.status));
    advance();
  }
  return statuses;
}

/** Resolves once the panel shows the warning `code`. */
function warningShown(live: LiveController, code: string): Promise<void> {
  return until(() => live.snapshot().warningCodes.some((w) => w.code === code), { timeoutMs: REACTION_TIMEOUT_MS, what: `the "${code}" warning`, on: [[live, 'state']] });
}

describe('settings round-trip: admission limits and protection switches', () => {
  it('saves and applies new admission limits', () => {
    // Arrange
    const { live, saved } = idleLive();
    const body = settingsSchema.parse({ ...live.snapshot().settings, maxViewers: 2, maxSessionsPerDevice: 1 });
    // Act
    live.updateSettings(body);
    // Assert
    expect(live.snapshot().settings).toMatchObject({ maxViewers: 2, maxSessionsPerDevice: 1 });
    expect(saved.at(-1)).toMatchObject({ maxViewers: 2, maxSessionsPerDevice: 1 });
    expect(configSchema.parse(saved.at(-1))).toMatchObject({ maxViewers: 2, maxSessionsPerDevice: 1 });
  });

  it('lowering the cap never drops anyone already watching; new people get "full"', () => {
    // Arrange
    const { live } = idleLive();
    live.access.begin();
    for (const n of ['a', 'b', 'c']) joinViewer(live.access, n, { ip: '1.1.1.1' });
    // Act
    live.updateSettings(settingsSchema.parse({ ...live.snapshot().settings, maxViewers: 2, maxSessionsPerDevice: 1 }));
    // Assert
    const limits = live.shield.effectiveLimits();
    expect(live.access.sessions.size).toBe(3);
    expect(live.access.admit('dev-new', limits.maxViewers, limits.maxSessionsPerDevice)).toBe('full');
  });

  it('values an older panel or API client leaves out are kept', () => {
    // Arrange
    const { live } = idleLive();
    live.updateSettings(settingsSchema.parse({ ...live.snapshot().settings, maxViewers: 2, maxSessionsPerDevice: 1 }));
    // Act
    live.updateSettings(settingsSchema.parse({ uploadLimitMbps: 10, autoStopMinutes: 10, alsoStreamingElsewhere: false }));
    // Assert
    expect(live.snapshot().settings.maxViewers).toBe(2);
  });

  it.each([{ maxViewers: 0 }, { maxViewers: 100_001 }, { maxSessionsPerDevice: 0 }, { maxSessionsPerDevice: 21 }, { maxViewers: 1.5 }])('refuses the admission limit %j', (bad) => {
    // Arrange
    const { live } = idleLive();
    // Act
    const r = settingsSchema.safeParse({ ...live.snapshot().settings, ...bad });
    // Assert
    expect(r.success).toBe(false);
  });

  it('protection switches have safe defaults', () => {
    // Arrange
    const { live } = idleLive();
    // Act
    const security = live.snapshot().security;
    // Assert
    expect(security.browserCheck).toBe(1);
    expect(security.settings).toEqual({
      blockKnownBadIps: true,
      requireBrowserCheck: true,
      autoTighten: true,
      autoBrowserCheck: true,
      autoNewLink: false,
      autoSecureFromDirect: true,
      autoStopIfDirectFails: true,
      stopOnAttack: false,
    });
  });

  it('protection switches round-trip through config', () => {
    // Arrange
    const { live, saved } = idleLive();
    const next = securitySettingsSchema.parse({ ...live.snapshot().security.settings, requireBrowserCheck: false, autoNewLink: true, blockKnownBadIps: false });
    // Act
    live.updateSecurity(next);
    // Assert
    expect(live.snapshot().security.settings).toEqual(next);
    const reloaded = configSchema.parse(saved.at(-1));
    expect(reloaded.security).toMatchObject(next);
    expect(reloaded.security.blocklists).toEqual(['spamhaus-drop', 'spamhaus-drop-v6', 'firehol-level1']);
    expect(live.snapshot().security.browserCheck).toBe(0);
  });

  it('refuses a protection switch that is not a boolean', () => {
    // Arrange
    const { live } = idleLive();
    // Act
    const r = securitySettingsSchema.safeParse({ ...live.securitySettings(), stopOnAttack: 'yes' });
    // Assert
    expect(r.success).toBe(false);
  });

  it('refuses an extra blocklist over plain HTTP', () => {
    // Act
    const r = configSchema.safeParse({ security: { extraBlocklistUrls: ['http://insecure.example/list.txt'] } });
    // Assert
    expect(r.success).toBe(false);
  });
});

describe('attack flow through the real public server', () => {
  it('a flood of invalid /join links → warning, tighter limits and proof-of-work', async () => {
    // Arrange
    freezePeriodicWork();
    const { live, advance } = await startedLive();
    // Act
    const statuses = await floodInvalidLinks(live, advance);
    // Assert
    expect(statuses.filter((x) => x === 404).length).toBeLessThanOrEqual(120);
    expect(statuses.filter((x) => x === 429).length).toBeGreaterThan(100);
    const snap = live.snapshot();
    expect(live.shield.detector.state).toBe('attack');
    expect(snap.warningCodes[0]).toMatchObject({ code: 'warn.attackDetected' });
    expect(snap.warnings[0]).toMatch(/^Possible attack: /);
    expect(snap.security).toMatchObject({ threat: 'attack', browserCheck: 2, tightened: true, effectiveMaxSessionsPerDevice: 1 });
    expect(snap.security.effectiveMaxViewers).toBeLessThan(snap.settings.maxViewers!);
    expect(live.activity.list().map((e) => e.code)).toEqual(expect.arrayContaining(['log.attackDetected', 'log.react.tightened', 'log.react.browserCheck']));
  });

  it('under that attack a viewer with the real link solves the strong check, once; "End alert" goes back to normal', async () => {
    // Arrange
    freezePeriodicWork();
    const { live, advance } = await startedLive();
    await floodInvalidLinks(live, advance);
    const base = `http://127.0.0.1:${live.publicPort}`;
    const cookie = `${TICKET_COOKIE}=${await live.access.issueTicket()}; ${DEVICE_COOKIE}=device-abcdefghijklmnop`;
    const post = (body: unknown): Promise<Response> => fetch(`${base}/api/join`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    // Act
    const challenge = (await (await fetch(`${base}/api/join/challenge`, { headers: { cookie } })).json()) as { required: boolean; challenge: Challenge };
    const refused = await post({ nickname: 'Ana' });
    const refusedBody = (await refused.json()) as { code: string; pow: Challenge };
    // Assert
    expect(challenge.required).toBe(true);
    expect(refused.status).toBe(403);
    expect(refusedBody.code).toBe('viewer.err.checkRequired');
    // Act
    const pow = { challenge: refusedBody.pow, solution: await solveChallenge({ challenge: refusedBody.pow, deriveKey }) };
    const ok = await post({ nickname: 'Ana', pow });
    const replay = await post({ nickname: 'Bia', pow });
    // Assert
    expect(ok.status).toBe(200);
    expect([...live.access.sessions.values()].map((s) => s.nickname)).toEqual(['Ana']);
    expect(replay.status).toBe(403);
    // Act
    live.clearAttackAlert();
    // Assert
    expect(live.snapshot().security).toMatchObject({ threat: 'normal', browserCheck: 1, tightened: false });
    expect(live.snapshot().warningCodes.map((w) => w.code)).not.toContain('warn.attackDetected');
  });

  it('refuses IPs on the public blocklists on /join, /api/join and WebSocket upgrades (counted, logged as a prefix)', async () => {
    // Arrange
    const bl = new PublicBlocklists({ dir: '/nonexistent', log: silentLog, sources: () => [] });
    bl.enabled = true;
    vi.spyOn(bl, 'isBlocked').mockImplementation((ip) => ip === '127.0.0.1');
    const { live } = await startedLive({ blocklists: bl });
    const base = `http://127.0.0.1:${live.publicPort}`;
    // Act
    const page = await fetch(`${base}/join/${live.access.currentSecret}`, { redirect: 'manual' });
    const api = await fetch(`${base}/api/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"nickname":"x"}' });
    const ws = new WebSocket(`ws://127.0.0.1:${live.publicPort}/control`, { origin: base });
    const wsStatus = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve(-1));
    });
    // Assert
    expect(page.status).toBe(403);
    expect(page.headers.get('x-swarmcast-refused')).toBe('blocklist');
    expect(((await api.json()) as { code: string }).code).toBe('viewer.err.blocked');
    expect(wsStatus).toBe(403);
    expect(live.snapshot().security.blockedByLists).toBe(3);
    const logged = live.activity.list().filter((e) => e.code === 'log.blocklistBlocked');
    expect(logged).toHaveLength(1);
    expect(logged[0]!.params).toEqual({ prefix: '127.0.0.*' });

    // Act
    live.updateSecurity({ ...live.securitySettings(), blockKnownBadIps: false });
    const after = await fetch(`${base}/join/${live.access.currentSecret}`, { redirect: 'manual' });
    // Assert
    expect(after.status).toBe(303);
  });
});

describe('controller reactions in Direct mode', () => {
  /** A live in Direct mode (its address: a local port that drops connections); switching Direct mode off does `disable`. */
  async function liveInDirectMode(disable: DirectMode['disable']) {
    freezePeriodicWork();
    const port = await droppingPort();
    const { live, advance } = await startedLive({ direct: Object.assign(inactiveDirect(), { enable: async () => `https://127.0.0.1:${port}`, disable }) });
    await live.enableDirect({});
    return { live, advance };
  }

  /** TLS handshake errors at an attack's rate: 31 a second for six seconds, one shield sample a second. */
  function tlsAttack(live: LiveController, advance: () => void): void {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 31; j++) live.shield.tlsError();
      advance();
    }
  }

  it('goes back to Secure mode at the first attack signs and explains it afterwards', async () => {
    // Arrange
    const disable = vi.fn(async () => ({ verified: true, details: [] as string[] }));
    const { live, advance } = await liveInDirectMode(disable);
    // Act
    tlsAttack(live, advance);
    await warningShown(live, 'react.backToSecure');
    // Assert
    expect(disable).toHaveBeenCalledTimes(1);
    expect(live.mode).toBe('secure');
    expect(live.phase).not.toBe('off');
    expect(live.shield.detector.state).toBe('normal');
  });

  it('stops everything when going back fails', async () => {
    // Arrange
    const { live, advance } = await liveInDirectMode(async () => {
      throw new Error('tunnel did not answer');
    });
    // Act
    tlsAttack(live, advance);
    await warningShown(live, 'react.backToSecureFailedStopped');
    // Assert
    expect(live.phase).toBe('off');
    expect(live.activity.list().filter((e) => e.code === 'log.stopped')).toHaveLength(1);
  });
});
