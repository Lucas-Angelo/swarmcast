import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { ADMIN_COOKIE } from '@swarmcast/shared';
import { createAdminServer } from '../../src/admin/server.js';
import type { DirectMode } from '../../src/direct/direct.js';
import { makeController } from './live-helpers.js';

const PORT = 39399;
const TOKEN = 'per-run-token_ABC123';
const host = `127.0.0.1:${PORT}`;

describe('panel login: GET /auth/<token>', () => {
  let app: FastifyInstance;
  const logged: string[] = [];
  const log = pino({ level: 'debug' }, { write: (line: string) => void logged.push(line) });
  beforeAll(async () => {
    const adminDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-admin-'));
    fs.writeFileSync(path.join(adminDir, 'index.html'), '<!doctype html><div id="app"></div>');
    const { live } = makeController({} as DirectMode);
    app = await createAdminServer({ port: PORT, adminDir, live, log, token: TOKEN, onQuit: vi.fn(), checkDirect: vi.fn(), cleanupStale: vi.fn() });
  });
  afterAll(() => app.close());

  it('sets the SameSite=Strict cookie and answers 200 with a page that opens / from this origin (no redirect)', async () => {
    const res = await app.inject({ method: 'GET', url: `/auth/${TOKEN}`, headers: { host } });
    expect(res.statusCode).toBe(200);
    expect(res.headers.location).toBeUndefined();
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toContain(`${ADMIN_COOKIE}=${TOKEN}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//);
    // Never cached, never sent as a referrer (the URL holds the token).
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    // Works with the panel's CSP as it is: no script at all (none inline is allowed).
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(res.body).not.toMatch(/<script/i);
    expect(res.body).toContain('<meta http-equiv="refresh" content="0;url=/">');
    expect(res.body).toContain('<a href="/">Open the panel</a>');
    // The token is not repeated in the page.
    expect(res.body).not.toContain(TOKEN);
  });

  it('the cookie then opens the panel; the page follows the browser language', async () => {
    const res = await app.inject({ method: 'GET', url: `/auth/${TOKEN}`, headers: { host, 'accept-language': 'pt-BR,pt;q=0.9' } });
    expect(res.body).toContain('lang="pt-BR"');
    expect(res.body).toContain('Abrir o painel');
    const cookie = String(res.headers['set-cookie']).split(';')[0]!;
    const panel = await app.inject({ method: 'GET', url: '/', headers: { host, cookie } });
    expect(panel.statusCode).toBe(200);
    expect(panel.body).toContain('id="app"');
    expect((await app.inject({ method: 'GET', url: '/', headers: { host } })).statusCode).toBe(401);
  });

  it('a wrong token gets the "not authorized" page and no cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/wrong', headers: { host } });
    expect(res.statusCode).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body).toContain('SwarmCast');
    expect(res.body).not.toContain('refresh');
  });

  it('debug log: one line per request, never the token', () => {
    expect(logged.some((l) => l.includes('"path":"/auth/…"') && l.includes('"status":200'))).toBe(true);
    expect(logged.some((l) => l.includes('"path":"/"') && l.includes('"status":401'))).toBe(true);
    expect(logged.join('\n')).not.toContain(TOKEN);
  });
});

describe('panel pages: brand styling and caching', () => {
  let app: FastifyInstance;
  const port = PORT + 1;
  const h = `127.0.0.1:${port}`;
  beforeAll(async () => {
    const adminDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-admin-'));
    fs.writeFileSync(path.join(adminDir, 'index.html'), '<!doctype html><div id="app"></div><script type="module" src="/assets/index-AbC123.js"></script>');
    fs.mkdirSync(path.join(adminDir, 'assets'));
    fs.writeFileSync(path.join(adminDir, 'assets', 'index-AbC123.js'), 'export {};');
    fs.writeFileSync(path.join(adminDir, 'assets', 'gate-Xy_9.css'), 'body{}');
    // What the admin build writes (apps/admin/gate.html), plus a link the server must not copy.
    fs.writeFileSync(
      path.join(adminDir, 'gate.html'),
      '<!doctype html><html><head><link rel="icon" href="/assets/favicon-Q1.svg" type="image/svg+xml" />' +
        '<link rel="stylesheet" crossorigin href="/assets/gate-Xy_9.css"><link rel="stylesheet" href="https://evil.example/x.css"></head></html>',
    );
    const { live } = makeController({} as DirectMode);
    app = await createAdminServer({ port, adminDir, live, log: pino({ level: 'silent' }), token: TOKEN, onQuit: vi.fn(), checkDirect: vi.fn(), cleanupStale: vi.fn() });
  });
  afterAll(() => app.close());

  it('"not authorized": branded page with how to reopen the panel, no inline style or script', async () => {
    const res = await app.inject({ method: 'GET', url: '/', headers: { host: h } });
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
    // The stylesheet itself loads without the cookie.
    expect((await app.inject({ method: 'GET', url: '/assets/gate-Xy_9.css', headers: { host: h } })).statusCode).toBe(200);
  });

  it('"not authorized" follows Accept-Language (pt-BR), also for a wrong /auth token', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/nope', headers: { host: h, 'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8' } });
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain('lang="pt-BR"');
    expect(res.body).toContain('Abra o painel pelo aplicativo SwarmCast');
    expect(res.body).toContain('Como abrir de novo');
    expect(res.body).toContain('/assets/gate-Xy_9.css');
  });

  it('the sign-in page uses the same stylesheet', async () => {
    const res = await app.inject({ method: 'GET', url: `/auth/${TOKEN}`, headers: { host: h } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<link rel="stylesheet" href="/assets/gate-Xy_9.css">');
    expect(res.body).toContain('<a href="/">Open the panel</a>');
  });

  it('index.html is never cached; hashed assets are cached for a long time', async () => {
    const cookie = `${ADMIN_COOKIE}=${TOKEN}`;
    const index = await app.inject({ method: 'GET', url: '/', headers: { host: h, cookie } });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain('id="app"');
    expect(index.headers['cache-control']).toBe('no-store');
    const asset = await app.inject({ method: 'GET', url: '/assets/index-AbC123.js', headers: { host: h } });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });
});
