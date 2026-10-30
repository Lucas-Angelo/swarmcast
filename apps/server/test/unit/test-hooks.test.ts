import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { defaultConfig, type AppConfig } from '../../src/core/config.js';
import type { LiveController } from '../../src/core/live.js';
import { resettableRateLimits } from '../../src/public/rate-limit-store.js';
import { LoadGuard } from '../../src/quality/load-guard.js';
import type { Transcoder } from '../../src/quality/transcoder.js';
import { tempDir } from './helpers.js';
import { LADDER_RUNGS, statusReached, transcoderWith } from './helpers-b.js';
import { inactiveDirect, makeController, panelServer, startController } from './live-helpers.js';

// Hooks the integration and E2E harnesses build on: free ports chosen by the OS at listen time
// (config.ports then holds the real port: verifyOff, the tunnel and the smoke test read it
// there), a rate-limit reset, an injectable load guard, monotonic converter counters. Fastify's
// inject() is used where the network is not the subject; the panel listens for real because its
// CSP names the port it got.

/** /healthz answers this many requests per minute and client, then 429. */
const HEALTHZ_PER_MINUTE = 60;
/** The panel answers this many requests per minute, then 429. */
const PANEL_PER_MINUTE = 600;

afterEach(() => {
  vi.useRealTimers();
});

/** A live (not started) with every port 0 and its config at hand: the public server gets whatever the OS hands out. Stopped when the test finishes. */
function liveOnPortZero(): { live: LiveController; config: AppConfig } {
  const config = defaultConfig();
  config.ports = { rtmp: 0, public: 0, admin: 0, mediamtxHls: 0 };
  const { live } = makeController(inactiveDirect(), { config });
  onTestFinished(async () => void (await live.stop()));
  return { live, config };
}

const healthz = async (port: number | null): Promise<number> => (await fetch(`http://127.0.0.1:${port}/healthz`)).status;

/** The panel server listening on 127.0.0.1, port 0, and the port it got. Closed when the test finishes. */
async function panelOnPortZero(): Promise<{ app: FastifyInstance; port: number }> {
  const adminDir = tempDir('sc-admin-');
  fs.writeFileSync(path.join(adminDir, 'index.html'), '<!doctype html>');
  const { app } = await panelServer({ live: makeController().live, port: 0, adminDir });
  await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, port: (app.server.address() as AddressInfo).port };
}

describe('public server on port 0', () => {
  it('has no port before the start', () => {
    // Arrange
    const { live } = liveOnPortZero();
    // Act
    const port = live.publicPort;
    // Assert
    expect(port).toBeNull();
  });

  it('listens on a port the OS picked, and the config holds that port', async () => {
    // Arrange
    const { live, config } = liveOnPortZero();
    // Act
    await live.start();
    // Assert
    expect(live.publicPort).toBeGreaterThan(0);
    expect(config.ports.public).toBe(live.publicPort);
    expect(await healthz(live.publicPort)).toBe(200);
  });

  it('stops cleanly and forgets its port', async () => {
    // Arrange
    const { live } = await startController();
    // Act
    const verified = await live.stop();
    // Assert
    expect(verified).toBe(true);
    expect(live.publicPort).toBeNull();
  });

  it('picks a port again on the next start', async () => {
    // Arrange
    const { live } = await startController();
    await live.stop();
    // Act
    await live.start();
    // Assert
    expect(live.publicPort).toBeGreaterThan(0);
    expect(await healthz(live.publicPort)).toBe(200);
  });
});

describe('rate-limit reset (test hook)', () => {
  /** A Fastify app with the resettable store: 2 requests a minute on /global, 1 on /route. Closed when the test finishes. */
  async function limitedApp() {
    const limits = resettableRateLimits();
    const app = Fastify();
    onTestFinished(() => app.close());
    await app.register(rateLimit, { store: limits.Store, max: 2, timeWindow: '1 minute' });
    app.get('/global', async () => 'ok');
    app.get('/route', { config: { rateLimit: { max: 1, timeWindow: '1 minute' } } }, async () => 'ok');
    const codes = async (url: string, n: number): Promise<number[]> => {
      const out: number[] = [];
      for (let i = 0; i < n; i++) out.push((await app.inject({ url })).statusCode);
      return out;
    };
    return { limits, codes };
  }

  it('counts the global and the per-route limits exactly like the default store', async () => {
    // Arrange
    const { codes } = await limitedApp();
    // Act
    const global = await codes('/global', 3);
    const route = await codes('/route', 2);
    // Assert
    expect(global).toEqual([200, 200, 429]);
    expect(route).toEqual([200, 429]);
  });

  it('clears the global and the per-route counters', async () => {
    // Arrange
    const { limits, codes } = await limitedApp();
    await codes('/global', 3);
    await codes('/route', 2);
    // Act
    limits.reset();
    // Assert
    expect(await codes('/global', 3)).toEqual([200, 200, 429]);
    expect(await codes('/route', 2)).toEqual([200, 429]);
  });

  it('LiveController.resetRateLimits() lifts a 429 of the running public server', async () => {
    // Arrange
    const { live } = await startController();
    const statuses = await Promise.all(Array.from({ length: HEALTHZ_PER_MINUTE + 1 }, () => healthz(live.publicPort)));
    const limited = await healthz(live.publicPort);
    // Act
    live.resetRateLimits();
    // Assert
    expect(statuses.filter((s) => s === 429)).toHaveLength(1);
    expect(limited).toBe(429);
    expect(await healthz(live.publicPort)).toBe(200);
  });
});

describe('panel server on port 0', () => {
  it('accepts its real host (401: no login cookie) and puts the real port in its CSP', async () => {
    // Arrange
    const { app, port } = await panelOnPortZero();
    // Act
    const ok = await app.inject({ url: '/', headers: { host: `127.0.0.1:${port}` } });
    const named = await app.inject({ url: '/', headers: { host: `localhost:${port}` } });
    // Assert
    expect(port).toBeGreaterThan(0);
    expect(ok.statusCode).toBe(401);
    expect(String(ok.headers['content-security-policy'])).toContain(`ws://127.0.0.1:${port}`);
    expect(named.statusCode).toBe(401);
  });

  it('refuses another host (421) and another origin (403)', async () => {
    // Arrange
    const { app, port } = await panelOnPortZero();
    // Act
    const wrongHost = await app.inject({ url: '/', headers: { host: '127.0.0.1:0' } });
    const wrongOrigin = await app.inject({ url: '/', headers: { host: `127.0.0.1:${port}`, origin: 'http://127.0.0.1:1' } });
    // Assert
    expect(wrongHost.statusCode).toBe(421);
    expect(wrongOrigin.statusCode).toBe(403);
  });

  it('its rate-limit counters can be reset too', async () => {
    // Arrange
    const { app, port } = await panelOnPortZero();
    const headers = { host: `127.0.0.1:${port}` };
    for (let i = 0; i < PANEL_PER_MINUTE; i++) await app.inject({ url: '/', headers });
    const limited = await app.inject({ url: '/', headers });
    // Act
    app.resetRateLimits();
    // Assert
    expect(limited.statusCode).toBe(429);
    expect((await app.inject({ url: '/', headers })).statusCode).toBe(401);
  });
});

describe('load guard injection', () => {
  /** Quality options of a logic test: no ffmpeg, no ladder. */
  const NO_LADDER = { binDir: '/nonexistent', dataDir: '/nonexistent', runDir: '/nonexistent', reaper: null };

  it('uses the guard instance passed in', () => {
    // Arrange
    const guard = new LoadGuard({ cpuSaturatedPercent: 101, behindSpeed: 0 });
    // Act
    const { live } = makeController(inactiveDirect(), { quality: { ...NO_LADDER, loadGuard: guard } });
    // Assert
    expect(live.quality.guard).toBe(guard);
  });

  it('builds one from options: 100 % CPU never reaches a 101 % threshold, even with no observation window', () => {
    // Arrange
    const { live } = makeController(inactiveDirect(), { quality: { ...NO_LADDER, loadGuard: { cpuSaturatedPercent: 101, cpuForMs: 0 } } });
    const built = live.quality.guard;
    // Act
    const verdicts = [built.check(0, { cpuBusyPercent: 100 }), built.check(60_000, { cpuBusyPercent: 100 })];
    // Assert
    expect(built).toBeInstanceOf(LoadGuard);
    expect(verdicts).toEqual([null, null]);
  });
});

describe('Transcoder counters', () => {
  /** Node refuses ffmpeg's arguments and exits at once: a converter that crashes on every launch. */
  const crashingFfmpeg = process.execPath;
  /** The back-off before the first restart of a crashed ladder. */
  const FIRST_RESTART_MS = 1000;

  /**
   * Starts the ladder and lets it crash until it gives up (one restart allowed): each crash is
   * awaited, its restart back-off passes on the fake clock.
   */
  async function crashUntilFailed(t: Transcoder): Promise<void> {
    const crashed = statusReached(t, 'restarting');
    const failed = statusReached(t, 'failed');
    t.start(LADDER_RUNGS, 'libx264', false);
    await crashed;
    vi.advanceTimersByTime(FIRST_RESTART_MS);
    await failed;
  }

  const counters = (t: Transcoder) => ({ launches: t.launches, crashes: t.crashes, restarts: t.restarts });

  it('restarts a crashed ladder after its back-off, not before', async () => {
    // Arrange
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const t = transcoderWith(crashingFfmpeg, { maxRestarts: 1 });
    const crashed = statusReached(t, 'restarting');
    t.start(LADDER_RUNGS, 'libx264', false);
    await crashed;
    // Act
    vi.advanceTimersByTime(FIRST_RESTART_MS - 1);
    const beforeBackoff = t.launches;
    vi.advanceTimersByTime(1);
    // Assert
    expect(beforeBackoff).toBe(1);
    expect(t.launches).toBe(2);
  });

  it('launches and crashes only ever grow; restarts start again at 0 with every start', async () => {
    // Arrange
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const t = transcoderWith(crashingFfmpeg, { maxRestarts: 1 });
    // Act
    await crashUntilFailed(t);
    const first = counters(t);
    await t.stop();
    await crashUntilFailed(t);
    const second = counters(t);
    // Assert
    expect(first).toEqual({ launches: 2, crashes: 2, restarts: 2 });
    expect(second).toEqual({ launches: 4, crashes: 4, restarts: 2 });
  });

  it('stopping is not a crash', async () => {
    // Arrange
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const t = transcoderWith(crashingFfmpeg, { maxRestarts: 1 });
    await crashUntilFailed(t);
    // Act
    await t.stop();
    // Assert
    expect(t.crashes).toBe(2);
  });
});
