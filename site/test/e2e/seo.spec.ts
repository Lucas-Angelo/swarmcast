// Link previews and search: the Open Graph / Twitter tags, canonical and hreflang links, the social
// card images, the JSON-LD on the landing pages, robots.txt, the sitemap and the 404 page. Runs
// against the BUILT site (dist/), like site.spec.ts. Cards stay under WhatsApp's ~300 KB limit;
// a description fits a search result (165 characters); structured data only on the landing pages.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { readTokens } from '../../src/tokens.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '../../dist');
const ROOT_PACKAGE = JSON.parse(fs.readFileSync(path.resolve(HERE, '../../../package.json'), 'utf8')) as { version: string };
const ORIGIN = 'https://lucas-angelo.github.io';
const BASE = '/swarmcast';
const RELEASES = 'https://github.com/Lucas-Angelo/swarmcast/releases/latest';
const MAX_CARD_BYTES = 300 * 1024;
const MAX_DESCRIPTION = 165;

type Lang = 'en' | 'pt-BR';
interface PageCase {
  name: string;
  /** Path without the language prefix, e.g. '/download/'. */
  path: string;
  lang: Lang;
  /** Words the title must contain (the per-page pattern). */
  title: RegExp;
  landing?: boolean;
}

const PAGES: PageCase[] = [
  { name: 'English landing', path: '/', lang: 'en', title: /^SwarmCast: .*members-only live streams/i, landing: true },
  { name: 'Portuguese landing', path: '/', lang: 'pt-BR', title: /^SwarmCast: live só para membros/i, landing: true },
  { name: 'English download', path: '/download/', lang: 'en', title: /^Download SwarmCast for Windows, macOS and Linux$/ },
  { name: 'Portuguese download', path: '/download/', lang: 'pt-BR', title: /^Baixar o SwarmCast para Windows, macOS e Linux$/ },
  { name: 'English guide page', path: '/install/windows/', lang: 'en', title: /^Install on Windows \| SwarmCast guide$/ },
  { name: 'Portuguese guide page', path: '/start/obs/', lang: 'pt-BR', title: /^Configurar o OBS \| Guia do SwarmCast$/ },
];

const localized = (lang: Lang, p: string) => (lang === 'pt-BR' ? `${BASE}/pt-br${p}` : `${BASE}${p}`);
const abs = (p: string) => `${ORIGIN}${p}`;

/** Width and height from a PNG (IHDR) or JPEG (SOFn) header. */
function imageSize(buf: Buffer): { type: string; width: number; height: number } {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { type: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xff) throw new Error('bad JPEG marker');
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { type: 'image/jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  throw new Error('not a PNG or JPEG');
}

/** Every content value of a <meta property|name=key>. */
async function metas(page: Page, key: string): Promise<string[]> {
  return page.locator(`head meta[property="${key}"], head meta[name="${key}"]`).evaluateAll((els) => els.map((e) => e.getAttribute('content') ?? ''));
}

/** The one, non-empty content of <meta property|name=key> (fails otherwise). */
async function meta(page: Page, key: string): Promise<string> {
  const values = await metas(page, key);
  expect(values, `exactly one ${key}`).toHaveLength(1);
  expect(values[0], `${key} has content`).not.toBe('');
  return values[0];
}

/** Every tag a link preview reads, by property or name. */
const REQUIRED = [
  'description',
  'og:type',
  'og:site_name',
  'og:title',
  'og:description',
  'og:url',
  'og:locale',
  'og:locale:alternate',
  'og:image',
  'og:image:width',
  'og:image:height',
  'og:image:alt',
  'og:image:type',
  'twitter:card',
  'twitter:title',
  'twitter:description',
  'twitter:image',
  'twitter:image:alt',
];

/** The canonical link, the hreflang alternates and the theme colours of the page in its head. */
async function headLinks(page: Page) {
  return {
    canonical: await page.locator('head link[rel="canonical"]').evaluateAll((els) => els.map((e) => e.getAttribute('href'))),
    alternates: await page.locator('head link[rel="alternate"][hreflang]').evaluateAll((els) => Object.fromEntries(els.map((e) => [e.getAttribute('hreflang'), e.getAttribute('href')]))),
    themes: await page.locator('head meta[name="theme-color"]').evaluateAll((els) => Object.fromEntries(els.map((e) => [e.getAttribute('media'), e.getAttribute('content')]))),
  };
}

/** Every indexable HTML page in dist (not the 404 page). */
function distPages(): { url: string; html: string }[] {
  const out: { url: string; html: string }[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!['_astro', 'pagefind', 'og'].includes(e.name)) walk(full);
      } else if (e.name.endsWith('.html') && full !== path.join(DIST, '404.html')) {
        const rel = path.relative(DIST, full).split(path.sep).join('/');
        out.push({ url: `${BASE}/${rel.replace(/index\.html$/, '')}`, html: fs.readFileSync(full, 'utf8') });
      }
    }
  };
  walk(DIST);
  return out;
}

/** The title, meta descriptions, canonical tag and og:image of a built page's head. */
function headOf(html: string) {
  const head = html.slice(0, html.indexOf('</head>'));
  const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  return {
    head,
    titles: [...head.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => decode(m[1])),
    descriptions: [...head.matchAll(/<meta name="description" content="([^"]*)"/g)].map((m) => decode(m[1])),
    ogImage: /<meta property="og:image" content="([^"]*)"/.exec(head)?.[1],
  };
}

/** Where each 404 block ([data-lang]) starts, from the top of the page. */
const blockTops = (page: Page) => page.locator('[data-lang]').evaluateAll((els) => Object.fromEntries(els.map((e) => [e.getAttribute('data-lang'), Math.round(e.getBoundingClientRect().top)])));

test.describe('link previews and search tags', () => {
  for (const c of PAGES) {
    test(`${c.name}: one title and description, every preview tag, canonical, hreflang`, async ({ page }) => {
      // Arrange
      const own = localized(c.lang, c.path);

      // Act
      await page.goto(own);
      const links = await headLinks(page);

      // Assert
      await expect(page).toHaveURL(new RegExp(`${own}$`));
      await expect(page.locator('html')).toHaveAttribute('lang', c.lang);
      await expect(page.locator('head title')).toHaveCount(1);
      expect(await page.title()).toMatch(c.title);
      for (const key of REQUIRED) await meta(page, key);
      expect((await meta(page, 'description')).length, 'description fits a search result').toBeLessThanOrEqual(MAX_DESCRIPTION);
      expect(links.canonical).toEqual([abs(own)]);
      expect(links.alternates).toEqual({ en: abs(localized('en', c.path)), 'pt-BR': abs(localized('pt-BR', c.path)), 'x-default': abs(localized('en', c.path)) });
    });

    test(`${c.name}: Open Graph and Twitter agree with the page`, async ({ page }) => {
      // Act
      await page.goto(localized(c.lang, c.path));
      const title = await page.title();
      const description = await meta(page, 'description');

      // Assert
      expect(await meta(page, 'og:url')).toBe(abs(localized(c.lang, c.path)));
      expect(await meta(page, 'og:title')).toBe(title);
      expect(await meta(page, 'twitter:title')).toBe(title);
      expect(await meta(page, 'og:description')).toBe(description);
      expect(await meta(page, 'twitter:description')).toBe(description);
      expect(await meta(page, 'og:site_name')).toBe('SwarmCast');
      expect(await meta(page, 'og:type')).toBe(c.landing || c.path === '/download/' ? 'website' : 'article');
      expect(await meta(page, 'og:locale')).toBe(c.lang === 'en' ? 'en_US' : 'pt_BR');
      expect(await meta(page, 'og:locale:alternate')).toBe(c.lang === 'en' ? 'pt_BR' : 'en_US');
      expect(await meta(page, 'twitter:card')).toBe('summary_large_image');
    });

    test(`${c.name}: the card of the page's language is a real 1200×630 file of the stated type and size, served`, async ({ page }) => {
      // Act
      await page.goto(localized(c.lang, c.path));
      const image = await meta(page, 'og:image');
      const file = path.join(DIST, new URL(image).pathname.slice(BASE.length));
      const served = await page.request.get(new URL(image).pathname);

      // Assert
      expect(image).toBe(abs(`${BASE}/og/${c.lang === 'en' ? 'og-en' : 'og-pt-br'}.png`));
      expect(await meta(page, 'twitter:image')).toBe(image);
      expect(await meta(page, 'twitter:image:alt')).toBe(await meta(page, 'og:image:alt'));
      expect(fs.existsSync(file), `${file} exists`).toBe(true);
      const buf = fs.readFileSync(file);
      expect(buf.length, 'card stays under WhatsApp’s ~300 KB limit').toBeLessThan(MAX_CARD_BYTES);
      const size = imageSize(buf);
      expect(size).toEqual({ type: await meta(page, 'og:image:type'), width: Number(await meta(page, 'og:image:width')), height: Number(await meta(page, 'og:image:height')) });
      expect([size.width, size.height]).toEqual([1200, 630]);
      expect(served.status()).toBe(200);
    });

    test(`${c.name}: theme-color from the brand tokens, structured data only on landing pages`, async ({ page }) => {
      // Arrange
      const tokens = readTokens();

      // Act
      await page.goto(localized(c.lang, c.path));
      const { themes } = await headLinks(page);

      // Assert
      expect(themes).toEqual({ '(prefers-color-scheme: light)': tokens.light['--sc-bg'], '(prefers-color-scheme: dark)': tokens.dark['--sc-bg'] });
      await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(c.landing ? 1 : 0);
    });
  }

  for (const lang of ['en', 'pt-BR'] as const) {
    test(`JSON-LD on the ${lang} landing parses and has the required fields`, async ({ page }) => {
      // Arrange
      const own = localized(lang, '/');

      // Act
      await page.goto(own);
      const text = await page.locator('script[type="application/ld+json"]').textContent();
      const data = JSON.parse(text ?? '') as { '@context': string; '@graph': Record<string, unknown>[] };
      const byType = (type: string) => data['@graph'].find((n) => n['@type'] === type) as Record<string, unknown>;

      // Assert
      expect(data['@context']).toBe('https://schema.org');
      const app = byType('SoftwareApplication');
      expect(app).toMatchObject({
        name: 'SwarmCast',
        description: await meta(page, 'description'),
        applicationCategory: 'MultimediaApplication',
        operatingSystem: 'Windows, macOS, Linux',
        url: abs(own),
        downloadUrl: RELEASES,
        softwareVersion: ROOT_PACKAGE.version,
        image: await meta(page, 'og:image'),
        inLanguage: lang,
        license: 'https://opensource.org/license/mit',
      });
      expect(app.offers).toEqual([
        { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        { '@type': 'Offer', price: '0', priceCurrency: 'BRL' },
      ]);
      const person = byType('Person');
      expect(person).toMatchObject({ '@id': expect.any(String), name: expect.any(String), url: 'https://github.com/Lucas-Angelo' });
      expect(app.author).toEqual({ '@id': person['@id'] });
      expect(app.publisher).toEqual({ '@id': person['@id'] });
      expect(byType('WebSite')).toMatchObject({ name: 'SwarmCast', url: abs(`${BASE}/`), inLanguage: ['en', 'pt-BR'] });
      expect(text, 'no "</" can break out of the data block').not.toMatch(/<\//);
    });
  }
});

test.describe('every page in dist', () => {
  test('has one title and one meta description, both unique, a canonical URL, a card and an x-default', () => {
    // Act
    const pages = distPages().map((p) => ({ ...p, ...headOf(p.html) }));

    // Assert
    expect(pages.length).toBeGreaterThan(40);
    const titles = new Map<string, string>();
    const descriptions = new Map<string, string>();
    for (const p of pages) {
      expect(p.titles, `${p.url}: one <title>`).toHaveLength(1);
      expect(p.descriptions, `${p.url}: one meta description`).toHaveLength(1);
      expect(p.descriptions[0].length, `${p.url}: a real description`).toBeGreaterThan(40);
      expect(p.descriptions[0].length, `${p.url}: description fits a search result`).toBeLessThanOrEqual(MAX_DESCRIPTION);
      expect(titles.get(p.titles[0]), `${p.url}: title "${p.titles[0]}" is unique`).toBeUndefined();
      expect(descriptions.get(p.descriptions[0]), `${p.url}: description is unique`).toBeUndefined();
      titles.set(p.titles[0], p.url);
      descriptions.set(p.descriptions[0], p.url);
      expect(p.head, `${p.url}: canonical`).toContain(`<link rel="canonical" href="${abs(p.url)}"`);
      expect([abs(`${BASE}/og/og-en.png`), abs(`${BASE}/og/og-pt-br.png`)], `${p.url}: og:image`).toContain(p.ogImage);
      expect(p.head, `${p.url}: x-default`).toContain('hreflang="x-default"');
    }
  });
});

test.describe('crawling', () => {
  test('robots.txt allows everything and points at the sitemap', async ({ request }) => {
    // Act
    const res = await request.get(`${BASE}/robots.txt`);
    const text = await res.text();

    // Assert
    expect(res.status()).toBe(200);
    expect(text).toMatch(/^User-agent: \*$/m);
    expect(text).toMatch(/^Allow: \/$/m);
    expect(text).not.toMatch(/^Disallow: \S/m);
    expect(text.match(/^Sitemap: (\S+)$/m)?.[1]).toBe(abs(`${BASE}/sitemap-index.xml`));
    expect(fs.existsSync(path.join(DIST, 'sitemap-index.xml'))).toBe(true);
  });

  test('the sitemap lists both languages with hreflang alternates, every indexable page, and no 404', () => {
    // Arrange
    const index = fs.readFileSync(path.join(DIST, 'sitemap-index.xml'), 'utf8');
    const files = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

    // Act
    const xml = files.map((f) => fs.readFileSync(path.join(DIST, new URL(f).pathname.slice(BASE.length)), 'utf8')).join('\n');
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

    // Assert
    expect(files.length).toBeGreaterThan(0);
    for (const p of ['/', '/download/', '/install/windows/', '/start/obs/']) {
      expect(locs).toContain(abs(localized('en', p)));
      expect(locs).toContain(abs(localized('pt-BR', p)));
    }
    expect(xml).toContain(`<xhtml:link rel="alternate" hreflang="pt-BR" href="${abs(`${BASE}/pt-br/install/windows/`)}"/>`);
    expect(locs.some((l) => l.includes('404'))).toBe(false);
    for (const p of distPages()) expect(locs, p.url).toContain(abs(p.url));
  });

  test('a missing page shows a helpful 404 in both languages, English first, not indexed', async ({ page }) => {
    // Act
    const res = await page.goto(`${BASE}/no-such-page/`);
    const tops = await blockTops(page);

    // Assert
    expect(res?.status()).toBe(404);
    await expect(page.locator('head meta[name="robots"]')).toHaveAttribute('content', 'noindex');
    await expect(page.locator('head link[rel="canonical"]')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Página não encontrada' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'The guide' })).toHaveAttribute('href', `${BASE}/guide/`);
    await expect(page.getByRole('link', { name: 'O guia' })).toHaveAttribute('href', `${BASE}/pt-br/guide/`);
    await expect(page.getByRole('link', { name: 'Download SwarmCast' }).first()).toBeVisible();
    expect(tops.en).toBeLessThan(tops['pt-BR']);
  });

  test('under /pt-br/ the 404 shows the Portuguese block first', async ({ page }) => {
    // Act
    await page.goto(`${BASE}/pt-br/sem-pagina/`);
    const tops = await blockTops(page);

    // Assert
    expect(tops['pt-BR']).toBeLessThan(tops.en);
  });
});
