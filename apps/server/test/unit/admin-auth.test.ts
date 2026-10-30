import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { ADMIN_COOKIE } from '@swarmcast/shared';
import { captureLog, tempDir } from './helpers.js';
import { makeController, PANEL_TOKEN, panelServer } from './live-helpers.js';

// The panel's sign-in (GET /auth/<token>) and its "not authorized" page, through app.inject():
// the panel never listens in these tests.
//
// The sign-in page: no redirect, no script (the panel's CSP allows no inline script, and the URL
// holds the token, so the page is never cached, never sent as a referrer, and never repeats it).
//
// The panel pushes the live's state to its WebSocket at most every 250 ms: a change schedules one
// push. A push still due when the panel closes must not run (it read the state of a live that
// may be gone: a TypeError under load, found by the coverage runs).

/** A panel build: index.html only, or with the hashed assets and gate.html the admin build writes. */
function panelBuild(withAssets = false): string {
  const dir = tempDir('sc-admin-');
  if (!withAssets) {
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><div id="app"></div>');
    return dir;
  }
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><div id="app"></div><script type="module" src="/assets/index-AbC123.js"></script>');
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'index-AbC123.js'), 'export {};');
  fs.writeFileSync(path.join(dir, 'assets', 'gate-Xy_9.css'), 'body{}');
  // What apps/admin/gate.html builds to, plus a foreign stylesheet the server must not copy.
  fs.writeFileSync(
    path.join(dir, 'gate.html'),
    '<!doctype html><html><head><link rel="icon" href="/assets/favicon-Q1.svg" type="image/svg+xml" />' +
      '<link rel="stylesheet" crossorigin href="/assets/gate-Xy_9.css"><link rel="stylesheet" href="https://evil.example/x.css"></head></html>',
  );
  return dir;
}

async function panel(o: { withAssets?: boolean; log?: ReturnType<typeof captureLog>['log'] } = {}) {
  const { live } = makeController();
  return panelServer({ live, adminDir: panelBuild(o.withAssets), ...(o.log ? { log: o.log } : {}) });
}

describe('panel login: GET /auth/<token>', () => {
  it('sets the SameSite=Strict cookie and answers 200 with a page that opens / from this origin (no redirect)', async () => {
    // Arrange
    const { app, headers } = await panel();
    // Act
    const res = await app.inject({ method: 'GET', url: `/auth/${PANEL_TOKEN}`, headers: { host: headers.host } });
    // Assert
    expect(res.statusCode).toBe(200);
    expect(res.headers.location).toBeUndefined();
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toContain(`${ADMIN_COOKIE}=${PANEL_TOKEN}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(res.body).not.toMatch(/<script/i);
    expect(res.body).toContain('<meta http-equiv="refresh" content="0;url=/">');
    expect(res.body).toContain('<a href="/">Open the panel</a>');
    expect(res.body).not.toContain(PANEL_TOKEN);
  });

  it('the page follows the browser language', async () => {
    // Arrange
    const { app, headers } = await panel();
    // Act
    const res = await app.inject({ method: 'GET', url: `/auth/${PANEL_TOKEN}`, headers: { host: headers.host, 'accept-language': 'pt-BR,pt;q=0.9' } });
    // Assert
    expect(res.body).toContain('lang="pt-BR"');
    expect(res.body).toContain('Abrir o painel');
  });

  it('the cookie it sets opens the panel; without it the panel is refused', async () => {
    // Arrange
    const { app, headers } = await panel();
    const signIn = await app.inject({ method: 'GET', url: `/auth/${PANEL_TOKEN}`, headers: { host: headers.host } });
    const cookie = String(signIn.headers['set-cookie']).split(';')[0]!;
    // Act
    const withCookie = await app.inject({ method: 'GET', url: '/', headers: { host: headers.host, cookie } });
    const without = await app.inject({ method: 'GET', url: '/', headers: { host: headers.host } });
    // Assert
    expect(withCookie.statusCode).toBe(200);
    expect(withCookie.body).toContain('id="app"');
    expect(without.statusCode).toBe(401);
  });

  it('a wrong token gets the "not authorized" page and no cookie', async () => {
    // Arrange
    const { app, headers } = await panel();
    // Act
    const res = await app.inject({ method: 'GET', url: '/auth/wrong', headers: { host: headers.host } });
    // Assert
    expect(res.statusCode).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body).toContain('SwarmCast');
    expect(res.body).not.toContain('refresh');
  });

  it('debug log: one line per request, never the token', async () => {
    // Arrange
    const capture = captureLog('debug');
    const { app, headers } = await panel({ log: capture.log });
    // Act
    const signIn = await app.inject({ method: 'GET', url: `/auth/${PANEL_TOKEN}`, headers: { host: headers.host } });
    const refused = await app.inject({ method: 'GET', url: '/', headers: { host: headers.host } });
    // Assert
    expect([signIn.statusCode, refused.statusCode]).toEqual([200, 401]);
    expect(capture.lines().filter((l) => l.msg === 'panel request')).toEqual([
      expect.objectContaining({ method: 'GET', path: '/auth/…', status: 200 }),
      expect.objectContaining({ method: 'GET', path: '/', status: 401 }),
    ]);
    expect(JSON.stringify(capture.lines())).not.toContain(PANEL_TOKEN);
  });
});

describe('panel pages: brand styling and caching', () => {
  it('"not authorized": branded page with how to reopen the panel, no inline style or script', async () => {
    // Arrange
    const { app, headers } = await panel({ withAssets: true });
    // Act
    const res = await app.inject({ method: 'GET', url: '/', headers: { host: headers.host } });
    // Assert
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('lang="en"');
    expect(res.body).toContain('<link rel="stylesheet" href="/assets/gate-Xy_9.css">');
    expect(res.body).toContain('<link rel="icon" href="/assets/favicon-Q1.svg" type="image/svg+xml">');
    expect(res.body).not.toContain('evil.example');
    expect(res.body).toContain('class="sc-symbol"');
    expect(res.body).toContain('only opens from the SwarmCast app or window on this computer');
    expect(res.body).toContain('How to open it again');
    expect(res.body).toMatch(/Open SwarmCast/);
    expect(res.body).toMatch(/run the start script again/);
    expect(res.body).not.toMatch(/<script|<style|style=/i);
  });

  it('the stylesheet of that page loads without the cookie', async () => {
    // Arrange
    const { app, headers } = await panel({ withAssets: true });
    // Act
    const res = await app.inject({ method: 'GET', url: '/assets/gate-Xy_9.css', headers: { host: headers.host } });
    // Assert
    expect(res.statusCode).toBe(200);
  });

  it('"not authorized" follows Accept-Language (pt-BR), also for a wrong /auth token', async () => {
    // Arrange
    const { app, headers } = await panel({ withAssets: true });
    // Act
    const res = await app.inject({ method: 'GET', url: '/auth/nope', headers: { host: headers.host, 'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8' } });
    // Assert
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain('lang="pt-BR"');
    expect(res.body).toContain('Abra o painel pelo aplicativo SwarmCast');
    expect(res.body).toContain('Como abrir de novo');
    expect(res.body).toContain('/assets/gate-Xy_9.css');
  });

  it('the sign-in page uses the same stylesheet', async () => {
    // Arrange
    const { app, headers } = await panel({ withAssets: true });
    // Act
    const res = await app.inject({ method: 'GET', url: `/auth/${PANEL_TOKEN}`, headers: { host: headers.host } });
    // Assert
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<link rel="stylesheet" href="/assets/gate-Xy_9.css">');
    expect(res.body).toContain('<a href="/">Open the panel</a>');
  });

  it('index.html is never cached; hashed assets are cached for a long time', async () => {
    // Arrange
    const { app, headers } = await panel({ withAssets: true });
    // Act
    const index = await app.inject({ method: 'GET', url: '/', headers: headers.get });
    const asset = await app.inject({ method: 'GET', url: '/assets/index-AbC123.js', headers: { host: headers.host } });
    // Assert
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain('id="app"');
    expect(index.headers['cache-control']).toBe('no-store');
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });
});

describe('panel server lifecycle', () => {
  it('a state push that was due when the panel closed never runs', async () => {
    // Arrange
    const { live } = makeController();
    const { app } = await panelServer({ live });
    await app.ready();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => void vi.useRealTimers());
    const snapshot = vi.spyOn(live, 'snapshot');
    live.disconnectAll();
    // Act
    await app.close();
    vi.advanceTimersByTime(1000);
    // Assert
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('while open, a change is pushed once within 250 ms', async () => {
    // Arrange
    const { live } = makeController();
    const { app } = await panelServer({ live });
    await app.ready();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => void vi.useRealTimers());
    const snapshot = vi.spyOn(live, 'snapshot');
    // Act
    live.disconnectAll();
    live.disconnectAll();
    vi.advanceTimersByTime(250);
    // Assert
    expect(snapshot).toHaveBeenCalledOnce();
  });
});
