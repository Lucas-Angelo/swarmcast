import { describe, expect, it } from 'vitest';
import { defaultConfig, type AppConfig } from '../../src/core/config.js';
import { makeController, panelServer } from './live-helpers.js';

// The first-run tutorial: whether it was completed is kept in config.json (onboardingDone).

/** The panel of a fresh live, and what it would write to config.json. */
async function onboardingPanel() {
  const saved: AppConfig[] = [];
  const { live } = makeController(undefined, { saveConfig: (c) => void saved.push(structuredClone(c)) });
  const { app, headers } = await panelServer({ live });
  return { app, live, saved, headers };
}

describe('first-run tutorial persistence', () => {
  it('defaults to not done', () => {
    // Act
    const done = defaultConfig().onboardingDone;
    // Assert
    expect(done).toBe(false);
  });

  it('GET /api/onboarding reads it: not done at first', async () => {
    // Arrange
    const { app, headers } = await onboardingPanel();
    // Act
    const res = await app.inject({ method: 'GET', url: '/api/onboarding', headers: headers.get });
    // Assert
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ done: false });
  });

  it('POST /api/onboarding stores completion in the config, and GET then says done', async () => {
    // Arrange
    const { app, live, saved, headers } = await onboardingPanel();
    // Act
    const res = await app.inject({ method: 'POST', url: '/api/onboarding', headers: headers.json, payload: { done: true } });
    const after = await app.inject({ method: 'GET', url: '/api/onboarding', headers: headers.get });
    // Assert
    expect(res.json()).toEqual({ done: true });
    expect(live.onboardingDone).toBe(true);
    expect(saved.at(-1)?.onboardingDone).toBe(true);
    expect(after.json()).toEqual({ done: true });
  });

  it('is protected like the rest of the admin API: cookie, Origin (CSRF guard) and a valid body', async () => {
    // Arrange
    const { app, headers } = await onboardingPanel();
    // Act
    const noCookie = await app.inject({ method: 'GET', url: '/api/onboarding', headers: { host: headers.host } });
    const noOrigin = await app.inject({ method: 'POST', url: '/api/onboarding', headers: { ...headers.get, 'content-type': 'application/json' }, payload: { done: true } });
    const bad = await app.inject({ method: 'POST', url: '/api/onboarding', headers: headers.json, payload: { done: 'yes' } });
    // Assert
    expect(noCookie.statusCode).toBe(401);
    expect(noOrigin.statusCode).toBe(403);
    expect(bad.statusCode).toBe(400);
  });
});
