import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultBranding, type AdminBrandingState, type Branding } from '@swarmcast/shared/branding';
import { BrandingStore } from '../../src/branding/store.js';
import { ActivityLog } from '../../src/core/activity.js';
import { defaultConfig } from '../../src/core/config.js';
import { Anonymizer } from '../../src/diagnostics/anonymize.js';
import { sanitizeConfig } from '../../src/diagnostics/export.js';
import { silentLog, tempDir } from './helpers.js';
import { makeController, panelServer } from './live-helpers.js';

// The streamer's page (docs/BRANDING.md): images stored stripped and content-addressed in
// <data>/branding, the public payload, the diagnostics summary and the panel API.

const fixtures = path.join(import.meta.dirname, '..', 'fixtures', 'branding');
const read = (f: string): Buffer => fs.readFileSync(path.join(fixtures, f));

/** A BrandingStore over `dir` (none: images in memory only), with the branding it saves. */
function store(dir?: string) {
  let b: Branding = defaultBranding();
  const activity = new ActivityLog();
  const s = new BrandingStore({ dir, get: () => b, save: (x) => void (b = x), activity, log: silentLog });
  return { s, get: () => b, set: (x: Branding) => void (b = x), activity };
}

describe('branding store (U10)', () => {
  it('stores a stripped, content-addressed file (0600) and bumps rev', () => {
    // Arrange
    const dir = tempDir('sc-brand-');
    const { s, get } = store(dir);
    // Act
    const r = s.putImage('avatar', read('avatar-meta.png'));
    // Assert
    if (!r.ok) throw new Error(r.code);
    const file = path.join(dir, `${r.ref.sha}.png`);
    expect(fs.existsSync(file)).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file).toString('latin1')).not.toContain('MARKER');
    expect(get().rev).toBe(1);
  });

  it('a replaced image is deleted from disk', () => {
    // Arrange
    const dir = tempDir('sc-brand-');
    const { s } = store(dir);
    const first = s.putImage('avatar', read('avatar-meta.png'));
    if (!first.ok) throw new Error(first.code);
    // Act
    const second = s.putImage('avatar', read('avatar-alpha.webp'));
    // Assert
    expect(second.ok).toBe(true);
    expect(fs.existsSync(path.join(dir, `${first.ref.sha}.png`))).toBe(false);
    expect(fs.readdirSync(dir)).toHaveLength(1);
  });

  it('collects files it does not know about; removing the avatar removes its variants (fav32) too', () => {
    // Arrange
    const dir = tempDir('sc-brand-');
    const { s, get } = store(dir);
    s.putImage('avatar', read('avatar-alpha.webp'));
    fs.writeFileSync(path.join(dir, 'junk.txt'), 'x');
    // Act
    s.putImage('fav32', read('fav32.png'));
    // Assert
    expect(fs.readdirSync(dir)).toHaveLength(2);
    // Act
    s.removeImage('avatar');
    // Assert
    expect(get().images.avatar).toBeUndefined();
    expect(get().images.fav32).toBeUndefined();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('a tampered or missing file is dropped at load with an activity line', () => {
    // Arrange
    const dir = tempDir('sc-brand-');
    const a = store(dir);
    const r = a.s.putImage('banner', read('banner-meta.jpg'));
    if (!r.ok) throw new Error(r.code);
    fs.appendFileSync(path.join(dir, `${r.ref.sha}.jpg`), 'tampered');
    const b = store(dir);
    b.set(a.get());
    // Act
    b.s.load();
    // Assert
    expect(b.get().images.banner).toBeUndefined();
    expect(b.activity.list().some((e) => e.code === 'log.brand.imageDropped')).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it.each([
    ['banner', 'avatar-meta.png', 'img.dims'],
    ['avatar', 'avatar-apng.png', 'img.animated'],
  ] as const)('refuses a %s from %s: %s', (slot, file, code) => {
    // Arrange
    const { s } = store();
    // Act
    const r = s.putImage(slot, read(file));
    // Assert
    expect(r).toMatchObject({ ok: false, code });
  });

  it('keeps the disk budget with every slot filled', () => {
    // Arrange
    const { s } = store();
    // Act
    for (const [slot, f] of [['avatar', 'avatar-meta.png'], ['banner', 'banner-meta.jpg'], ['banner640', 'banner-meta.jpg'], ['fav32', 'fav32.png']] as const) s.putImage(slot, read(f));
    // Assert
    expect(s.disk().files).toBeLessThanOrEqual(9);
    expect(s.disk().bytes).toBeLessThanOrEqual(1.5 * 1024 * 1024);
  });

  it('the public payload: only what the page shows; links re-checked against the stream host; Pix with its BR Code', () => {
    // Arrange
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
    // Act
    const pub = s.publicBranding({ ownHost: 'abc.trycloudflare.com' })!;
    // Assert
    expect(pub.links.map((l) => l.label)).toEqual(['YouTube']);
    expect(pub.support?.pix?.payload).toBe('00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D');
    expect(JSON.stringify(pub)).not.toContain('images');
  });

  it('turned off: no public payload and no theme', () => {
    // Arrange
    const { s, set } = store();
    set({ ...defaultBranding(), enabled: false });
    // Act
    const pub = s.publicBranding();
    const css = s.themeCss();
    // Assert
    expect(pub).toBeNull();
    expect(css).toBe('');
  });
});

describe('diagnostics export (U11)', () => {
  it('contains no branding string, only a summary', () => {
    // Arrange
    const cfg = {
      ...defaultConfig(),
      branding: {
        ...defaultBranding(),
        name: 'UNIQUE-NAME-1234',
        about: 'UNIQUE-ABOUT',
        links: [{ label: 'UNIQUE-LABEL', url: 'https://unique-host.example.org/' }],
        support: { enabled: true, label: 'pix', mode: 'pix' as const, pix: { type: 'cpf' as const, key: '52998224725', name: 'UNIQUE-PIX-NAME', city: 'X' } },
      },
    };
    // Act
    const out = JSON.stringify(sanitizeConfig(cfg, new Anonymizer()));
    // Assert
    for (const s of ['UNIQUE', '52998224725', 'unique-host']) expect(out).not.toContain(s);
    expect(out).toContain('"links":1');
  });
});

describe('branding admin API', () => {
  /** The panel of a fresh live, with a panel build (index.html) of its own. */
  async function brandingPanel() {
    const adminDir = tempDir('sc-admin-brand-');
    fs.writeFileSync(path.join(adminDir, 'index.html'), '<!doctype html>');
    const { live } = makeController();
    const { app, headers } = await panelServer({ live, adminDir });
    const put = (url: string, body: Buffer | string, type: string, h: Record<string, string> = { host: headers.host, origin: headers.origin, cookie: headers.cookie }) =>
      app.inject({ method: 'PUT', url, headers: { ...h, 'content-type': type }, payload: body });
    return { app, live, headers, put };
  }

  it('text: validated and saved', async () => {
    // Arrange
    const { put } = await brandingPanel();
    // Act
    const ok = await put('/api/branding', JSON.stringify({ name: 'Ana Plays', tags: ['cozy', 'indie'], links: [{ label: 'Ko-fi', url: 'https://ko-fi.com/ana' }], theme: { preset: 'ocean', corners: 'soft' } }), 'application/json');
    // Assert
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as AdminBrandingState).branding).toMatchObject({ name: 'Ana Plays', rev: 1, theme: { preset: 'ocean' } });
  });

  it.each([
    [{ links: [{ label: 'x', url: 'javascript:alert(1)' }] }, 'url.scheme'],
    [{ links: [{ label: 'x', url: 'https://192.168.0.1' }] }, 'url.local'],
    [{ tags: ['cozy', 'COZY'] }, 'brand.err.tagDup'],
    [{ support: { enabled: true, mode: 'link' } }, 'brand.err.support'],
    [{ support: { enabled: true, mode: 'pix', pix: { type: 'cpf', key: '123', name: 'Ana', city: 'Rio' } } }, 'pix.cpf'],
    [{ name: 'x'.repeat(41) }, 'text.tooLong'],
  ])('text: %j is refused with the plain-words code %s', async (body, code) => {
    // Arrange
    const { put } = await brandingPanel();
    // Act
    const r = await put('/api/branding', JSON.stringify(body), 'application/json');
    // Assert
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code });
  });

  it('images: a raw PNG is stored stripped and served back as image/png', async () => {
    // Arrange
    const { app, headers, put } = await brandingPanel();
    // Act
    const ok = await put('/api/branding/image/avatar', read('avatar-meta.png'), 'image/png');
    // Assert
    expect(ok.statusCode, ok.body).toBe(200);
    const sha = (ok.json() as { ref: { sha: string } }).ref.sha;
    const file = await app.inject({ method: 'GET', url: `/api/branding/file/${sha}.png`, headers: headers.get });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.rawPayload.toString('latin1')).not.toContain('MARKER');
  });

  it('images: the Origin check applies (missing or foreign: 403)', async () => {
    // Arrange
    const { headers, put } = await brandingPanel();
    // Act
    const missing = await put('/api/branding/image/avatar', read('avatar-meta.png'), 'image/png', { host: headers.host, cookie: headers.cookie });
    const foreign = await put('/api/branding/image/avatar', read('avatar-meta.png'), 'image/png', { host: headers.host, cookie: headers.cookie, origin: 'http://evil.example' });
    // Assert
    expect(missing.statusCode).toBe(403);
    expect(foreign.statusCode).toBe(403);
  });

  it.each([
    ['form data on the image route', '/api/branding/image/avatar', 'application/x-www-form-urlencoded', 'x'],
    ['multipart on the image route', '/api/branding/image/avatar', 'multipart/form-data; boundary=x', 'x'],
    ['plain text on the image route', '/api/branding/image/avatar', 'text/plain', 'x'],
    ['an image on the text route', '/api/branding', 'image/png', read('avatar-meta.png')],
    ['an image on another route', '/api/settings', 'image/png', read('avatar-meta.png')],
  ])('images: %s is refused (415)', async (_what, url, type, body) => {
    // Arrange
    const { put } = await brandingPanel();
    // Act
    const r = await put(url, body, type);
    // Assert
    expect(r.statusCode).toBe(415);
  });

  it('images: too big (413), SVG (img.type), wrong size (img.dims with the size wanted), unknown slot (400)', async () => {
    // Arrange
    const { put } = await brandingPanel();
    // Act
    const big = await put('/api/branding/image/avatar', Buffer.alloc(600 * 1024), 'image/png');
    const svg = await put('/api/branding/image/avatar', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png');
    const dims = await put('/api/branding/image/banner', read('avatar-meta.png'), 'image/png');
    const slot = await put('/api/branding/image/nope', read('avatar-meta.png'), 'image/png');
    // Assert
    expect(big.statusCode).toBe(413);
    expect(svg.statusCode).toBe(400);
    expect(svg.json()).toMatchObject({ code: 'img.type' });
    expect(dims.json()).toMatchObject({ code: 'img.dims', params: { w: 1280, h: 320 } });
    expect(slot.statusCode).toBe(400);
  });

  it('images: DELETE removes the image', async () => {
    // Arrange
    const { app, live, headers, put } = await brandingPanel();
    await put('/api/branding/image/avatar', read('avatar-meta.png'), 'image/png');
    // Act
    const r = await app.inject({ method: 'DELETE', url: '/api/branding/image/avatar', headers: { host: headers.host, origin: headers.origin, cookie: headers.cookie } });
    // Assert
    expect(r.statusCode).toBe(200);
    expect(live.branding.branding.images.avatar).toBeUndefined();
  });

  it('reset goes back to the defaults', async () => {
    // Arrange
    const { app, headers, put } = await brandingPanel();
    await put('/api/branding', JSON.stringify({ name: 'Ana Plays', tags: ['cozy'], theme: { preset: 'ocean', corners: 'soft' } }), 'application/json');
    // Act
    const r = await app.inject({ method: 'POST', url: '/api/branding/reset', headers: headers.json, payload: '{}' });
    // Assert
    expect(r.statusCode).toBe(200);
    expect((r.json() as AdminBrandingState).branding).toMatchObject({ tags: [], links: [], theme: { preset: 'forest' } });
  });

  it('requests without the panel cookie are refused', async () => {
    // Arrange
    const { app, headers } = await brandingPanel();
    // Act
    const r = await app.inject({ method: 'GET', url: '/api/branding', headers: { host: headers.host } });
    // Assert
    expect(r.statusCode).toBe(401);
  });
});
