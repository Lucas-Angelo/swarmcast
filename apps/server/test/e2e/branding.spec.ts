// "Your page" end to end (branding plan §7.3, branding.spec.ts @ui): what the streamer saves in the
// panel (its branding API) shows on the join and watch pages of real browsers, with safe links,
// live updates and no third-party request, while everything a stranger can reach stays stock.
// The panel's own card (upload through the canvas, preview) is covered by the admin unit tests and
// the panel suite; here the API stands in for it. Every test puts the defaults back: the e2e
// server is shared by the whole run.
import zlib from 'node:zlib';
import type { Page } from '@playwright/test';
import { adminApi, adminUpload, expect, join, liveLink, test, uid } from './fixtures.js';


/**
 * A w × h RGB PNG drawn here (a soft gradient), so the upload carries bytes the test made itself,
 * not a file from disk.
 */
function makePng(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const rows = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const o = y * (1 + w * 3);
    for (let x = 0; x < w; x++) {
      rows[o + 1 + x * 3] = 20 + ((x * 120) / w) | 0;
      rows[o + 2 + x * 3] = 110 + ((y * 100) / h) | 0;
      rows[o + 3 + x * 3] = 120;
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const NAME = 'Zebulon Quarterhorse';

async function brand(extra: Record<string, unknown> = {}): Promise<void> {
  await adminApi('PUT', '/api/branding', {
    name: NAME,
    tagline: 'Jogos de tabuleiro toda sexta',
    about: 'Lives tranquilas.\nPergunte o que quiser no chat.',
    tags: ['tabuleiro', 'cozy'],
    links: [
      { label: 'Ko-fi', url: 'https://ko-fi.com/zebulon' },
      { label: 'E-mail', url: 'mailto:zeb@example.com' },
    ],
    support: { enabled: true, label: 'support', mode: 'link', url: 'https://ko-fi.com/zebulon' },
    theme: { preset: 'ocean', corners: 'round' },
    ...extra,
  });
  const up = await adminUpload<{ ok?: boolean }>('/api/branding/image/avatar', makePng(256, 256), 'image/png');
  expect(up.status, JSON.stringify(up.body)).toBe(200);
}

async function unbrand(): Promise<void> {
  await adminApi('POST', '/api/branding/reset', {});
}

function thirdParty(page: Page, origin: string): string[] {
  const seen: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol.startsWith('http') && u.origin !== origin) seen.push(r.url());
  });
  return seen;
}

test('the join and watch pages show the streamer\'s page; links are safe; nothing leaves the origin', { tag: '@ui' }, async ({ browser, baseURL }) => {
  await brand();
  const origin = new URL(baseURL!).origin;
  try {
    // Join page: the name in the title and header, the avatar from our own origin.
    const ctx = await browser.newContext();
    const joinPage = await ctx.newPage();
    const outside = thirdParty(joinPage, origin);
    await joinPage.goto(await liveLink());
    await expect(joinPage).toHaveURL(/\/join$/);
    await expect(joinPage.locator('main.card h1')).toContainText(NAME, { timeout: 10_000 });
    await expect(joinPage.locator('#brand-head .sc-brand-name')).toHaveText(NAME);
    await expect(joinPage.locator('#brand-head img.sc-brand-avatar')).toHaveAttribute('src', /^\/brand\/[0-9a-f]{64}\.png$/);
    await expect(joinPage).toHaveTitle(new RegExp(NAME));
    await ctx.close();

    const v = await join(browser, uid('brandv'));
    const seen = thirdParty(v.page, origin);
    try {
      const head = v.page.locator('#brand-head');
      await expect(head.locator('.sc-brand-name')).toHaveText(NAME, { timeout: 10_000 });
      await expect(head.locator('.sc-brand-tagline')).toHaveText('Jogos de tabuleiro toda sexta');
      const about = v.page.getByTestId('brand-about');
      await expect(about.locator('.sc-brand-about-text')).toHaveText('Lives tranquilas.\nPergunte o que quiser no chat.');
      await expect(about.locator('.sc-brand-tag')).toHaveText(['tabuleiro', 'cozy']);
      // Tags are words, not links; links open safely in a new tab.
      await expect(about.locator('.sc-brand-tags a')).toHaveCount(0);
      const kofi = about.locator('a.sc-brand-link', { hasText: 'Ko-fi' });
      await expect(kofi).toHaveAttribute('href', 'https://ko-fi.com/zebulon');
      await expect(kofi).toHaveAttribute('target', '_blank');
      await expect(kofi).toHaveAttribute('rel', 'noopener noreferrer nofollow');
      await expect(about.locator('a.sc-brand-link', { hasText: 'E-mail' })).toHaveAttribute('href', 'mailto:zeb@example.com');
      await expect(v.page.locator('a.sc-brand-support[data-testid="brand-support"]')).toHaveAttribute('href', 'https://ko-fi.com/zebulon');
      // Every streamer string is isolated (bidi).
      for (const b of await v.page.locator('#brand-head bdi, [data-testid="brand-about"] bdi').all()) await expect(b).toHaveAttribute('dir', 'auto');
      await v.page.waitForTimeout(1000);
      expect(seen, 'requests to other origins').toEqual([]);
    } finally {
      await v.context.close();
    }
    expect(outside, 'requests to other origins from the join page').toEqual([]);
  } finally {
    await unbrand();
  }
});

test('a save in the panel reaches an open watch page without a reload', { tag: '@ui' }, async ({ browser }) => {
  await brand();
  try {
    const v = await join(browser, uid('brandlive'));
    try {
      await expect(v.page.locator('#brand-head .sc-brand-name')).toHaveText(NAME, { timeout: 10_000 });
      await adminApi('PUT', '/api/branding', { name: 'Nome Novo', theme: { preset: 'ocean', corners: 'round' } });
      await expect(v.page.locator('#brand-head .sc-brand-name')).toHaveText('Nome Novo', { timeout: 5_000 });
      await expect(v.page).toHaveTitle(/Nome Novo/);
    } finally {
      await v.context.close();
    }
  } finally {
    await unbrand();
  }
});

test('strangers never see whose stream it is', { tag: '@ui' }, async ({ browser, baseURL }) => {
  await brand();
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    for (const p of ['/', '/join', '/join/not-the-current-link', '/watch', '/api/brand']) {
      const res = await page.goto(new URL(p, baseURL).toString());
      expect(await res!.text(), p).not.toContain(NAME);
      await expect(page.locator('body'), p).not.toContainText(NAME);
    }
    await ctx.close();
  } finally {
    await unbrand();
  }
});
