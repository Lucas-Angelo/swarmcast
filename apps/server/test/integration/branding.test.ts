import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { brandingTextSchema, type PublicBranding } from '@swarmcast/shared/branding';
import type { LiveController } from '../../src/core/live.js';
import { Jar, joinAs } from './helpers.js';
import { goLive, openControl, stopViewerLives, viewerLive } from './viewers.js';

// "Your page" on the real public server: the member gate, caching headers, the limiter, live
// updates, link previews and /healthz (a LiveController in this process, see viewers.ts).
//
// Saves reach open pages once: the server pushes {t:"branding"} 2 s after the first save of a
// burst, with the revision of that moment, and a chat round trip after that push proves no
// second one was on its way.
// "Under attack" is the shield detector's own state, set the way its tick sets it under a
// flood (the detector's escalation has its own unit tests: detector.test.ts).

const fixtures = path.join(import.meta.dirname, '..', 'fixtures', 'branding');

/** A name no stock page contains: where it shows, the branding shows. */
const MARKER = 'Zebulon Quarterhorse';

afterEach(stopViewerLives);

/** A live whose page has a name, a tagline, one link, the ocean theme and an avatar. */
async function startBrandedLive(): Promise<{ live: LiveController; base: string; link: string; avatarSha: string }> {
  const live = viewerLive();
  live.branding.saveText(brandingTextSchema.parse({ name: MARKER, tagline: 'Chill games', links: [{ label: 'Ko-fi', url: 'https://ko-fi.com/ana' }], theme: { preset: 'ocean' } }));
  const avatar = live.branding.putImage('avatar', fs.readFileSync(path.join(fixtures, 'avatar-meta.png')));
  if (!avatar.ok) throw new Error(avatar.code);
  return { live, ...(await goLive(live)), avatarSha: avatar.ref.sha };
}

/** A structurally valid JPEG declaring w × h: the fixture with its SOF size patched (the server checks structure and size, not pixels). */
function makeJpeg(w: number, h: number): Buffer {
  const b = Buffer.from(fs.readFileSync(path.join(fixtures, 'banner-progressive.jpg')));
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

describe('branding on the viewer server', () => {
  it('only members (ticket or session) see it; everything else stays stock', async () => {
    // Arrange
    const { base, link, avatarSha } = await startBrandedLive();
    const stranger = new Jar(base);
    const ticket = new Jar(base);
    const strangerPaths = ['/', '/join', '/api/brand', `/brand/${avatarSha}.png`, '/nope', '/watch'];
    // Act
    const strangerPages = [];
    for (const p of strangerPaths) {
      const r = await stranger.fetch(p);
      strangerPages.push({ p, ok: r.status === 200, showsBrand: (await r.text()).includes(MARKER) });
    }
    const strangerCss = await stranger.fetch('/brand/theme.css');
    await ticket.fetch(link);
    const brand = await ticket.fetch('/api/brand');
    const etag = brand.headers.get('etag')!;
    const revalidated = await ticket.fetch('/api/brand', { headers: { 'if-none-match': etag } });
    const theme = await ticket.fetch('/brand/theme.css');
    // Assert
    expect(strangerPages).toEqual(strangerPaths.map((p) => ({ p, ok: false, showsBrand: false })));
    expect(strangerCss.status).toBe(200);
    expect(await strangerCss.text()).toBe('/* */\n');
    expect(brand.status).toBe(200);
    expect(brand.headers.get('cache-control')).toBe('private, no-cache');
    const body = (await brand.json()) as PublicBranding;
    expect(body).toMatchObject({ name: MARKER, tagline: 'Chill games', theme: { preset: 'ocean' }, avatar: { s256: `/brand/${avatarSha}.png` } });
    expect(body.links).toEqual([{ label: 'Ko-fi', href: 'https://ko-fi.com/ana', display: 'ko-fi.com', platform: 'kofi' }]);
    expect(revalidated.status).toBe(304);
    expect(theme.headers.get('content-type')).toMatch(/^text\/css/);
    expect(await theme.text()).toMatch(/^:root\{--sc-accent:#[0-9a-f]{6};/);
  });

  it('images: private immutable caching, sniffed type, nosniff, the viewer CSP, through the upload limiter', async () => {
    // Arrange
    const { live, base, link, avatarSha } = await startBrandedLive();
    const jar = await joinAs(base, link, 'Ana');
    const limited = vi.spyOn(live.limiter, 'stream');
    // Act
    const r = await jar.fetch(`/brand/${avatarSha}.png`);
    const bytes = Buffer.from(await r.arrayBuffer());
    const wrongExtension = await jar.fetch(`/brand/${avatarSha}.jpg`);
    // Assert
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(bytes.toString('latin1')).not.toContain('MARKER');
    expect(limited).toHaveBeenCalledTimes(1);
    expect(wrongExtension.status).toBe(404);
  });

  it('the CSP of a branded page is byte-identical to an unbranded one', async () => {
    // Arrange
    const { live, base, link } = await startBrandedLive();
    // Act
    const branded = await new Jar(base).fetch(link);
    live.branding.reset();
    const stock = await new Jar(base).fetch(live.liveLink!);
    // Assert
    expect(branded.headers.get('content-security-policy')).toBe(stock.headers.get('content-security-policy'));
  });

  it('two saves reach open viewer pages as one {t:"branding"} message, with the last revision', async () => {
    // Arrange
    const { live, base, link } = await startBrandedLive();
    const page = await openControl(base, await joinAs(base, link, 'Ana'));
    const revAtHello = live.branding.branding.rev;
    // Act
    live.branding.saveText(brandingTextSchema.parse({ name: 'New name' }));
    live.brandingChanged();
    live.branding.saveText(brandingTextSchema.parse({ name: 'Newer name' }));
    live.brandingChanged();
    await page.next('branding');
    page.send({ t: 'chat.send', n: 1, text: 'round trip' });
    await page.next('chat.ack');
    // Assert
    expect(page.hello.brandRev).toBe(revAtHello);
    expect(page.all('branding')).toEqual([{ t: 'branding', rev: live.branding.branding.rev }]);
  });

  it('link previews: preview fetchers get Open Graph tags and no cookie; browsers get the 303; the card dies with "New link"', async () => {
    // Arrange
    const { live, link } = await startBrandedLive();
    // Act
    const previewOff = await fetch(link, { redirect: 'manual', headers: { 'user-agent': 'WhatsApp/2.23.20.0 A', 'accept-language': 'pt-BR' } });
    const previewOffHtml = await previewOff.text();
    // Assert
    expect(previewOff.status).toBe(200);
    expect(previewOff.headers.get('set-cookie')).toBeNull();
    expect(previewOffHtml).toContain('Você foi convidado para uma live');
    expect(previewOffHtml).not.toContain(MARKER);
    expect(previewOffHtml).not.toMatch(/<script|<style|og:image"/);
    // Act
    live.branding.saveText(brandingTextSchema.parse({ ...live.branding.branding, preview: { enabled: true } }));
    const card = live.branding.putImage('card', makeJpeg(1200, 630));
    const previewOn = await (await fetch(link, { headers: { 'user-agent': 'TelegramBot (like TwitterBot)' } })).text();
    const img = /og:image" content="([^"]+)"/.exec(previewOn)?.[1] ?? '';
    const cardWhileLive = await fetch(img);
    const browser = await fetch(link, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 Chrome/140' } });
    // Assert
    expect(card.ok).toBe(true);
    expect(previewOn).toContain(`<meta property="og:title" content="${MARKER} is live">`);
    expect(img).toMatch(/\/p\/[A-Za-z0-9_-]{22}\/card\.jpg$/);
    expect(cardWhileLive.status).toBe(200);
    expect(browser.status).toBe(303);
    // Act
    live.rotateLink();
    const cardAfter = await fetch(img);
    const oldLinkPreview = await fetch(link, { redirect: 'manual', headers: { 'user-agent': 'WhatsApp/2' } });
    // Assert
    expect(cardAfter.status).toBe(404);
    expect(oldLinkPreview.status).toBe(404);
  });

  it('under attack the page goes lite: no banner, a different ETag; names and links stay', async () => {
    // Arrange
    const { live, base, link } = await startBrandedLive();
    const banner = live.branding.putImage('banner', makeJpeg(1280, 320));
    const jar = await joinAs(base, link, 'Ana');
    const calm = await jar.fetch('/api/brand');
    const calmBody = (await calm.json()) as PublicBranding;
    // Act
    live.shield.detector.state = 'attack';
    const underAttack = await jar.fetch('/api/brand', { headers: { 'if-none-match': calm.headers.get('etag')! } });
    const body = (await underAttack.json()) as PublicBranding;
    // Assert
    expect(banner.ok).toBe(true);
    expect(calmBody.banner?.s1280).toMatch(/^\/brand\/[0-9a-f]{64}\.jpg$/);
    expect(calmBody.lite).toBeUndefined();
    expect(underAttack.status).toBe(200);
    expect(body).toMatchObject({ lite: true, name: MARKER, tagline: 'Chill games' });
    expect(body.banner).toBeUndefined();
    expect(body.links).toHaveLength(1);
    expect(underAttack.headers.get('etag')).not.toBe(calm.headers.get('etag'));
  });

  it('/healthz tells which live is on only to our own probe', async () => {
    // Arrange
    const { live, base } = await startBrandedLive();
    // Act
    const plain = await fetch(`${base}/healthz`);
    const own = await fetch(`${base}/healthz`, { headers: { 'x-swarmcast-probe': live.access.probeToken() } });
    const wrong = await fetch(`${base}/healthz`, { headers: { 'x-swarmcast-probe': 'x'.repeat(22) } });
    // Assert
    expect(plain.headers.get('x-swarmcast')).toBe('1');
    expect(own.headers.get('x-swarmcast')).toBe(live.access.liveId);
    expect(wrong.headers.get('x-swarmcast')).toBe('1');
  });
});
