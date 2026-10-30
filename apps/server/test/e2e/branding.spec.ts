// "Your page" end to end (branding plan §7.3, BR2 routes and BR4 pages): what the streamer
// saves in the panel (its branding API) shows on the join and watch pages of real browsers, with
// safe links (a new tab, rel noopener noreferrer nofollow, tags are words, not links), every
// streamer string isolated for bidi, live updates and no third-party request, while everything
// a stranger can reach stays stock. The panel's own card (upload through the canvas, preview) is
// branding-panel.spec.ts; here the API stands in for it. Fake data only. The `branding` fixture
// puts the stock page back after each test: the e2e server is shared by the whole run.
//
// "Nothing leaves the origin": every request of the viewer's browser is recorded from its first
// page on, and checked once the page has painted what it shows (fixtures.ts painted()).
import zlib from 'node:zlib';
import { expect, outsideRequests, painted, test, uid, type BrandingControl } from './fixtures.js';

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

/** The streamer's page with every part filled in, and an avatar. */
async function brand(branding: BrandingControl): Promise<void> {
  await branding.save({
    enabled: true,
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
    preview: { enabled: false },
    showCredit: true,
  });
  await branding.upload('avatar', makePng(256, 256), 'image/png');
}

test("the join and watch pages show the streamer's page; links are safe; nothing leaves the origin", { tag: '@ui' }, async ({ viewers, branding, baseURL }) => {
  // Arrange
  await brand(branding);
  const origin = new URL(baseURL!).origin;
  let fromJoinPage: Array<{ url: string }> = [];
  let fromViewer: Array<{ url: string }> = [];

  // Act
  const joinPage = await viewers.atJoinPage({
    setup: async (c) => {
      fromJoinPage = outsideRequests(c, origin);
    },
  });

  // Assert
  await expect(joinPage.locator('main.card h1')).toContainText(NAME, { timeout: 10_000 });
  await expect(joinPage.locator('#brand-head .sc-brand-name')).toHaveText(NAME);
  await expect(joinPage.locator('#brand-head img.sc-brand-avatar')).toHaveAttribute('src', /^\/brand\/[0-9a-f]{64}\.png$/);
  await expect(joinPage).toHaveTitle(new RegExp(NAME));
  await painted(joinPage);
  expect(fromJoinPage, 'requests to other origins from the join page').toEqual([]);

  // Act
  const { page } = await viewers.join(uid('brandv'), {
    setup: async (c) => {
      fromViewer = outsideRequests(c, origin);
    },
  });

  // Assert
  const head = page.locator('#brand-head');
  await expect(head.locator('.sc-brand-name')).toHaveText(NAME, { timeout: 10_000 });
  await expect(head.locator('.sc-brand-tagline')).toHaveText('Jogos de tabuleiro toda sexta');
  const about = page.getByTestId('brand-about');
  await expect(about.locator('.sc-brand-about-text')).toHaveText('Lives tranquilas.\nPergunte o que quiser no chat.');
  await expect(about.locator('.sc-brand-tag')).toHaveText(['tabuleiro', 'cozy']);
  await expect(about.locator('.sc-brand-tags a')).toHaveCount(0);
  const kofi = about.locator('a.sc-brand-link', { hasText: 'Ko-fi' });
  await expect(kofi).toHaveAttribute('href', 'https://ko-fi.com/zebulon');
  await expect(kofi).toHaveAttribute('target', '_blank');
  await expect(kofi).toHaveAttribute('rel', 'noopener noreferrer nofollow');
  await expect(about.locator('a.sc-brand-link', { hasText: 'E-mail' })).toHaveAttribute('href', 'mailto:zeb@example.com');
  await expect(page.locator('a.sc-brand-support[data-testid="brand-support"]')).toHaveAttribute('href', 'https://ko-fi.com/zebulon');
  for (const b of await page.locator('#brand-head bdi, [data-testid="brand-about"] bdi').all()) await expect(b).toHaveAttribute('dir', 'auto');
  await painted(page);
  expect(fromViewer, 'requests to other origins').toEqual([]);
});

test('a save in the panel reaches an open watch page without a reload', { tag: '@ui' }, async ({ viewers, branding }) => {
  // Arrange
  await brand(branding);
  const { page } = await viewers.join(uid('brandlive'));
  await expect(page.locator('#brand-head .sc-brand-name')).toHaveText(NAME, { timeout: 10_000 });

  // Act
  await branding.save({ name: 'Nome Novo', theme: { preset: 'ocean', corners: 'round' } });

  // Assert
  await expect(page.locator('#brand-head .sc-brand-name')).toHaveText('Nome Novo', { timeout: 5_000 });
  await expect(page).toHaveTitle(/Nome Novo/);
});

test('strangers never see whose stream it is', { tag: '@ui' }, async ({ viewers, branding, baseURL }) => {
  // Arrange
  await brand(branding);
  const page = await (await viewers.browserContext()).newPage();

  for (const p of ['/', '/join', '/join/not-the-current-link', '/watch', '/api/brand']) {
    // Act
    const res = await page.goto(new URL(p, baseURL).toString());

    // Assert
    expect(await res!.text(), p).not.toContain(NAME);
    await expect(page.locator('body'), p).not.toContainText(NAME);
  }
});
