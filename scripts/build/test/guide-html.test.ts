// The offline guide built from the site's pages (guide-html.mjs): the Markdown subset it reads,
// the self-contained HTML it writes for each language, and its colours from the brand tokens.
// Pages and tokens saved with Windows line endings (CRLF) render like LF ones.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { inline, loadGuideConfig, makeLinkMapper, markdownToHtml, parseFrontmatter, renderGuide, SITE_DIR, slugify, tokenDeclarations } from '../guide-html.mjs';

const config = loadGuideConfig();
const LANGS = ['en', 'pt-BR'] as const;
/** An image alone on its line, as the guide pages put their screenshots. */
const IMAGE_LINE = /^\s*!\[[^\]]*\]\([^)]+\)\s*$/gm;
const ORDERED_LIST = ['1. One', '2. Two', '', '   ![Alt](missing.png)', '', '3. Three', '   - nested', '   - list', '', 'After.'].join('\n');
const ASIDES = [':::tip', 'Body **x**.', ':::', '', ':::caution[Careful]', '- a', ':::'].join('\n');
const TOKENS_CSS = ':root, :root[data-palette="x"] { --sc-bg: #ABCDEF; --sc-ink: oklch(0.2 0 0); } :root[data-theme="dark"] { --sc-bg: #010203; }';

/** A guide page (Markdown with frontmatter) of `lang`, as it is on disk. */
const pageSource = (lang: (typeof LANGS)[number], slug: string): string => fs.readFileSync(path.join(SITE_DIR, config.languages[lang].contentDir, `${slug}.md`), 'utf8');
const crlf = (text: string): string => text.replace(/\n/g, '\r\n');

describe('markdown subset', () => {
  it('escapes HTML and renders code, bold and http links only', () => {
    // Act
    const html = inline('a <b> **c** `<d>` [e](https://x.y/?a=1&b=2) [f](./g)');

    // Assert
    expect(html).toBe('a &lt;b&gt; <strong>c</strong> <code>&lt;d&gt;</code> <a href="https://x.y/?a=1&amp;b=2">e</a> f');
  });

  it('keeps ordered lists going across indented images and blank lines; a missing image becomes its alt text', () => {
    // Act
    const html = markdownToHtml(ORDERED_LIST);

    // Assert
    expect(html.match(/<ol>/g)).toHaveLength(1);
    expect(html).toContain('<li>Three\n<ul>');
    expect(html).toContain('<p>Alt</p>');
    expect(html.endsWith('<p>After.</p>')).toBe(true);
  });

  it('renders Starlight asides with a default or custom title', () => {
    // Act
    const html = markdownToHtml(ASIDES, { asides: { tip: 'Dica' } });

    // Assert
    expect(html).toContain('<aside class="aside aside-tip"><p class="aside-title">Dica</p>\n<p>Body <strong>x</strong>.</p>');
    expect(html).toContain('<p class="aside-title">Careful</p>\n<ul>\n<li>a</li>');
  });

  it('renders CRLF Markdown exactly like LF', () => {
    // Arrange
    const md = `${ORDERED_LIST}\n\n${ASIDES}`;

    // Act
    const html = markdownToHtml(crlf(md), { asides: { tip: 'Dica' } });

    // Assert
    expect(html).toBe(markdownToHtml(md, { asides: { tip: 'Dica' } }));
    expect(html).not.toContain('\r');
  });

  it('shifts heading levels and prefixes ids like Starlight slugs', () => {
    // Act
    const html = markdownToHtml('## Remove everything (uninstall script)', { headingOffset: 1, idPrefix: 'p--' });

    // Assert
    expect(html).toBe('<h3 id="p--remove-everything-uninstall-script">Remove everything (uninstall script)</h3>');
  });

  it.each([
    ['O OBS não conecta', 'o-obs-não-conecta'],
    ['Windows: "Windows protected your PC"', 'windows-windows-protected-your-pc'],
    ['Option A: the .deb package', 'option-a-the-deb-package'],
    ['Press <kbd>Ctrl</kbd> + C', 'press-ctrl--c'],
    ['<<a>script>alert(1)</a>', 'scriptalert1'],
  ])('slugify(%j) is %j', (heading, slug) => {
    // Act
    const got = slugify(heading);

    // Assert
    expect(got).toBe(slug);
  });

  it('reads frontmatter', () => {
    // Act
    const page = parseFrontmatter('---\ntitle: "Advanced: x"\ndescription: y\n---\nBody');

    // Assert
    expect(page).toEqual({ data: { title: 'Advanced: x', description: 'y' }, body: 'Body' });
  });

  it('reads CRLF frontmatter, without a stray \\r in the values or the body', () => {
    // Act
    const page = parseFrontmatter(crlf('---\ntitle: "Advanced: x"\ndescription: y\n---\nBody\nmore'));

    // Assert
    expect(page).toEqual({ data: { title: 'Advanced: x', description: 'y' }, body: 'Body\nmore' });
  });

  it.each([
    ['a page in the guide', '/swarmcast/pt-br/start/obs/', '#page-start-obs'],
    ['a heading of a page in the guide', '/swarmcast/pt-br/start/obs/#o-obs-n%C3%A3o-conecta', '#page-start-obs--o-obs-não-conecta'],
    ['a page that is not in the guide', '/swarmcast/pt-br/download/#windows', 'https://lucas-angelo.github.io/swarmcast/pt-br/download/#windows'],
    ['another website', 'https://obsproject.com/', 'https://obsproject.com/'],
    ['a relative link', '../relative/', null],
  ])('maps a site link to %s', (_case, url, mapped) => {
    // Arrange
    const map = makeLinkMapper(['start/obs'], '/swarmcast/pt-br/');

    // Act
    const got = map(url);

    // Assert
    expect(got).toBe(mapped);
  });
});

describe('the offline guides built from the site pages', () => {
  it.each(LANGS)('%s: every listed page, self-contained, every screenshot embedded, every anchor resolves', (lang) => {
    // Arrange
    const titles = config.pages.map((slug) => parseFrontmatter(pageSource(lang, slug)).data.title as string);
    const pictures = config.pages.reduce((n, slug) => n + (pageSource(lang, slug).match(IMAGE_LINE) ?? []).length, 0);

    // Act
    const html = renderGuide({ lang, version: '9.9.9' });

    // Assert
    for (const title of titles) expect(html).toContain(`<h2>${title.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}</h2>`);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\ssrc="(?!data:)/);
    expect(html).toContain('img-src data:');
    expect(html).toContain('<img src="data:image/webp;base64,');
    expect(html.match(/<img src="data:image\//g)?.length).toBe(pictures);
    expect(html).toContain('SwarmCast v9.9.9');
    expect(html).not.toMatch(/:::|\]\(\/swarmcast/);
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const anchors = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    expect(anchors.length).toBeGreaterThan(config.pages.length);
    for (const a of anchors) expect(ids, `#${a}`).toContain(a);
    for (const m of html.matchAll(/href="(https:\/\/lucas-angelo\.github\.io[^"#]*)/g)) {
      expect(m[1]).toMatch(lang === 'en' ? /^https:\/\/lucas-angelo\.github\.io\/swarmcast\/(?!pt-br)/ : /^https:\/\/lucas-angelo\.github\.io\/swarmcast\/pt-br\//);
    }
  });

  it('lists the same pages in both languages', () => {
    // Arrange
    const expected = config.pages.flatMap((slug) => Object.keys(config.languages).map((lang) => `${lang}/${slug}`));

    // Act
    const present = expected.filter((page) => {
      const [lang, ...slug] = page.split('/');
      return fs.existsSync(path.join(SITE_DIR, config.languages[lang!].contentDir, `${slug.join('/')}.md`));
    });

    // Assert
    expect(present).toEqual(expected);
  });
});

describe('colours', () => {
  it('come from the brand tokens (hex only), with fallbacks for any other syntax', () => {
    // Act
    const t = tokenDeclarations(TOKENS_CSS);

    // Assert
    expect(t.light).toContain('--sc-bg: #ABCDEF;');
    expect(t.light).toContain('--sc-ink: #12211F;');
    expect(t.dark).toContain('--sc-bg: #010203;');
  });

  it('read a CRLF tokens file like an LF one', () => {
    // Arrange
    const multiline = TOKENS_CSS.replace(/([{;,]) /g, '$1\n').replace(/ }/g, '\n}');

    // Act
    const t = tokenDeclarations(crlf(multiline));

    // Assert
    expect(t).toEqual(tokenDeclarations(TOKENS_CSS));
  });

  it('the guide uses none of the violet defaults the brand replaced', () => {
    // Act
    const html = renderGuide({ lang: 'en' });

    // Assert
    expect(html).not.toMatch(/#6d4aff|#5b36f5/i);
  });
});
