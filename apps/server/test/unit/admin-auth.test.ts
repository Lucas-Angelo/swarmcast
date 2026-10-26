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
