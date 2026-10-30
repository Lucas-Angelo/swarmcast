import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { ServerMessage } from '@swarmcast/shared';
import { brandingTextSchema, type PublicBranding } from '@swarmcast/shared/branding';
import { defaultConfig } from '../../src/core/config.js';
import type { LiveController } from '../../src/core/live.js';
import type { DirectMode } from '../../src/direct/direct.js';
import { makeController } from '../unit/live-helpers.js';
import { Jar, joinAs } from './helpers.js';

// "Your page" on the real public server: the member gate, caching headers, the limiter, live
// updates, link previews and /healthz.

const fixtures = path.join(import.meta.dirname, '..', 'fixtures', 'branding');
const direct = { noteViewer: vi.fn(), snapshot: () => ({ active: false, viewersSeen: 0 }), active: false, ipChanged: null } as unknown as DirectMode;
const lives: LiveController[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const l of lives.splice(0)) await l.stop().catch(() => {});
});

const MARKER = 'Zebulon Quarterhorse';

async function startLive() {
  const config = defaultConfig();
  config.ports = { rtmp: 0, public: 0, admin: 0, mediamtxHls: 0 };
  config.security.requireBrowserCheck = false;
  const { live } = makeController(direct, { config });
  lives.push(live);
  live.branding.saveText(brandingTextSchema.parse({ name: MARKER, tagline: 'Chill games', links: [{ label: 'Ko-fi', url: 'https://ko-fi.com/ana' }], theme: { preset: 'ocean' } }));
  const avatar = live.branding.putImage('avatar', fs.readFileSync(path.join(fixtures, 'avatar-meta.png')));
  if (!avatar.ok) throw new Error(avatar.code);
  await live.start();
  const base = `http://127.0.0.1:${live.publicPort}`;
  return { live, base, link: live.liveLink!, avatarSha: avatar.ref.sha };
}

describe('branding on the viewer server', () => {
  it('only members (ticket or session) see it; everything else stays stock', async () => {
    const { base, link, avatarSha } = await startLive();
    const stranger = new Jar(base);
    for (const p of ['/', '/join', '/api/brand', `/brand/${avatarSha}.png`, '/nope', '/watch']) {
      const r = await stranger.fetch(p);
      expect(await r.text(), p).not.toContain(MARKER);
      expect(r.status, p).not.toBe(200);
    }
    const css = await stranger.fetch('/brand/theme.css');
    expect(css.status).toBe(200);
    expect(await css.text()).toBe('/* */\n');

    // A ticket holder (link opened, nickname not chosen yet) already sees who is streaming.
    const ticket = new Jar(base);
    await ticket.fetch(link);
    const brand = await ticket.fetch('/api/brand');
    expect(brand.status).toBe(200);
    expect(brand.headers.get('cache-control')).toBe('private, no-cache');
    const body = (await brand.json()) as PublicBranding;
    expect(body).toMatchObject({ name: MARKER, tagline: 'Chill games', theme: { preset: 'ocean' }, avatar: { s256: `/brand/${avatarSha}.png` } });
    expect(body.links).toEqual([{ label: 'Ko-fi', href: 'https://ko-fi.com/ana', display: 'ko-fi.com', platform: 'kofi' }]);
    const etag = brand.headers.get('etag')!;
    expect((await ticket.fetch('/api/brand', { headers: { 'if-none-match': etag } })).status).toBe(304);
    const theme = await ticket.fetch('/brand/theme.css');
    expect(theme.headers.get('content-type')).toMatch(/^text\/css/);
    expect(await theme.text()).toMatch(/^:root\{--sc-accent:#[0-9a-f]{6};/);
  });

  it('images: private immutable caching, sniffed type, nosniff, the viewer CSP, through the upload limiter', async () => {
    const { live, base, link, avatarSha } = await startLive();
    const jar = await joinAs(base, link, 'Ana');
    const spy = vi.spyOn(live.limiter, 'stream');
    const r = await jar.fetch(`/brand/${avatarSha}.png`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toContain("script-src 'self'");
    const bytes = Buffer.from(await r.arrayBuffer());
    expect(bytes.toString('latin1')).not.toContain('MARKER');
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await jar.fetch(`/brand/${avatarSha}.jpg`)).status).toBe(404);
  });

  it('the CSP of a branded page is byte-identical to an unbranded one', async () => {
    const { live, base, link } = await startLive();
    const a = await new Jar(base).fetch(link);
    live.branding.reset();
    const b = await new Jar(base).fetch(live.liveLink!);
    expect(a.headers.get('content-security-policy')).toBe(b.headers.get('content-security-policy'));
  });

  it('a save reaches open viewer pages as one {t:"branding"} message', async () => {
    const { live, base, link } = await startLive();
    const jar = await joinAs(base, link, 'Ana');
    const ws = new WebSocket(`${base.replace('http', 'ws')}/control`, { origin: base, headers: { cookie: jar.header() } });
    sockets.push(ws);
    const messages: ServerMessage[] = [];
    ws.on('message', (d) => {
      const t = String(d);
      if (!t.startsWith('~')) messages.push(JSON.parse(t) as ServerMessage);
    });
    await vi.waitFor(() => expect(messages.some((m) => m.t === 'hello')).toBe(true));
    const hello = messages.find((m) => m.t === 'hello') as Extract<ServerMessage, { t: 'hello' }>;
    expect(hello.brandRev).toBe(live.branding.branding.rev);
    live.branding.saveText(brandingTextSchema.parse({ name: 'New name' }));
    live.brandingChanged();
    live.branding.saveText(brandingTextSchema.parse({ name: 'Newer name' }));
    live.brandingChanged();
    await vi.waitFor(() => expect(messages.filter((m) => m.t === 'branding')).toHaveLength(1), { timeout: 4000 });
    expect(messages.find((m) => m.t === 'branding')).toEqual({ t: 'branding', rev: live.branding.branding.rev });
  });

  it('link previews: preview fetchers get Open Graph tags and no cookie; browsers get the 303; the card dies with "New link"', async () => {
    const { live, link } = await startLive();
    const bot = await fetch(link, { redirect: 'manual', headers: { 'user-agent': 'WhatsApp/2.23.20.0 A', 'accept-language': 'pt-BR' } });
    expect(bot.status).toBe(200);
    expect(bot.headers.get('set-cookie')).toBeNull();
    const html = await bot.text();
    // Preview off (default): the neutral invitation, nothing about the stream.
    expect(html).toContain('Você foi convidado para uma live');
    expect(html).not.toContain(MARKER);
    expect(html).not.toMatch(/<script|<style|og:image"/);

    live.branding.saveText(brandingTextSchema.parse({ ...live.branding.branding, preview: { enabled: true } }));
    const card = live.branding.putImage('card', makeJpeg(1200, 630));
    expect(card.ok).toBe(true);
    const on = await (await fetch(link, { headers: { 'user-agent': 'TelegramBot (like TwitterBot)' } })).text();
    expect(on).toContain(`<meta property="og:title" content="${MARKER} is live">`);
    const img = /og:image" content="([^"]+)"/.exec(on)![1]!;
    expect(img).toMatch(/\/p\/[A-Za-z0-9_-]{22}\/card\.jpg$/);
    expect((await fetch(img)).status).toBe(200);

    const browser = await fetch(link, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 Chrome/140' } });
    expect(browser.status).toBe(303);
    live.rotateLink();
    expect((await fetch(img)).status).toBe(404);
    expect((await fetch(link, { redirect: 'manual', headers: { 'user-agent': 'WhatsApp/2' } })).status).toBe(404);
  });

  it('under attack the page goes lite: no banner, a different ETag; names and links stay', async () => {
    const { live, base, link } = await startLive();
    const banner = live.branding.putImage('banner', makeJpeg(1280, 320));
    expect(banner.ok).toBe(true);
    const jar = await joinAs(base, link, 'Ana');
    const calm = await jar.fetch('/api/brand');
    const calmBody = (await calm.json()) as PublicBranding;
    expect(calmBody.banner?.s1280).toMatch(/^\/brand\/[0-9a-f]{64}\.jpg$/);
    expect(calmBody.lite).toBeUndefined();

    // The shield's own state, as its detector sets it under a flood.
    live.shield.detector.state = 'attack';
    const r = await jar.fetch('/api/brand', { headers: { 'if-none-match': calm.headers.get('etag')! } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as PublicBranding;
    expect(body).toMatchObject({ lite: true, name: MARKER, tagline: 'Chill games' });
    expect(body.banner).toBeUndefined();
    expect(body.links).toHaveLength(1);
    expect(r.headers.get('etag')).not.toBe(calm.headers.get('etag'));
    live.shield.detector.state = 'normal';
  });

  it('/healthz tells which live is on only to our own probe', async () => {
    const { live, base } = await startLive();
    const plain = await fetch(`${base}/healthz`);
    expect(plain.headers.get('x-swarmcast')).toBe('1');
    const own = await fetch(`${base}/healthz`, { headers: { 'x-swarmcast-probe': live.access.probeToken() } });
    expect(own.headers.get('x-swarmcast')).toBe(live.access.liveId);
    const wrong = await fetch(`${base}/healthz`, { headers: { 'x-swarmcast-probe': 'x'.repeat(22) } });
    expect(wrong.headers.get('x-swarmcast')).toBe('1');
  });
});

/** A structurally valid JPEG declaring w × h (the server checks structure and size, not pixels). */
function makeJpeg(w: number, h: number): Buffer {
  const fixture = fs.readFileSync(path.join(fixtures, 'banner-progressive.jpg'));
  // Reuse the fixture's structure but patch the SOF size: the server checks structure and size only.
  const b = Buffer.from(fixture);
  for (let i = 2; i + 9 < b.length; ) {
    const m = b[i + 1]!;
    const len = b.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xc2) {
      b.writeUInt16BE(h, i + 5);
      b.writeUInt16BE(w, i + 7);
      return b;
    }
    i += 2 + len;
  }
  throw new Error('no SOF');
}
