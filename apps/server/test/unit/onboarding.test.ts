import { describe, expect, it, vi } from 'vitest';
import { ADMIN_COOKIE } from '@swarmcast/shared';
import { createAdminServer } from '../../src/admin/server.js';
import { defaultConfig, type AppConfig } from '../../src/core/config.js';
import type { DirectMode } from '../../src/direct/direct.js';
import { makeController } from './live-helpers.js';
import { silentLog } from './helpers.js';

const PORT = 39399;
const HOST = `127.0.0.1:${PORT}`;
const TOKEN = 'onboarding-test-token';

async function setup() {
  const { live } = makeController({} as DirectMode);
  const saved: AppConfig[] = [];
  // Capture what would be written to config.json.
  (live as unknown as { d: { saveConfig: (c: AppConfig) => void } }).d.saveConfig = (c) => saved.push(structuredClone(c));
  const app = await createAdminServer({
    port: PORT,
    adminDir: '/nonexistent',
    live,
    log: silentLog,
    token: TOKEN,
    onQuit: vi.fn(),
    checkDirect: vi.fn(),
    cleanupStale: vi.fn(),
  });
  const headers = { host: HOST, cookie: `${ADMIN_COOKIE}=${TOKEN}` };
  return { app, live, saved, headers };
}

describe('first-run tutorial persistence', () => {
  it('defaults to not done', () => {
    expect(defaultConfig().onboardingDone).toBe(false);
  });

  it('GET/POST /api/onboarding read and store completion in the config', async () => {
    const { app, live, saved, headers } = await setup();
    try {
      let res = await app.inject({ method: 'GET', url: '/api/onboarding', headers });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ done: false });

      res = await app.inject({
        method: 'POST',
        url: '/api/onboarding',
        headers: { ...headers, origin: `http://${HOST}`, 'content-type': 'application/json' },
        payload: { done: true },
      });
      expect(res.json()).toEqual({ done: true });
      expect(live.onboardingDone).toBe(true);
      expect(saved.at(-1)?.onboardingDone).toBe(true);

      res = await app.inject({ method: 'GET', url: '/api/onboarding', headers });
      expect(res.json()).toEqual({ done: true });
    } finally {
      await app.close();
    }
  });

  it('is protected like the rest of the admin API', async () => {
    const { app, headers } = await setup();
    try {
      expect((await app.inject({ method: 'GET', url: '/api/onboarding', headers: { host: HOST } })).statusCode).toBe(401);
      // No Origin (CSRF guard) and a bad body are refused.
      const noOrigin = await app.inject({ method: 'POST', url: '/api/onboarding', headers: { ...headers, 'content-type': 'application/json' }, payload: { done: true } });
      expect(noOrigin.statusCode).toBe(403);
      const bad = await app.inject({
        method: 'POST',
        url: '/api/onboarding',
        headers: { ...headers, origin: `http://${HOST}`, 'content-type': 'application/json' },
        payload: { done: 'yes' },
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
