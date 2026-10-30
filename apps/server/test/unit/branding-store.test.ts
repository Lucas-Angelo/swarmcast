import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ADMIN_COOKIE } from '@swarmcast/shared';
import { defaultBranding, type AdminBrandingState, type Branding } from '@swarmcast/shared/branding';
import { createAdminServer } from '../../src/admin/server.js';
import { BrandingStore } from '../../src/branding/store.js';
import { ActivityLog } from '../../src/core/activity.js';
import { defaultConfig } from '../../src/core/config.js';
import type { LiveController } from '../../src/core/live.js';
import type { DirectMode } from '../../src/direct/direct.js';
import { Anonymizer } from '../../src/diagnostics/anonymize.js';
import { sanitizeConfig } from '../../src/diagnostics/export.js';
import { makeController } from './live-helpers.js';
import { silentLog } from './helpers.js';

const fixtures = path.join(import.meta.dirname, '..', 'fixtures', 'branding');
const read = (f: string): Buffer => fs.readFileSync(path.join(fixtures, f));

function store(dir?: string) {
  let b: Branding = defaultBranding();
  const activity = new ActivityLog();
  const s = new BrandingStore({ dir, get: () => b, save: (x) => void (b = x), activity, log: silentLog });
  return { s, get: () => b, set: (x: Branding) => void (b = x), activity };
}

describe('branding store (U10)', () => {
  it('stores stripped, content-addressed files (0600), GCs replaced ones, bumps rev', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-brand-'));
    const { s, get } = store(dir);
    const r = s.putImage('avatar', read('avatar-meta.png'));
    if (!r.ok) throw new Error(r.code);
    const file = path.join(dir, `${r.ref.sha}.png`);
    expect(fs.existsSync(file)).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file).toString('latin1')).not.toContain('MARKER');
    expect(get().rev).toBe(1);
    const r2 = s.putImage('avatar', read('avatar-alpha.webp'));
    expect(r2.ok).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readdirSync(dir)).toHaveLength(1);
    fs.writeFileSync(path.join(dir, 'junk.txt'), 'x');
    s.putImage('fav32', read('fav32.png'));
    expect(fs.readdirSync(dir).sort()).toHaveLength(2);
    s.removeImage('avatar');
    expect(get().images.avatar).toBeUndefined();
    expect(get().images.fav32).toBeUndefined(); // a variant of the avatar
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('a tampered or missing file is dropped at load with an activity line', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-brand-'));
    const a = store(dir);
    const r = a.s.putImage('banner', read('banner-meta.jpg'));
    if (!r.ok) throw new Error(r.code);
    fs.appendFileSync(path.join(dir, `${r.ref.sha}.jpg`), 'tampered');
    const b = store(dir);
    b.set(a.get());
    b.s.load();
    expect(b.get().images.banner).toBeUndefined();
    expect(b.activity.list().some((e) => e.code === 'log.brand.imageDropped')).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('refuses images that fail validation and keeps the disk budget', () => {
    const { s } = store();
    expect(s.putImage('banner', read('avatar-meta.png'))).toMatchObject({ ok: false, code: 'img.dims' });
    expect(s.putImage('avatar', read('avatar-apng.png'))).toMatchObject({ ok: false, code: 'img.animated' });
    for (const [slot, f] of [['avatar', 'avatar-meta.png'], ['banner', 'banner-meta.jpg'], ['banner640', 'banner-meta.jpg'], ['fav32', 'fav32.png']] as const) s.putImage(slot, read(f));
    expect(s.disk().files).toBeLessThanOrEqual(9);
    expect(s.disk().bytes).toBeLessThanOrEqual(1.5 * 1024 * 1024);
  });

  it('the public payload: only what the page shows; links re-checked against the stream host; Pix with its BR Code', () => {
    const { s, set } = store();
    set({
      ...defaultBranding(),
      name: 'Ana Plays',
      links: [
        { label: 'YouTube', url: 'https://www.youtube.com/@ana' },
        { label: 'Self', url: 'https://abc.trycloudflare.com/x' },
      ],
      support: { enabled: true, label: 'support', mode: 'pix', pix: { type: 'evp', key: '123e4567-e12b-12d1-a456-426655440000', name: 'Fulano de Tal', city: 'BRASILIA' } },
    });
    const pub = s.publicBranding({ ownHost: 'abc.trycloudflare.com' })!;
    expect(pub.links.map((l) => l.label)).toEqual(['YouTube']);
    expect(pub.support?.pix?.payload).toBe('00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D');
    expect(JSON.stringify(pub)).not.toContain('images');
    set({ ...defaultBranding(), enabled: false });
    expect(s.publicBranding()).toBeNull();
    expect(s.themeCss()).toBe('');
  });
});

describe('diagnostics export (U11)', () => {
  it('contains no branding string, only a summary', () => {
    const cfg = { ...defaultConfig(), branding: { ...defaultBranding(), name: 'UNIQUE-NAME-1234', about: 'UNIQUE-ABOUT', links: [{ label: 'UNIQUE-LABEL', url: 'https://unique-host.example.org/' }], support: { enabled: true, label: 'pix', mode: 'pix', pix: { type: 'cpf', key: '52998224725', name: 'UNIQUE-PIX-NAME', city: 'X' } } } };
    const out = JSON.stringify(sanitizeConfig(cfg, new Anonymizer()));
    for (const s of ['UNIQUE', '52998224725', 'unique-host']) expect(out).not.toContain(s);
    expect(out).toContain('"links":1');
  });
});

describe('branding admin API', () => {
  const PORT = 39397;
  const host = `127.0.0.1:${PORT}`;
  const origin = `http://${host}`;
  const cookie = `${ADMIN_COOKIE}=tok_brand_123`;
  let app: FastifyInstance;
  let live: LiveController;
  beforeAll(async () => {
    const adminDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-admin-brand-'));
    fs.writeFileSync(path.join(adminDir, 'index.html'), '<!doctype html>');
    ({ live } = makeController({ noteViewer: vi.fn() } as unknown as DirectMode));
    app = await createAdminServer({ port: PORT, adminDir, live, log: silentLog, token: 'tok_brand_123', onQuit: vi.fn(), checkDirect: vi.fn(), cleanupStale: vi.fn() });
  });
  afterAll(() => app.close());

  const put = (url: string, body: Buffer | string, type: string, headers: Record<string, string> = { host, origin, cookie }) => app.inject({ method: 'PUT', url, headers: { ...headers, 'content-type': type }, payload: body });

  it('text: validated and saved; plain-words codes for bad values', async () => {
    const ok = await put('/api/branding', JSON.stringify({ name: 'Ana Plays', tags: ['cozy', 'indie'], links: [{ label: 'Ko-fi', url: 'https://ko-fi.com/ana' }], theme: { preset: 'ocean', corners: 'soft' } }), 'application/json');
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as AdminBrandingState).branding).toMatchObject({ name: 'Ana Plays', rev: 1, theme: { preset: 'ocean' } });
    for (const [body, code] of [
      [{ links: [{ label: 'x', url: 'javascript:alert(1)' }] }, 'url.scheme'],
      [{ links: [{ label: 'x', url: 'https://192.168.0.1' }] }, 'url.local'],
      [{ tags: ['cozy', 'COZY'] }, 'brand.err.tagDup'],
      [{ support: { enabled: true, mode: 'link' } }, 'brand.err.support'],
      [{ support: { enabled: true, mode: 'pix', pix: { type: 'cpf', key: '123', name: 'Ana', city: 'Rio' } } }, 'pix.cpf'],
      [{ name: 'x'.repeat(41) }, 'text.tooLong'],
    ] as const) {
      const r = await put('/api/branding', JSON.stringify(body), 'application/json');
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
      expect(r.json(), JSON.stringify(body)).toMatchObject({ code });
    }
  });

  it('images: raw PNG/JPEG/WebP only on the image route, with the Origin check; wrong sizes and SVG refused', async () => {
    const ok = await put('/api/branding/image/avatar', read('avatar-meta.png'), 'image/png');
    expect(ok.statusCode, ok.body).toBe(200);
    const sha = (ok.json() as { ref: { sha: string } }).ref.sha;
    const file = await app.inject({ method: 'GET', url: `/api/branding/file/${sha}.png`, headers: { host, cookie } });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.rawPayload.toString('latin1')).not.toContain('MARKER');
    expect((await put('/api/branding/image/avatar', read('avatar-meta.png'), 'image/png', { host, cookie })).statusCode).toBe(403);
    expect((await put('/api/branding/image/avatar', read('avatar-meta.png'), 'image/png', { host, cookie, origin: 'http://evil.example' })).statusCode).toBe(403);
    for (const t of ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'text/plain']) expect((await put('/api/branding/image/avatar', 'x', t)).statusCode, t).toBe(415);
    expect((await put('/api/branding', read('avatar-meta.png'), 'image/png')).statusCode).toBe(415);
    expect((await put('/api/settings', read('avatar-meta.png'), 'image/png')).statusCode).toBe(415);
    expect((await put('/api/branding/image/avatar', Buffer.alloc(600 * 1024), 'image/png')).statusCode).toBe(413);
    const svg = await put('/api/branding/image/avatar', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png');
    expect(svg.statusCode).toBe(400);
    expect(svg.json()).toMatchObject({ code: 'img.type' });
    const dims = await put('/api/branding/image/banner', read('avatar-meta.png'), 'image/png');
    expect(dims.json()).toMatchObject({ code: 'img.dims', params: { w: 1280, h: 320 } });
    expect((await put('/api/branding/image/nope', read('avatar-meta.png'), 'image/png')).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: '/api/branding/image/avatar', headers: { host, origin, cookie } })).statusCode).toBe(200);
    expect(live.branding.branding.images.avatar).toBeUndefined();
  });

  it('reset goes back to the defaults; requests without the panel cookie are refused', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/branding', headers: { host } })).statusCode).toBe(401);
    const r = await app.inject({ method: 'POST', url: '/api/branding/reset', headers: { host, origin, cookie, 'content-type': 'application/json' }, payload: '{}' });
    expect(r.statusCode).toBe(200);
    expect((r.json() as AdminBrandingState).branding).toMatchObject({ tags: [], links: [], theme: { preset: 'forest' } });
  });
});
