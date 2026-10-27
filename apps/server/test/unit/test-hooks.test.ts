import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAdminServer } from '../../src/admin/server.js';
import { defaultConfig, type AppConfig } from '../../src/core/config.js';
import type { LiveController } from '../../src/core/live.js';
import type { DirectMode } from '../../src/direct/direct.js';
import { resettableRateLimits } from '../../src/public/rate-limit-store.js';
import { LoadGuard } from '../../src/quality/load-guard.js';
import { Transcoder } from '../../src/quality/transcoder.js';
import { silentLog } from './helpers.js';
import { makeController } from './live-helpers.js';

// Hooks the integration and E2E harnesses build on (MASTER plan WP3.1): free ports chosen by
// the OS at listen time, a rate-limit reset, an injectable load guard, monotonic counters.

const direct = { noteViewer: vi.fn(), snapshot: () => ({ active: false, viewersSeen: 0 }), active: false, ipChanged: null } as unknown as DirectMode;
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c().catch(() => {});
});

/** Every port 0: nothing is probed, the public server gets whatever the OS hands out. */
function liveOnPortZero(): { live: LiveController; config: AppConfig } {
  const config = defaultConfig();
  config.ports = { rtmp: 0, public: 0, admin: 0, mediamtxHls: 0 };
  const { live } = makeController(direct, { config });
  cleanup.push(() => live.stop());
  return { live, config };
}

describe('public server on port 0', () => {
  it('listens on a port the OS picked, exposes it, and picks again on the next start', async () => {
    const { live, config } = liveOnPortZero();
    expect(live.publicPort).toBeNull();
    await live.start();
    const first = live.publicPort!;
    expect(first).toBeGreaterThan(0);
    // config.ports holds the real port (verifyOff, the tunnel and the smoke test read it there).
    expect(config.ports.public).toBe(first);
    expect((await fetch(`http://127.0.0.1:${first}/healthz`)).status).toBe(200);
    expect(await live.stop()).toBe(true);
    expect(live.publicPort).toBeNull();
    await live.start();
    expect(live.publicPort).toBeGreaterThan(0);
    expect((await fetch(`http://127.0.0.1:${live.publicPort}/healthz`)).status).toBe(200);
  });
});

describe('rate-limit reset (test hook)', () => {
  it('clears the global and the per-route counters, which otherwise count exactly like the default store', async () => {
    const limits = resettableRateLimits();
    const app = Fastify();
    cleanup.push(() => app.close());
    await app.register(rateLimit, { store: limits.Store, max: 2, timeWindow: '1 minute' });
    app.get('/global', async () => 'ok');
    app.get('/route', { config: { rateLimit: { max: 1, timeWindow: '1 minute' } } }, async () => 'ok');
    const codes = async (url: string, n: number): Promise<number[]> => {
      const out: number[] = [];
      for (let i = 0; i < n; i++) out.push((await app.inject({ url })).statusCode);
      return out;
    };
    expect(await codes('/global', 3)).toEqual([200, 200, 429]);
    expect(await codes('/route', 2)).toEqual([200, 429]);
    limits.reset();
    expect(await codes('/global', 3)).toEqual([200, 200, 429]);
    expect(await codes('/route', 2)).toEqual([200, 429]);
  });

  it('LiveController.resetRateLimits() lifts a 429 of the running public server', async () => {
    const { live } = liveOnPortZero();
    await live.start();
    const url = `http://127.0.0.1:${live.publicPort}/healthz`;
    // /healthz allows 60 requests per minute and client.
    const statuses = await Promise.all(Array.from({ length: 61 }, () => fetch(url).then((r) => r.status)));
    expect(statuses.filter((s) => s === 429)).toHaveLength(1);
    expect((await fetch(url)).status).toBe(429);
    live.resetRateLimits();
    expect((await fetch(url)).status).toBe(200);
  });
});

describe('panel server on port 0', () => {
  it('accepts its real host and origin, refuses others, and puts the real port in its CSP', async () => {
    const adminDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-admin-'));
    cleanup.push(async () => fs.rmSync(adminDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(adminDir, 'index.html'), '<!doctype html>');
    const { live } = liveOnPortZero();
    const app: FastifyInstance = await createAdminServer({ port: 0, adminDir, live, log: silentLog, token: 'tok', onQuit: vi.fn(), checkDirect: vi.fn(), cleanupStale: vi.fn() });
    cleanup.push(() => app.close());
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    expect(port).toBeGreaterThan(0);
    const ok = await app.inject({ url: '/', headers: { host: `127.0.0.1:${port}` } });
    expect(ok.statusCode).toBe(401); // the right host, no login cookie
    expect(String(ok.headers['content-security-policy'])).toContain(`ws://127.0.0.1:${port}`);
    expect((await app.inject({ url: '/', headers: { host: `localhost:${port}` } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/', headers: { host: '127.0.0.1:0' } })).statusCode).toBe(421);
    expect((await app.inject({ url: '/', headers: { host: `127.0.0.1:${port}`, origin: 'http://127.0.0.1:1' } })).statusCode).toBe(403);
    // Its rate-limit counters can be reset too (600 requests per minute).
    for (let i = 0; i < 600; i++) await app.inject({ url: '/', headers: { host: `127.0.0.1:${port}` } });
    expect((await app.inject({ url: '/', headers: { host: `127.0.0.1:${port}` } })).statusCode).toBe(429);
    app.resetRateLimits();
    expect((await app.inject({ url: '/', headers: { host: `127.0.0.1:${port}` } })).statusCode).toBe(401);
  });
});

describe('load guard injection', () => {
  it('uses the guard instance passed in, or builds one from options', () => {
    const guard = new LoadGuard({ cpuSaturatedPercent: 101, behindSpeed: 0 });
    const q = { binDir: '/nonexistent', dataDir: '/nonexistent', runDir: '/nonexistent', reaper: null };
    const a = makeController(direct, { quality: { ...q, loadGuard: guard } }).live;
    expect((a.quality as unknown as { guard: LoadGuard }).guard).toBe(guard);
    const b = makeController(direct, { quality: { ...q, loadGuard: { cpuSaturatedPercent: 101, cpuForMs: 0 } } }).live;
    const built = (b.quality as unknown as { guard: LoadGuard }).guard;
    expect(built).toBeInstanceOf(LoadGuard);
    // 100 % CPU never reaches a 101 % threshold, even with no observation window.
    expect(built.check(0, { cpuBusyPercent: 100 })).toBeNull();
    expect(built.check(60_000, { cpuBusyPercent: 100 })).toBeNull();
  });
});

describe('Transcoder counters', () => {
  it('launches and crashes only ever grow; restarts start again at 0 with every start', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-ladder-'));
    cleanup.push(async () => fs.rmSync(workDir, { recursive: true, force: true }));
    // Node refuses ffmpeg's arguments and exits at once: a converter that crashes on every launch.
    const t = new Transcoder({ ffmpeg: process.execPath, inputUrl: 'rtmp://127.0.0.1:9/live/x', workDir, reaper: null, log: silentLog, maxRestarts: 1 });
    cleanup.push(() => t.stop());
    const rungs = [{ name: 'v1080', height: 1080, width: 1920, fps: 30, kbps: 6000, source: true }, { name: 'v480', height: 480, width: 854, fps: 30, kbps: 1500, source: false }];
    const failed = (): Promise<void> => new Promise((r) => t.on('status', (s) => s === 'failed' && r()));
    let done = failed();
    t.start(rungs, 'libx264', false);
    await done;
    expect({ launches: t.launches, crashes: t.crashes, restarts: t.restarts }).toEqual({ launches: 2, crashes: 2, restarts: 2 });
    await t.stop();
    done = failed();
    t.start(rungs, 'libx264', false);
    await done;
    expect({ launches: t.launches, crashes: t.crashes, restarts: t.restarts }).toEqual({ launches: 4, crashes: 4, restarts: 2 });
    // Stopping is not a crash.
    await t.stop();
    expect(t.crashes).toBe(4);
  });
});
