import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { inline, loadGuideConfig, makeLinkMapper, markdownToHtml, parseFrontmatter, renderGuide, SITE_DIR, slugify, tokenDeclarations } from '../guide-html.mjs';

describe('markdown subset', () => {
  it('escapes HTML and renders code, bold and http links only', () => {
    expect(inline('a <b> **c** `<d>` [e](https://x.y/?a=1&b=2) [f](./g)')).toBe(
      'a &lt;b&gt; <strong>c</strong> <code>&lt;d&gt;</code> <a href="https://x.y/?a=1&amp;b=2">e</a> f',
    );
  });

  it('keeps ordered lists going across indented images and blank lines', () => {
    const html = markdownToHtml(['1. One', '2. Two', '', '   ![Alt](missing.png)', '', '3. Three', '   - nested', '   - list', '', 'After.'].join('\n'));
    expect(html.match(/<ol>/g)).toHaveLength(1);
    expect(html).toContain('<li>Three\n<ul>');
    expect(html).toContain('<p>Alt</p>'); // missing image -> its alt text
    expect(html.endsWith('<p>After.</p>')).toBe(true);
  });

  it('renders Starlight asides with a default or custom title', () => {
    const html = markdownToHtml([':::tip', 'Body **x**.', ':::', '', ':::caution[Careful]', '- a', ':::'].join('\n'), { asides: { tip: 'Dica' } });
    expect(html).toContain('<aside class="aside aside-tip"><p class="aside-title">Dica</p>\n<p>Body <strong>x</strong>.</p>');
    expect(html).toContain('<p class="aside-title">Careful</p>\n<ul>\n<li>a</li>');
  });

  it('shifts heading levels and prefixes ids like Starlight slugs', () => {
    expect(markdownToHtml('## Remove everything (uninstall script)', { headingOffset: 1, idPrefix: 'p--' })).toBe(
      '<h3 id="p--remove-everything-uninstall-script">Remove everything (uninstall script)</h3>',
    );
    expect(slugify('O OBS não conecta')).toBe('o-obs-não-conecta');
    expect(slugify('Windows: "Windows protected your PC"')).toBe('windows-windows-protected-your-pc');
    expect(slugify('Option A: the .deb package')).toBe('option-a-the-deb-package');
  });

  it('reads frontmatter', () => {
    expect(parseFrontmatter('---\ntitle: "Advanced: x"\ndescription: y\n---\nBody')).toEqual({ data: { title: 'Advanced: x', description: 'y' }, body: 'Body' });
  });

  it('maps site links to anchors (pages in the guide) or to the website', () => {
    const map = makeLinkMapper(['start/obs'], '/swarmcast/pt-br/');
    expect(map('/swarmcast/pt-br/start/obs/')).toBe('#page-start-obs');
    expect(map('/swarmcast/pt-br/start/obs/#o-obs-n%C3%A3o-conecta')).toBe('#page-start-obs--o-obs-não-conecta');
    expect(map('/swarmcast/pt-br/download/#windows')).toBe('https://lucas-angelo.github.io/swarmcast/pt-br/download/#windows');
    expect(map('https://obsproject.com/')).toBe('https://obsproject.com/');
    expect(map('../relative/')).toBeNull();
  });
});

describe('the offline guides built from the site pages', () => {
  const config = loadGuideConfig();

  for (const lang of ['en', 'pt-BR'] as const) {
    it(`${lang}: every listed page, self-contained, every anchor resolves`, () => {
      const html = renderGuide({ lang, version: '9.9.9' });
      const dir = path.join(SITE_DIR, config.languages[lang].contentDir);
      for (const slug of config.pages) {
        const title = parseFrontmatter(fs.readFileSync(path.join(dir, `${slug}.md`), 'utf8')).data.title as string;
        expect(html).toContain(`<h2>${title.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}</h2>`);
      }
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/\ssrc="(?!data:)/);
      expect(html).toContain('img-src data:');
      expect(html).toContain('<img src="data:image/png;base64,');
      expect(html).toContain('SwarmCast v9.9.9');
      expect(html).not.toMatch(/:::|\]\(\/swarmcast/); // no leftover Markdown
      const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
      const anchors = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
      expect(anchors.length).toBeGreaterThan(config.pages.length);
      for (const a of anchors) expect(ids, `#${a}`).toContain(a);
      for (const m of html.matchAll(/href="(https:\/\/lucas-angelo\.github\.io[^"#]*)/g)) {
        expect(m[1]).toMatch(lang === 'en' ? /^https:\/\/lucas-angelo\.github\.io\/swarmcast\/(?!pt-br)/ : /^https:\/\/lucas-angelo\.github\.io\/swarmcast\/pt-br\//);
      }
    });
  }

  it('lists the same pages in both languages', () => {
    for (const slug of config.pages) {
      for (const lang of Object.keys(config.languages)) {
        expect(fs.existsSync(path.join(SITE_DIR, config.languages[lang].contentDir, `${slug}.md`)), `${lang}/${slug}`).toBe(true);
      }
    }
  });
});

describe('colours', () => {
  it('come from the brand tokens (hex only), with fallbacks', () => {
    const t = tokenDeclarations(':root, :root[data-palette="x"] { --sc-bg: #ABCDEF; --sc-ink: oklch(0.2 0 0); } :root[data-theme="dark"] { --sc-bg: #010203; }');
    expect(t.light).toContain('--sc-bg: #ABCDEF;');
    expect(t.light).toContain('--sc-ink: #12211F;');
    expect(t.dark).toContain('--sc-bg: #010203;');
    expect(renderGuide({ lang: 'en' })).not.toMatch(/#6d4aff|#5b36f5/i);
  });
});
