// The "Your page" card in the panel (BR5) and its Pix part (BR6). The panel's branding API is
// mocked with page.route, following docs/BRANDING.md (GET/PUT /api/branding, PUT/DELETE
// /api/branding/image/:slot with the raw image bytes, the panel file route, POST reset): this
// spec checks the card, the canvas re-encode and the preview, not the server (integration tests
// cover the routes), except one test against the real routes. Only fake data: "Ana Plays", a
// random Pix key from the docs.
//
// Pictures go through the real file input, so each engine's canvas pipeline runs, and the
// photo's camera make and GPS block never leave the panel (canvas re-encode). WebKit adds its own
// small EXIF block and Chromium an sRGB profile; the server strips those (BR0), so only Chromium
// is held to "no EXIF at all". A bad link is explained and never reaches the preview; a custom
// colour stays readable in both modes; the share preview card stays off by default. A CPF key
// is shown to everyone, so Save waits for an explicit confirmation; the recommended random key
// needs none. The Pix QR canvas shows exactly the shared encoder's matrix (whose output lane A's
// unit tests decode with an independent reader): the test samples the centre of every module,
// with a quiet zone of 4 modules. Copies are recorded in the page: the test never touches the
// machine's real clipboard.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page, Route } from '@playwright/test';
import { contrastRatio } from '@swarmcast/shared';
import { buildPixPayload, defaultBranding, deriveTheme, qrMatrix, type AdminBrandingState, type Branding, type BrandSlot } from '@swarmcast/shared/branding';
import { adminApi, expect, openPanel, test } from './fixtures.js';

/** The panel (English or `lang`) scrolled to its "Your page" card. */
async function openBrandCard(page: Page, lang?: 'en' | 'pt-BR'): Promise<Locator> {
  await openPanel(page, lang);
  const card = page.getByTestId('brand-card');
  await card.scrollIntoViewIfNeeded();
  return card;
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

/** Upload size limits per slot: width, height and KB (BR0). */
const SIZES: Record<string, [number, number, number]> = { avatar: [256, 256, 64], avatar128: [128, 128, 24], fav32: [32, 32, 6], fav180: [180, 180, 32], banner: [1280, 320, 150], banner640: [640, 160, 50] };

const LINKS: Array<[label: string, typed: string, href: string]> = [
  ['YouTube', 'youtube.com/@ana', 'https://youtube.com/@ana'],
  ['Instagram', 'https://www.instagram.com/ana', 'https://www.instagram.com/ana'],
  ['E-mail', 'ana@example.org', 'mailto:ana@example.org'],
];

const PIX_KEY = '123e4567-e89b-12d3-a456-426614174000';

/** Width and height of an uploaded picture, decoded by the page's own engine. */
function decodedSize(page: Page, u: Upload): Promise<number[]> {
  return page.evaluate(async ([b64, type]) => {
    const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type }));
    return [bmp.width, bmp.height];
  }, [u.bytes.toString('base64'), u.type] as const);
}

/** The dark modules of the QR code drawn on `canvas`, sampled at the centre of each module (quiet zone of 4). */
function drawnQr(canvas: Locator, n: number): Promise<boolean[][]> {
  return canvas.evaluate((c, size) => {
    const el = c as HTMLCanvasElement;
    const scale = el.width / (size + 8);
    const data = el.getContext('2d')!.getImageData(0, 0, el.width, el.height).data;
    const rows: boolean[][] = [];
    for (let y = 0; y < size; y++) {
      const row: boolean[] = [];
      for (let x = 0; x < size; x++) {
        const px = Math.floor((x + 4.5) * scale);
        const py = Math.floor((y + 4.5) * scale);
        row.push(data[(py * el.width + px) * 4]! < 128);
      }
      rows.push(row);
    }
    return rows;
  }, n);
}

test('Your page: name, pictures, about, links, colour and Save, with a faithful preview', { tag: '@ui' }, async ({ page, browserName }) => {
  // Arrange
  const api = await mockBranding(page);
  const card = await openBrandCard(page);
  const preview = card.getByTestId('brand-preview');

  // Assert
  await expect(card.getByRole('heading', { name: 'Your page' })).toBeVisible();
  await expect(card.getByTestId('brand-save')).toBeDisabled();

  // Act
  await card.getByTestId('brand-name').fill('Ana Plays');
  await card.getByTestId('brand-file-avatar').setInputFiles({ name: 'me.jpg', mimeType: 'image/jpeg', buffer: await photoWithGps(page, 900, 700) });
  await card.getByTestId('brand-use-avatar').click();

  // Assert
  await expect(preview.locator('.sc-brand-name')).toHaveText('Ana Plays');
  await expect.poll(() => api.uploads.map((u) => u.slot)).toEqual(['avatar', 'avatar128', 'fav32', 'fav180']);
  await expect(preview.locator('img.sc-brand-avatar')).toHaveAttribute('src', /^\/api\/branding\/file\/[0-9a-f]{64}\.(webp|png|jpg)$/);

  // Act
  await card.getByTestId('brand-file-banner').setInputFiles({ name: 'banner.jpg', mimeType: 'image/jpeg', buffer: await photoWithGps(page, 1600, 500) });
  await card.getByTestId('brand-use-banner').click();

  // Assert
  await expect.poll(() => api.uploads.length).toBe(6);
  await expect(preview.getByTestId('bp-banner')).toBeVisible();
  for (const u of api.uploads) {
    const [w, h, kb] = SIZES[u.slot]!;
    expect(['image/webp', 'image/png', 'image/jpeg'], u.slot).toContain(u.type);
    expect(u.bytes.length, `${u.slot} bytes`).toBeLessThanOrEqual(kb * 1024);
    expect(u.bytes.includes(Buffer.from('SCFIXTURE')), `${u.slot}: original EXIF`).toBe(false);
    if (browserName === 'chromium') expect(u.bytes.includes(Buffer.from('Exif\0\0')), `${u.slot}: EXIF`).toBe(false);
    expect(await decodedSize(page, u), `${u.slot} size`).toEqual([w, h]);
  }

  // Act
  await card.getByTestId('brand-section-about').click();
  await card.getByTestId('brand-tagline').fill('Chill games and chat every Friday');
  await card.getByTestId('brand-about').fill('Hi! I stream cozy games.\nBring tea.');
  for (const tag of ['cozy', 'indie']) {
    await card.getByTestId('brand-tag-input').fill(tag);
    await card.getByTestId('brand-tag-input').press('Enter');
  }

  // Assert
  await expect(preview.locator('.sc-brand-tagline')).toHaveText('Chill games and chat every Friday');
  await expect(preview.locator('.sc-brand-about-text')).toHaveText('Hi! I stream cozy games.\nBring tea.');
  await expect(preview.locator('.sc-brand-tag')).toHaveText(['cozy', 'indie']);

  // Act
  await card.getByTestId('brand-section-links').click();
  for (const [i, [label, typed]] of LINKS.entries()) {
    await card.getByTestId('brand-link-add').click();
    await card.getByTestId('brand-link-label').nth(i).fill(label);
    await card.getByTestId('brand-link-url').nth(i).fill(typed);
  }
  await card.getByTestId('brand-link-add').click();
  await card.getByTestId('brand-link-label').nth(3).fill('Trap');
  await card.getByTestId('brand-link-url').nth(3).fill('javascript:alert(1)');

  // Assert
  await expect(card.getByTestId('brand-link-error')).toHaveText('Only https:// links (or an e-mail address) are allowed.');
  await expect(card.getByTestId('brand-save')).toBeDisabled();
  await expect(preview.locator('a.sc-brand-link')).toHaveCount(3);

  // Act
  await card.getByTestId('brand-link-row').nth(3).getByRole('button', { name: 'Remove' }).click();

  // Assert
  for (const [i, [, , href]] of LINKS.entries()) {
    const a = preview.locator('a.sc-brand-link').nth(i);
    await expect(a).toHaveAttribute('href', href);
    if (href.startsWith('https:')) {
      await expect(a).toHaveAttribute('target', '_blank');
      expect((await a.getAttribute('rel'))!.split(' ').sort()).toEqual(['nofollow', 'noopener', 'noreferrer']);
    }
  }
  await expect(preview.locator('a[href^="javascript"]')).toHaveCount(0);

  // Act
  await card.getByTestId('brand-support-link').check();
  await card.getByTestId('brand-support-url').fill('ko-fi.com/ana');

  // Assert
  await expect(preview.locator('a.sc-brand-support')).toHaveText('Support');
  await expect(preview.locator('a.sc-brand-support')).toHaveAttribute('href', 'https://ko-fi.com/ana');

  // Act
  await card.getByTestId('brand-section-colours').click();
  await card.getByTestId('brand-preset-custom').click();
  await card.getByTestId('brand-accent').fill('#f5d90a');

  // Assert
  await expect(card.getByTestId('brand-theme-adjusted')).toBeVisible();
  for (const mode of ['light', 'dark'] as const) {
    await card.getByTestId(`bp-${mode}`).click();
    await expect(preview).toHaveAttribute('data-mode', mode);
    const c = await previewContrast(page);
    expect(c.button, `${mode}: button vs page`).toBeGreaterThanOrEqual(3);
    expect(c.label, `${mode}: button label`).toBeGreaterThanOrEqual(4.5);
    expect(c.link, `${mode}: link`).toBeGreaterThanOrEqual(4.5);
  }

  // Act
  await card.getByTestId('brand-section-share').click();
  await card.getByTestId('brand-ended').fill('Thanks! Back on Friday at 8 pm');
  await card.getByTestId('bp-tab-ended').click();

  // Assert
  await expect(card.getByTestId('brand-preview-card')).not.toBeChecked();
  await expect(preview.getByTestId('bp-ended')).toHaveText('Thanks! Back on Friday at 8 pm');

  // Act
  await card.getByTestId('bp-tab-join').click();

  // Assert
  await expect(preview.getByTestId('bp-join-title')).toHaveText("Join Ana Plays's stream");

  // Act
  await card.getByTestId('brand-save').click();

  // Assert
  await expect(card.getByTestId('brand-saved')).toBeVisible();
  expect(api.puts).toHaveLength(1);
  expect(api.puts[0]).toMatchObject({
    enabled: true,
    name: 'Ana Plays',
    tagline: 'Chill games and chat every Friday',
    about: 'Hi! I stream cozy games.\nBring tea.',
    tags: ['cozy', 'indie'],
    links: LINKS.map(([label, , url]) => ({ label, url })),
    support: { enabled: true, label: 'support', mode: 'link', url: 'https://ko-fi.com/ana' },
    theme: { preset: 'custom', accent: '#f5d90a', corners: 'round' },
    preview: { enabled: false },
    endedMessage: 'Thanks! Back on Friday at 8 pm',
    showCredit: true,
  });
  await expect(card.getByTestId('brand-save')).toBeDisabled();
});

test('Your page: Pix with copy key, "copia e cola" and a QR code, and the privacy warning', { tag: '@ui' }, async ({ page }) => {
  // Arrange
  await page.addInitScript(() => {
    const w = window as unknown as { __copied: string[] };
    w.__copied = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (s: string) => void w.__copied.push(s) } });
  });
  await mockBranding(page);
  const card = await openBrandCard(page);
  await card.getByTestId('brand-name').fill('Ana Plays');
  await card.getByTestId('brand-section-links').click();
  const expected = buildPixPayload({ key: PIX_KEY, name: 'Ana Lima', city: 'São Paulo' });
  if (!expected.ok) throw new Error('fixture payload');

  // Act
  await card.getByTestId('brand-support-pix').check();

  // Assert
  await expect(card.getByTestId('brand-pix-warning')).toHaveText('Anyone who sends you a Pix sees your full legal name and part of your CPF. If you want to stay anonymous, use a tip service instead.');

  // Act
  await card.getByTestId('brand-pix-type').selectOption('cpf');
  await card.getByTestId('brand-pix-key').fill('529.982.247-25');
  await card.getByTestId('brand-pix-name').fill('Ana Lima');
  await card.getByTestId('brand-pix-city').fill('São Paulo');

  // Assert
  await expect(card.getByTestId('brand-pix-confirm')).toBeVisible();
  await expect(card.getByTestId('brand-save')).toBeDisabled();

  // Act
  await card.getByTestId('brand-pix-confirm').check();

  // Assert
  await expect(card.getByTestId('brand-save')).toBeEnabled();

  // Act
  await card.getByTestId('brand-pix-type').selectOption('evp');
  await card.getByTestId('brand-pix-key').fill(PIX_KEY);

  // Assert
  await expect(card.getByTestId('brand-pix-confirm')).toHaveCount(0);
  await expect(card.getByTestId('brand-pix-code')).toHaveText(expected.payload);
  await expect(card.getByTestId('brand-pix-qr')).toBeVisible();

  // Act
  const sheet = card.getByTestId('brand-preview').getByTestId('bp-pix-sheet');
  await card.getByTestId('brand-preview').getByTestId('bp-support').click();

  // Assert
  await expect(sheet.getByTestId('bp-pix-key')).toHaveText(PIX_KEY);
  await expect(sheet.getByTestId('bp-pix-code')).toHaveText(expected.payload);
  await expect(sheet.getByTestId('bp-pix-qr')).toBeVisible();
  const matrix = qrMatrix(expected.payload);
  expect(await drawnQr(sheet.getByTestId('bp-pix-qr'), matrix.length)).toEqual(matrix);

  // Act
  await sheet.getByTestId('bp-pix-copy-code').click();

  // Assert
  await expect(sheet.getByTestId('bp-pix-copy-code')).toHaveText('Copied ✓');

  // Act
  await sheet.getByTestId('bp-pix-copy-key').click();

  // Assert
  await expect(sheet.getByTestId('bp-pix-copy-key')).toHaveText('Copied ✓');
  expect(await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual([expected.payload, PIX_KEY]);
});

test('Your page is translated to pt-BR (support button "Apoiar")', { tag: '@ui' }, async ({ page }) => {
  // Arrange
  await mockBranding(page);
  const card = await openBrandCard(page, 'pt-BR');

  // Assert
  await expect(card.getByRole('heading', { name: 'Sua página' })).toBeVisible();

  // Act
  await card.getByTestId('brand-name').fill('Ana Plays');
  await card.getByTestId('brand-section-links').click();
  await card.getByTestId('brand-support-link').check();
  await card.getByTestId('brand-support-url').fill('https://livepix.gg/ana');

  // Assert
  await expect(card.getByTestId('brand-preview').locator('.sc-brand-support')).toHaveText('Apoiar');

  // Act
  await card.getByTestId('brand-link-add').click();
  await card.getByTestId('brand-link-label').fill('Roteador');
  await card.getByTestId('brand-link-url').fill('https://192.168.0.1');

  // Assert
  await expect(card.getByTestId('brand-link-error')).toHaveText('Esse endereço aponta para um aparelho da sua rede, os espectadores não conseguem abrir.');

  // Act
  await card.getByTestId('brand-support-pix').check();

  // Assert
  await expect(card.getByTestId('brand-pix-warning')).toHaveText('Quem te mandar um Pix vê seu nome completo e parte do seu CPF. Se quiser ficar anônimo, use um serviço de gorjetas.');

  // Act
  await card.getByTestId('brand-section-identity').click();
  await card.getByTestId('brand-file-avatar').setInputFiles({ name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') });

  // Assert
  await expect(card.getByTestId('brand-image-error-avatar')).toHaveText('SVG não é aceito. Exporte seu logo como PNG.');
});

test('Your page against the real server routes: the name and a picture are saved, then reset', { tag: '@ui' }, async ({ page, branding }) => {
  // Arrange
  const card = await openBrandCard(page);
  branding.markChanged();

  // Act
  await card.getByTestId('brand-name').fill('Ana Plays');
  await card.getByTestId('brand-save').click();

  // Assert
  await expect(card.getByTestId('brand-saved')).toBeVisible();
  await expect.poll(async () => (await adminApi<AdminBrandingState>('GET', '/api/branding')).branding.name).toBe('Ana Plays');

  // Act
  await card.getByTestId('brand-file-avatar').setInputFiles({ name: 'me.jpg', mimeType: 'image/jpeg', buffer: await photoWithGps(page, 600, 600) });
  await card.getByTestId('brand-use-avatar').click();

  // Assert
  await expect.poll(async () => Object.keys((await adminApi<AdminBrandingState>('GET', '/api/branding')).images).sort()).toEqual(['avatar', 'avatar128', 'fav180', 'fav32']);
  const avatar = card.getByTestId('brand-preview').locator('img.sc-brand-avatar');
  await expect(avatar).toHaveAttribute('src', /^\/api\/branding\/file\/[0-9a-f]{64}\.(webp|png|jpg)$/);
  expect((await page.request.get(new URL((await avatar.getAttribute('src'))!, page.url()).href)).status(), "the panel's own file route serves it").toBe(200);
});

test('Your page without branding routes on the server: defaults, a note, nothing breaks', { tag: '@ui' }, async ({ page }) => {
  // Arrange
  await page.route(/\/api\/branding(\/.*)?$/, (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not Found"}' }));
  const card = await openBrandCard(page);

  // Act
  await card.getByTestId('brand-name').fill('Ana Plays');

  // Assert
  await expect(card.getByTestId('brand-unavailable')).toBeVisible();
  await expect(card.getByTestId('brand-preview').locator('.sc-brand-name')).toHaveText('Ana Plays');
  await expect(card.getByTestId('brand-save')).toBeDisabled();
  await expect(page.getByTestId('error')).toHaveCount(0);
});

const SHOTS = process.env.BRAND_SCREENSHOTS;

/** Screenshots of the card for the site guides, only when asked: BRAND_SCREENSHOTS=<dir> (Chromium). */
test('Your page screenshots', { tag: '@ui' }, async ({ page, browserName }) => {
  // Arrange
  test.skip(!SHOTS || browserName !== 'chromium', 'set BRAND_SCREENSHOTS=<dir> (chromium) to capture the card');
  fs.mkdirSync(SHOTS!, { recursive: true });
  const shot = (name: string): string => path.join(SHOTS!, name);

  for (const lang of ['en', 'pt-BR'] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      // Arrange
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 1280, height: 1000 });
      await mockBranding(page);
      const card = await openBrandCard(page, lang === 'en' ? undefined : lang);
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
      await card.getByTestId(`bp-${scheme}`).click();

      // Act
      await card.screenshot({ path: shot(`your-page-${lang}-${scheme}-links.png`) });
      await card.getByTestId('brand-support-pix').check();
      await card.getByTestId('brand-pix-key').fill(PIX_KEY);
      await card.getByTestId('brand-pix-name').fill('Ana Lima');
      await card.getByTestId('brand-pix-city').fill('Sao Paulo');
      await card.getByTestId('bp-support').click();
      await expect(card.getByTestId('bp-pix-sheet')).toBeVisible();
      await card.screenshot({ path: shot(`your-page-${lang}-${scheme}-pix.png`) });
      await card.getByTestId('bp-phone').click();
      await card.getByTestId('brand-section-colours').click();
      await card.getByTestId('brand-preset-ocean').click();
      await card.getByTestId('brand-preview').screenshot({ path: shot(`your-page-${lang}-${scheme}-phone-preview.png`) });
      await card.getByTestId('bp-tab-join').click();
      await card.getByTestId('brand-preview').screenshot({ path: shot(`your-page-${lang}-${scheme}-join.png`) });
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    }
  }
});
