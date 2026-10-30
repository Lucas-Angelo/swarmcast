import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Page, Route } from '@playwright/test';
import { contrastRatio } from '@swarmcast/shared';
import { buildPixPayload, defaultBranding, deriveTheme, qrMatrix, type AdminBrandingState, type Branding, type BrandSlot } from '@swarmcast/shared/branding';
import { adminApi, expect, test } from './fixtures.js';

// "Your page" card in the panel (BR5) and its Pix part (BR6). The panel's branding API is
// mocked with page.route, following docs/BRANDING.md (GET/PUT /api/branding, PUT/DELETE
// /api/branding/image/:slot with the raw image bytes, the panel file route, POST reset): this
// spec checks the card, the canvas re-encode and the preview, not the server (integration tests
// cover the routes). Only fake data: "Ana Plays", a random Pix key from the docs.

function env(): { adminLoginUrl: string } {
  return JSON.parse(fs.readFileSync(path.join('test-results', 'e2e-env.json'), 'utf8')) as { adminLoginUrl: string };
}

async function openPanel(page: Page, lang?: string): Promise<void> {
  const url = env().adminLoginUrl;
  const origin = new URL(url).origin;
  await page.goto(url);
  await expect(page).toHaveURL(`${origin}/`);
  await expect(page.getByTestId('status')).toBeVisible();
  if (lang) {
    await page.goto(`${origin}/?lang=${lang}`);
    await expect(page.getByTestId('status')).toBeVisible();
  }
  await page.getByTestId('brand-card').scrollIntoViewIfNeeded();
}

interface Upload {
  slot: BrandSlot;
  type: string;
  bytes: Buffer;
}

/** A fake branding API in the page (docs/BRANDING.md contract). */
async function mockBranding(page: Page): Promise<{ puts: unknown[]; uploads: Upload[]; state: () => Branding }> {
  let branding: Branding = defaultBranding();
  const files = new Map<string, { type: string; bytes: Buffer }>();
  const images: Partial<Record<BrandSlot, string>> = {};
  const puts: unknown[] = [];
  const uploads: Upload[] = [];
  const answer = (route: Route, wrap?: (s: AdminBrandingState) => unknown): Promise<void> => {
    const state: AdminBrandingState = {
      branding,
      derived: deriveTheme(branding.theme),
      images,
      public: { rev: branding.rev, tags: branding.tags, links: [], theme: { preset: branding.theme.preset, corners: branding.theme.corners }, showCredit: branding.showCredit },
      disk: { files: files.size, bytes: [...files.values()].reduce((n, f) => n + f.bytes.length, 0) },
    };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(wrap ? wrap(state) : state) });
  };
  await page.route(/\/api\/branding(\/.*)?$/, async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (p === '/api/branding' && req.method() === 'GET') return answer(route);
    if (p === '/api/branding' && req.method() === 'PUT') {
      const body = req.postDataJSON() as Partial<Branding>;
      puts.push(body);
      branding = { ...branding, ...body, images: branding.images, rev: branding.rev + 1 } as Branding;
      return answer(route);
    }
    const img = /^\/api\/branding\/image\/([a-z0-9]+)$/.exec(p);
    if (img && req.method() === 'PUT') {
      const bytes = req.postDataBuffer() ?? Buffer.alloc(0);
      const type = (await req.headerValue('content-type')) ?? '';
      const slot = img[1] as BrandSlot;
      uploads.push({ slot, type, bytes });
      const sha = crypto.createHash('sha256').update(bytes).digest('hex');
      const ext = type === 'image/png' ? 'png' : type === 'image/jpeg' ? 'jpg' : 'webp';
      files.set(`${sha}.${ext}`, { type, bytes });
      images[slot] = `/api/branding/file/${sha}.${ext}`;
      // Like apps/server/src/branding/admin-routes.ts: the stored reference and the new state.
      return answer(route, (state) => ({ ref: { sha, bytes: bytes.length }, state }));
    }
    if (img && req.method() === 'DELETE') {
      delete images[img[1] as BrandSlot];
      return answer(route);
    }
    const file = /^\/api\/branding\/file\/([0-9a-f]{64}\.(png|jpg|webp))$/.exec(p);
    if (file && files.has(file[1]!)) {
      const f = files.get(file[1]!)!;
      return route.fulfill({ status: 200, contentType: f.type, body: f.bytes });
    }
    if (p === '/api/branding/reset') {
      branding = defaultBranding();
      for (const k of Object.keys(images)) delete images[k as BrandSlot];
      return answer(route);
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not found"}' });
  });
  return { puts, uploads, state: () => branding };
}

/**
 * A JPEG "phone photo" with EXIF: camera make "SCFIXTURE-CAM" and a GPS block (latitude 23°S).
 * The base JPEG comes from the page's own canvas; the APP1 segment is spliced in after SOI.
 */
async function photoWithGps(page: Page, w: number, h: number): Promise<Buffer> {
  const dataUrl = await page.evaluate(
    ([w, h]) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d')!;
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#0f5c53');
      g.addColorStop(1, '#f2b441');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#fffdf8';
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, Math.min(w, h) / 3, 0, Math.PI * 2);
      ctx.fill();
      return c.toDataURL('image/jpeg', 0.9);
    },
    [w, h] as const,
  );
  const jpeg = Buffer.from(dataUrl.split(',')[1]!, 'base64');
  // TIFF (big endian): IFD0 { Make, GPSInfo } → GPS IFD { GPSLatitudeRef "S", GPSLatitude 23/1 0/1 0/1 }.
  const make = Buffer.from('SCFIXTURE-CAM\0', 'latin1');
  const ifd0 = 8;
  const ifd0Size = 2 + 2 * 12 + 4;
  const makeAt = ifd0 + ifd0Size;
  const gpsAt = makeAt + make.length;
  const gpsSize = 2 + 2 * 12 + 4;
  const latAt = gpsAt + gpsSize;
  const tiff = Buffer.alloc(latAt + 24);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(ifd0, 4);
  let o = ifd0;
  tiff.writeUInt16BE(2, o);
  o += 2;
  tiff.writeUInt16BE(0x010f, o);
  tiff.writeUInt16BE(2, o + 2);
  tiff.writeUInt32BE(make.length, o + 4);
  tiff.writeUInt32BE(makeAt, o + 8);
  o += 12;
  tiff.writeUInt16BE(0x8825, o);
  tiff.writeUInt16BE(4, o + 2);
  tiff.writeUInt32BE(1, o + 4);
  tiff.writeUInt32BE(gpsAt, o + 8);
  o += 12;
  tiff.writeUInt32BE(0, o);
  make.copy(tiff, makeAt);
  o = gpsAt;
  tiff.writeUInt16BE(2, o);
  o += 2;
  tiff.writeUInt16BE(0x0001, o);
  tiff.writeUInt16BE(2, o + 2);
  tiff.writeUInt32BE(2, o + 4);
  tiff.write('S\0', o + 8, 'latin1');
  o += 12;
  tiff.writeUInt16BE(0x0002, o);
  tiff.writeUInt16BE(5, o + 2);
  tiff.writeUInt32BE(3, o + 4);
  tiff.writeUInt32BE(latAt, o + 8);
  o += 12;
  tiff.writeUInt32BE(0, o);
  [23, 1, 0, 1, 0, 1].forEach((v, i) => tiff.writeUInt32BE(v, latAt + i * 4));
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), app1, payload, jpeg.subarray(2)]);
}

const rgb = (css: string): string => {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css);
  if (!m) throw new Error(`not an rgb colour: ${css}`);
  return `#${[m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('')}`;
};

/** Contrast of the preview's support button (against the page, and its label on it) and of its links. */
async function previewContrast(page: Page): Promise<{ button: number; label: number; link: number }> {
  const c = await page.evaluate(() => {
    const css = (sel: string, prop: string): string => getComputedStyle(document.querySelector(sel)!).getPropertyValue(prop);
    return {
      bg: css('[data-testid="brand-preview"]', 'background-color'),
      btn: css('[data-testid="brand-preview"] .sc-brand-support', 'background-color'),
      label: css('[data-testid="brand-preview"] .sc-brand-support', 'color'),
      link: css('[data-testid="brand-preview"] .sc-brand-link', 'color'),
      surface: css('[data-testid="brand-preview"] .sc-brand-about', 'background-color'),
    };
  });
  return { button: contrastRatio(rgb(c.btn), rgb(c.bg)), label: contrastRatio(rgb(c.label), rgb(c.btn)), link: contrastRatio(rgb(c.link), rgb(c.surface)) };
}

test('Your page: name, pictures, about, links, colour and Save, with a faithful preview', { tag: '@ui' }, async ({ page, browserName }) => {
  const api = await mockBranding(page);
  await openPanel(page);
  const card = page.getByTestId('brand-card');
  const preview = card.getByTestId('brand-preview');
  await expect(card.getByRole('heading', { name: 'Your page' })).toBeVisible();
  await expect(card.getByTestId('brand-save')).toBeDisabled();

  // 1 · Name and pictures (through the real file input: each engine's canvas pipeline runs).
  await card.getByTestId('brand-name').fill('Ana Plays');
  await expect(preview.locator('.sc-brand-name')).toHaveText('Ana Plays');
  await card.getByTestId('brand-file-avatar').setInputFiles({ name: 'me.jpg', mimeType: 'image/jpeg', buffer: await photoWithGps(page, 900, 700) });
  await card.getByTestId('brand-use-avatar').click();
  await expect.poll(() => api.uploads.map((u) => u.slot)).toEqual(['avatar', 'avatar128', 'fav32', 'fav180']);
  await expect(preview.locator('img.sc-brand-avatar')).toHaveAttribute('src', /^\/api\/branding\/file\/[0-9a-f]{64}\.(webp|png|jpg)$/);
  await card.getByTestId('brand-file-banner').setInputFiles({ name: 'banner.jpg', mimeType: 'image/jpeg', buffer: await photoWithGps(page, 1600, 500) });
  await card.getByTestId('brand-use-banner').click();
  await expect.poll(() => api.uploads.length).toBe(6);
  await expect(preview.getByTestId('bp-banner')).toBeVisible();
  const sizes: Record<string, [number, number, number]> = { avatar: [256, 256, 64], avatar128: [128, 128, 24], fav32: [32, 32, 6], fav180: [180, 180, 32], banner: [1280, 320, 150], banner640: [640, 160, 50] };
  for (const u of api.uploads) {
    const [w, h, kb] = sizes[u.slot]!;
    expect(['image/webp', 'image/png', 'image/jpeg'], u.slot).toContain(u.type);
    expect(u.bytes.length, `${u.slot} bytes`).toBeLessThanOrEqual(kb * 1024);
    // The photo's camera make and GPS block never leave the panel (canvas re-encode). WebKit adds
    // its own small EXIF block and Chromium an sRGB profile; the server strips those (BR0).
    expect(u.bytes.includes(Buffer.from('SCFIXTURE')), `${u.slot}: original EXIF`).toBe(false);
    if (browserName === 'chromium') expect(u.bytes.includes(Buffer.from('Exif\0\0')), `${u.slot}: EXIF`).toBe(false);
    const dims = await page.evaluate(async ([b64, type]) => {
      const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type }));
      return [bmp.width, bmp.height];
    }, [u.bytes.toString('base64'), u.type] as const);
    expect(dims, `${u.slot} size`).toEqual([w, h]);
  }

  // 2 · About you.
  await card.getByTestId('brand-section-about').click();
  await card.getByTestId('brand-tagline').fill('Chill games and chat every Friday');
  await card.getByTestId('brand-about').fill('Hi! I stream cozy games.\nBring tea.');
  for (const tag of ['cozy', 'indie']) {
    await card.getByTestId('brand-tag-input').fill(tag);
    await card.getByTestId('brand-tag-input').press('Enter');
  }
  await expect(preview.locator('.sc-brand-tagline')).toHaveText('Chill games and chat every Friday');
  await expect(preview.locator('.sc-brand-about-text')).toHaveText('Hi! I stream cozy games.\nBring tea.');
  await expect(preview.locator('.sc-brand-tag')).toHaveText(['cozy', 'indie']);

  // 3 · Links and support: a bad link is explained and never reaches the preview.
  await card.getByTestId('brand-section-links').click();
  const links: Array<[string, string, string]> = [
    ['YouTube', 'youtube.com/@ana', 'https://youtube.com/@ana'],
    ['Instagram', 'https://www.instagram.com/ana', 'https://www.instagram.com/ana'],
    ['E-mail', 'ana@example.org', 'mailto:ana@example.org'],
  ];
  for (const [i, [label, url]] of links.entries()) {
    await card.getByTestId('brand-link-add').click();
    await card.getByTestId('brand-link-label').nth(i).fill(label);
    await card.getByTestId('brand-link-url').nth(i).fill(url);
  }
  await card.getByTestId('brand-link-add').click();
  await card.getByTestId('brand-link-label').nth(3).fill('Trap');
  await card.getByTestId('brand-link-url').nth(3).fill('javascript:alert(1)');
  await expect(card.getByTestId('brand-link-error')).toHaveText('Only https:// links (or an e-mail address) are allowed.');
  await expect(card.getByTestId('brand-save')).toBeDisabled();
  await expect(preview.locator('a.sc-brand-link')).toHaveCount(3);
  await card.getByTestId('brand-link-row').nth(3).getByRole('button', { name: 'Remove' }).click();
  for (const [i, [, , href]] of links.entries()) {
    const a = preview.locator('a.sc-brand-link').nth(i);
    await expect(a).toHaveAttribute('href', href);
    if (href.startsWith('https:')) {
      await expect(a).toHaveAttribute('target', '_blank');
      expect((await a.getAttribute('rel'))!.split(' ').sort()).toEqual(['nofollow', 'noopener', 'noreferrer']);
    }
  }
  await expect(preview.locator('a[href^="javascript"]')).toHaveCount(0);
  await card.getByTestId('brand-support-link').check();
  await card.getByTestId('brand-support-url').fill('ko-fi.com/ana');
  await expect(preview.locator('a.sc-brand-support')).toHaveText('Support');
  await expect(preview.locator('a.sc-brand-support')).toHaveAttribute('href', 'https://ko-fi.com/ana');

  // 4 · Colours: a custom colour, readable in both modes.
  await card.getByTestId('brand-section-colours').click();
  await card.getByTestId('brand-preset-custom').click();
  await card.getByTestId('brand-accent').fill('#f5d90a');
  await expect(card.getByTestId('brand-theme-adjusted')).toBeVisible();
  for (const mode of ['bp-light', 'bp-dark'] as const) {
    await card.getByTestId(mode).click();
    const c = await previewContrast(page);
    expect(c.button, `${mode} button vs page`).toBeGreaterThanOrEqual(3);
    expect(c.label, `${mode} button label`).toBeGreaterThanOrEqual(4.5);
    expect(c.link, `${mode} link`).toBeGreaterThanOrEqual(4.5);
  }

  // 5 · Share: preview card stays off by default, the credit can be hidden.
  await card.getByTestId('brand-section-share').click();
  await expect(card.getByTestId('brand-preview-card')).not.toBeChecked();
  await card.getByTestId('brand-ended').fill('Thanks! Back on Friday at 8 pm');
  await card.getByTestId('bp-tab-ended').click();
  await expect(preview.getByTestId('bp-ended')).toHaveText('Thanks! Back on Friday at 8 pm');
  await card.getByTestId('bp-tab-join').click();
  await expect(preview.getByTestId('bp-join-title')).toHaveText("Join Ana Plays's stream");

  await card.getByTestId('brand-save').click();
  await expect(card.getByTestId('brand-saved')).toBeVisible();
  expect(api.puts).toHaveLength(1);
  expect(api.puts[0]).toMatchObject({
    enabled: true,
    name: 'Ana Plays',
    tagline: 'Chill games and chat every Friday',
    about: 'Hi! I stream cozy games.\nBring tea.',
    tags: ['cozy', 'indie'],
    links: links.map(([label, , url]) => ({ label, url })),
    support: { enabled: true, label: 'support', mode: 'link', url: 'https://ko-fi.com/ana' },
    theme: { preset: 'custom', accent: '#f5d90a', corners: 'round' },
    preview: { enabled: false },
    endedMessage: 'Thanks! Back on Friday at 8 pm',
    showCredit: true,
  });
  await expect(card.getByTestId('brand-save')).toBeDisabled();
});

test('Your page: Pix with copy key, "copia e cola" and a QR code, and the privacy warning', { tag: '@ui' }, async ({ page }) => {
  // Copies are recorded in the page: the test never touches the machine's real clipboard.
  await page.addInitScript(() => {
    const w = window as unknown as { __copied: string[] };
    w.__copied = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (s: string) => void w.__copied.push(s) } });
  });
  await mockBranding(page);
  await openPanel(page);
  const card = page.getByTestId('brand-card');
  await card.getByTestId('brand-name').fill('Ana Plays');
  await card.getByTestId('brand-section-links').click();
  await card.getByTestId('brand-support-pix').check();
  await expect(card.getByTestId('brand-pix-warning')).toHaveText('Anyone who sends you a Pix sees your full legal name and part of your CPF. If you want to stay anonymous, use a tip service instead.');

  // A CPF key is shown to everyone: Save waits for an explicit confirmation.
  await card.getByTestId('brand-pix-type').selectOption('cpf');
  await card.getByTestId('brand-pix-key').fill('529.982.247-25');
  await card.getByTestId('brand-pix-name').fill('Ana Lima');
  await card.getByTestId('brand-pix-city').fill('São Paulo');
  await expect(card.getByTestId('brand-pix-confirm')).toBeVisible();
  await expect(card.getByTestId('brand-save')).toBeDisabled();
  await card.getByTestId('brand-pix-confirm').check();
  await expect(card.getByTestId('brand-save')).toBeEnabled();

  // The recommended random key needs no confirmation.
  const key = '123e4567-e89b-12d3-a456-426614174000';
  await card.getByTestId('brand-pix-type').selectOption('evp');
  await card.getByTestId('brand-pix-key').fill(key);
  await expect(card.getByTestId('brand-pix-confirm')).toHaveCount(0);
  const expected = buildPixPayload({ key, name: 'Ana Lima', city: 'São Paulo' });
  if (!expected.ok) throw new Error('fixture payload');
  await expect(card.getByTestId('brand-pix-code')).toHaveText(expected.payload);
  await expect(card.getByTestId('brand-pix-qr')).toBeVisible();

  // The viewer's Pix sheet in the preview.
  const preview = card.getByTestId('brand-preview');
  await preview.getByTestId('bp-support').click();
  const sheet = preview.getByTestId('bp-pix-sheet');
  await expect(sheet.getByTestId('bp-pix-key')).toHaveText(key);
  await expect(sheet.getByTestId('bp-pix-code')).toHaveText(expected.payload);
  await expect(sheet.getByTestId('bp-pix-qr')).toBeVisible();
  // The canvas shows exactly the shared encoder's matrix (whose output lane A's unit tests decode
  // with an independent reader): sample the centre of every module, quiet zone of 4 modules.
  const matrix = qrMatrix(expected.payload);
  const drawn = await sheet.getByTestId('bp-pix-qr').evaluate((c, n) => {
    const canvas = c as HTMLCanvasElement;
    const scale = canvas.width / (n + 8);
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    const rows: boolean[][] = [];
    for (let y = 0; y < n; y++) {
      const row: boolean[] = [];
      for (let x = 0; x < n; x++) {
        const px = Math.floor((x + 4.5) * scale);
        const py = Math.floor((y + 4.5) * scale);
        row.push(data[(py * canvas.width + px) * 4]! < 128);
      }
      rows.push(row);
    }
    return rows;
  }, matrix.length);
  expect(drawn).toEqual(matrix);
  await sheet.getByTestId('bp-pix-copy-code').click();
  await expect(sheet.getByTestId('bp-pix-copy-code')).toHaveText('Copied ✓');
  await sheet.getByTestId('bp-pix-copy-key').click();
  await expect(sheet.getByTestId('bp-pix-copy-key')).toHaveText('Copied ✓');
  expect(await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual([expected.payload, key]);
});

test('Your page is translated to pt-BR (support button "Apoiar")', { tag: '@ui' }, async ({ page }) => {
  await mockBranding(page);
  await openPanel(page, 'pt-BR');
  const card = page.getByTestId('brand-card');
  await expect(card.getByRole('heading', { name: 'Sua página' })).toBeVisible();
  await card.getByTestId('brand-name').fill('Ana Plays');
  await card.getByTestId('brand-section-links').click();
  await card.getByTestId('brand-support-link').check();
  await card.getByTestId('brand-support-url').fill('https://livepix.gg/ana');
  await expect(card.getByTestId('brand-preview').locator('.sc-brand-support')).toHaveText('Apoiar');
  await card.getByTestId('brand-link-add').click();
  await card.getByTestId('brand-link-label').fill('Roteador');
  await card.getByTestId('brand-link-url').fill('https://192.168.0.1');
  await expect(card.getByTestId('brand-link-error')).toHaveText('Esse endereço aponta para um aparelho da sua rede, os espectadores não conseguem abrir.');
  await card.getByTestId('brand-support-pix').check();
  await expect(card.getByTestId('brand-pix-warning')).toHaveText('Quem te mandar um Pix vê seu nome completo e parte do seu CPF. Se quiser ficar anônimo, use um serviço de gorjetas.');
  await card.getByTestId('brand-section-identity').click();
  await card.getByTestId('brand-file-avatar').setInputFiles({ name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') });
  await expect(card.getByTestId('brand-image-error-avatar')).toHaveText('SVG não é aceito. Exporte seu logo como PNG.');
});

test('Your page against the real server routes: the name and a picture are saved, then reset', { tag: '@ui' }, async ({ page }) => {
  // No mock: the panel's calls must match apps/server/src/branding/admin-routes.ts.
  await adminApi('POST', '/api/branding/reset', {});
  await openPanel(page);
  const card = page.getByTestId('brand-card');
  await card.getByTestId('brand-name').fill('Ana Plays');
  await card.getByTestId('brand-save').click();
  await expect(card.getByTestId('brand-saved')).toBeVisible();
  await expect.poll(async () => (await adminApi<AdminBrandingState>('GET', '/api/branding')).branding.name).toBe('Ana Plays');
  await card.getByTestId('brand-file-avatar').setInputFiles({ name: 'me.jpg', mimeType: 'image/jpeg', buffer: await photoWithGps(page, 600, 600) });
  await card.getByTestId('brand-use-avatar').click();
  await expect.poll(async () => Object.keys((await adminApi<AdminBrandingState>('GET', '/api/branding')).images).sort()).toEqual(['avatar', 'avatar128', 'fav180', 'fav32']);
  await expect(card.getByTestId('brand-preview').locator('img.sc-brand-avatar')).toHaveAttribute('src', /^\/api\/branding\/file\/[0-9a-f]{64}\.(webp|png|jpg)$/);
  // The preview's picture is served by the panel's own file route.
  const src = (await card.getByTestId('brand-preview').locator('img.sc-brand-avatar').getAttribute('src'))!;
  expect((await page.request.get(new URL(src, page.url()).href)).status()).toBe(200);
  await adminApi('POST', '/api/branding/reset', {});
});

test('Your page without branding routes on the server: defaults, a note, nothing breaks', { tag: '@ui' }, async ({ page }) => {
  await page.route(/\/api\/branding(\/.*)?$/, (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not Found"}' }));
  await openPanel(page);
  const card = page.getByTestId('brand-card');
  await expect(card.getByTestId('brand-unavailable')).toBeVisible();
  await card.getByTestId('brand-name').fill('Ana Plays');
  await expect(card.getByTestId('brand-preview').locator('.sc-brand-name')).toHaveText('Ana Plays');
  await expect(card.getByTestId('brand-save')).toBeDisabled();
  await expect(page.getByTestId('error')).toHaveCount(0);
});

// Screenshots of the card for the site guides: only when asked (BRAND_SCREENSHOTS=<dir>).
test('Your page screenshots', { tag: '@ui' }, async ({ page, browserName }) => {
  const dir = process.env.BRAND_SCREENSHOTS;
  test.skip(!dir || browserName !== 'chromium', 'set BRAND_SCREENSHOTS=<dir> (chromium) to capture the card');
  for (const lang of ['en', 'pt-BR'] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 1280, height: 1000 });
      await mockBranding(page);
      await openPanel(page, lang === 'en' ? undefined : lang);
      const card = page.getByTestId('brand-card');
      await card.getByTestId('brand-name').fill('Ana Plays');
      await card.getByTestId('brand-file-avatar').setInputFiles({ name: 'me.jpg', mimeType: 'image/jpeg', buffer: await photoWithGps(page, 600, 600) });
      await card.getByTestId('brand-use-avatar').click();
      await expect(card.getByTestId('brand-preview').locator('img.sc-brand-avatar')).toBeVisible();
      await card.getByTestId('brand-file-banner').setInputFiles({ name: 'b.jpg', mimeType: 'image/jpeg', buffer: await photoWithGps(page, 1600, 400) });
      await card.getByTestId('brand-use-banner').click();
      await expect(card.getByTestId('bp-banner')).toBeVisible();
      await card.getByTestId('brand-section-about').click();
      await card.getByTestId('brand-tagline').fill(lang === 'en' ? 'Chill games and chat every Friday' : 'Jogos tranquilos e papo toda sexta');
      await card.getByTestId('brand-about').fill(lang === 'en' ? 'Hi! I stream cozy indie games.\nBring tea.' : 'Oi! Faço live de jogos indie tranquilos.\nTraga um chá.');
      for (const tag of ['cozy', 'indie']) {
        await card.getByTestId('brand-tag-input').fill(tag);
        await card.getByTestId('brand-tag-input').press('Enter');
      }
      await card.getByTestId('brand-section-links').click();
      await card.getByTestId('brand-link-add').click();
      await card.getByTestId('brand-link-label').fill('YouTube');
      await card.getByTestId('brand-link-url').fill('youtube.com/@anaplays');
      await card.getByTestId('brand-link-add').click();
      await card.getByTestId('brand-link-label').nth(1).fill('Instagram');
      await card.getByTestId('brand-link-url').nth(1).fill('instagram.com/anaplays');
      await card.getByTestId('bp-' + scheme).click();
      fs.mkdirSync(dir!, { recursive: true });
      await card.screenshot({ path: path.join(dir!, `your-page-${lang}-${scheme}-links.png`) });
      await card.getByTestId('brand-support-pix').check();
      await card.getByTestId('brand-pix-key').fill('123e4567-e89b-12d3-a456-426614174000');
      await card.getByTestId('brand-pix-name').fill('Ana Lima');
      await card.getByTestId('brand-pix-city').fill('Sao Paulo');
      await card.getByTestId('bp-support').click();
      await expect(card.getByTestId('bp-pix-sheet')).toBeVisible();
      await card.screenshot({ path: path.join(dir!, `your-page-${lang}-${scheme}-pix.png`) });
      await card.getByTestId('bp-phone').click();
      await card.getByTestId('brand-section-colours').click();
      await card.getByTestId('brand-preset-ocean').click();
      await card.getByTestId('brand-preview').screenshot({ path: path.join(dir!, `your-page-${lang}-${scheme}-phone-preview.png`) });
      await card.getByTestId('bp-tab-join').click();
      await card.getByTestId('brand-preview').screenshot({ path: path.join(dir!, `your-page-${lang}-${scheme}-join.png`) });
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    }
  }
});
