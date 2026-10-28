#!/usr/bin/env node
// Builds the offline streamer guide that ships inside each installer zip FROM THE WEBSITE'S
// PAGES (site/src/content/docs), so the site is the single source of truth. The pages and
// their order are listed in site/offline-guide.json.
//
// The result is one self-contained HTML file that opens by double-click in any browser:
// inline CSS only, no scripts, images inlined as data URIs, nothing loaded from the network
// (a Content-Security-Policy meta tag enforces it).
//
//   node scripts/build/guide-html.mjs <out.html> --lang en|pt-BR [--version X.Y.Z]
//
// Links to pages that are in the guide become in-page anchors; links to other pages of the
// site point at the website (https://lucas-angelo.github.io/swarmcast/...). No dependencies:
// it understands the Markdown the site's guide pages use (frontmatter, headings, paragraphs,
// nested lists, Starlight asides `:::tip[Title]`, images on their own line, **bold**,
// `code` and [links](...)).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTokens } from '../../site/src/tokens.mjs';
import { stripTags } from './strip-tags.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SITE_DIR = path.join(REPO_ROOT, 'site');
export const SITE_ORIGIN = 'https://lucas-angelo.github.io';
const SITE_BASE = '/swarmcast/';

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Heading id like Starlight's (github-slugger): lowercase, punctuation dropped, spaces to "-". */
export function slugify(text) {
  return stripTags(text.toLowerCase())
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

/** Splits `---` frontmatter (simple `key: value` lines) from the body. */
export function parseFrontmatter(md) {
  const text = md.replace(/\r\n?/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  const data = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    data[kv[1]] = v;
  }
  return { data, body: text.slice(m[0].length) };
}

/**
 * @typedef {{
 *   baseDir?: string,
 *   link?: (url: string) => string | null,
 *   headingOffset?: number,
 *   idPrefix?: string,
 *   asides?: Record<string, string>,
 * }} RenderOptions
 */

/** Inline Markdown: `code`, **bold**, [text](url). `link` maps a URL (null = plain text). */
export function inline(text, link = (url) => (/^https?:\/\//.test(url) ? url : null)) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code>${escapeHtml(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
    const href = link(url.replace(/&amp;/g, '&'));
    return href ? `<a href="${escapeHtml(href)}">${label}</a>` : label;
  });
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp' };

function figure(alt, src, opts) {
  const file = path.resolve(opts.baseDir ?? process.cwd(), src);
  const mime = MIME[path.extname(file).toLowerCase()];
  if (!mime || /^https?:/.test(src) || !fs.existsSync(file)) return `<p>${escapeHtml(alt)}</p>`;
  const data = fs.readFileSync(file).toString('base64');
  return `<figure><img src="data:${mime};base64,${data}" alt="${escapeHtml(alt)}"><figcaption>${escapeHtml(alt)}</figcaption></figure>`;
}

const LIST_ITEM = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
const ASIDE_OPEN = /^:::(note|tip|caution|danger)(?:\[(.*)\])?\s*$/;
const IMAGE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*$/;

const indentOf = (line) => /^ */.exec(line)[0].length;
const isBlockStart = (line) => HEADING.test(line) || LIST_ITEM.test(line) || ASIDE_OPEN.test(line.trim()) || IMAGE.test(line.trim()) || /^```/.test(line.trim());

/** Markdown lines (already de-indented) -> list of { type, html } blocks. */
function parseBlocks(lines, opts) {
  const out = [];
  const link = opts.link;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    let m;
    if (t === '') {
      i++;
    } else if (/^```/.test(t)) {
      const code = [];
      for (i++; i < lines.length && !/^```/.test(lines[i].trim()); i++) code.push(lines[i]);
      i++;
      out.push({ type: 'pre', html: `<pre><code>${escapeHtml(code.join('\n'))}</code></pre>` });
    } else if ((m = ASIDE_OPEN.exec(t))) {
      const inner = [];
      for (i++; i < lines.length && lines[i].trim() !== ':::'; i++) inner.push(lines[i]);
      i++;
      const title = m[2] || opts.asides?.[m[1]] || m[1];
      const body = parseBlocks(inner, opts).map((b) => b.html).join('\n');
      out.push({ type: 'aside', html: `<aside class="aside aside-${m[1]}"><p class="aside-title">${inline(title, link)}</p>\n${body}\n</aside>` });
    } else if ((m = HEADING.exec(line))) {
      const level = Math.min(6, m[1].length + (opts.headingOffset ?? 0));
      const id = `${opts.idPrefix ?? ''}${slugify(m[2].replace(/`/g, ''))}`;
      out.push({ type: 'h', html: `<h${level} id="${escapeHtml(id)}">${inline(m[2], link)}</h${level}>` });
      i++;
    } else if ((m = IMAGE.exec(t))) {
      out.push({ type: 'figure', html: figure(m[1], m[2], opts) });
      i++;
    } else if ((m = LIST_ITEM.exec(line))) {
      const ordered = /\d/.test(m[2]);
      const tag = ordered ? 'ol' : 'ul';
      const start = ordered ? Number.parseInt(m[2], 10) : 1;
      const items = [];
      while (i < lines.length) {
        const im = LIST_ITEM.exec(lines[i]);
        if (!im || indentOf(lines[i]) !== 0 || /\d/.test(im[2]) !== ordered) break;
        const contentIndent = im[1].length + im[2].length + 1 + (/^(\s*)/.exec(lines[i].slice(im[1].length + im[2].length + 1))[1].length);
        const itemLines = [im[3]];
        let loose = false;
        i++;
        while (i < lines.length) {
          const l = lines[i];
          if (l.trim() === '') {
            // A blank line continues the item only if indented content follows.
            let j = i;
            while (j < lines.length && lines[j].trim() === '') j++;
            if (j < lines.length && indentOf(lines[j]) >= contentIndent) {
              for (; i < j; i++) itemLines.push('');
              loose = true;
              continue;
            }
            break;
          }
          if (indentOf(l) >= contentIndent) itemLines.push(l.slice(contentIndent));
          else if (indentOf(l) > 0 || (!isBlockStart(l) && !LIST_ITEM.test(l))) itemLines.push(l.trim()); // lazy continuation
          else break;
          i++;
        }
        const blocks = parseBlocks(itemLines, opts);
        if (!loose && blocks[0]?.type === 'p') blocks[0] = { type: 'text', html: blocks[0].inner };
        items.push(`<li>${blocks.map((b) => b.html).join('\n')}</li>`);
        // Blank lines between items of the same list keep the list going.
        let j = i;
        while (j < lines.length && lines[j].trim() === '') j++;
        const next = j < lines.length ? LIST_ITEM.exec(lines[j]) : null;
        if (next && indentOf(lines[j]) === 0 && /\d/.test(next[2]) === ordered) i = j;
      }
      const startAttr = ordered && start !== 1 ? ` start="${start}"` : '';
      out.push({ type: 'list', html: `<${tag}${startAttr}>\n${items.join('\n')}\n</${tag}>` });
    } else {
      const para = [];
      while (i < lines.length && lines[i].trim() !== '' && (para.length === 0 || !isBlockStart(lines[i]))) {
        para.push(lines[i].trim());
        i++;
      }
      const inner = inline(para.join(' '), link);
      out.push({ type: 'p', inner, html: `<p>${inner}</p>` });
    }
  }
  return out;
}

/** Markdown (the site's subset) -> HTML. */
export function markdownToHtml(md, opts = {}) {
  const link = opts.link ?? ((url) => (/^https?:\/\//.test(url) ? url : null));
  return parseBlocks(md.replace(/\r\n?/g, '\n').split('\n'), { ...opts, link })
    .map((b) => b.html)
    .join('\n');
}

/** Reads site/offline-guide.json. */
export function loadGuideConfig(siteDir = SITE_DIR) {
  return JSON.parse(fs.readFileSync(path.join(siteDir, 'offline-guide.json'), 'utf8'));
}

const pageId = (slug) => `page-${slug.replace(/[^a-z0-9]+/gi, '-')}`;

/**
 * Maps a link written in a site page. `/swarmcast/[pt-br/]slug/#hash`: an anchor when the page is
 * in the guide, else the page on the website. http(s) stays. Anything else becomes plain text.
 */
export function makeLinkMapper(slugs, sitePrefix) {
  const inGuide = new Set(slugs);
  return (url) => {
    if (/^https?:\/\//.test(url)) return url;
    if (!url.startsWith(SITE_BASE)) return null;
    const [p, hash = ''] = url.split('#');
    if (p.startsWith(sitePrefix)) {
      const slug = p.slice(sitePrefix.length).replace(/\/+$/, '');
      if (inGuide.has(slug)) {
        const id = pageId(slug);
        return hash ? `#${id}--${slugify(decodeURIComponent(hash))}` : `#${id}`;
      }
    }
    return `${SITE_ORIGIN}${url}`;
  };
}

/**
 * The guide's colours come from the shared brand tokens (assets/brand/tokens.css, the same file
 * the website uses), so the offline guide matches the site. Hex values only; the fallbacks keep
 * it readable if the file is missing or uses another colour syntax.
 */
const TOKEN_FALLBACK = {
  light: { '--sc-bg': '#F6F1E6', '--sc-surface': '#FFFDF8', '--sc-border': '#E1D9C7', '--sc-ink': '#12211F', '--sc-muted': '#58665F', '--sc-accent': '#0F5C53', '--sc-accent-strong': '#0A4740', '--sc-success': '#3B7A2A', '--sc-warning': '#A15C00', '--sc-live': '#D63A2F' },
  dark: { '--sc-bg': '#0C1716', '--sc-surface': '#13221F', '--sc-border': '#26403A', '--sc-ink': '#EEF3EE', '--sc-muted': '#9CB0A9', '--sc-accent': '#3DB5A2', '--sc-accent-strong': '#7DD8C8', '--sc-success': '#7BC86A', '--sc-warning': '#F2B441', '--sc-live': '#FF5A4E' },
};

/** `--sc-x: #hex;` declarations for light and dark, read from assets/brand/tokens.css. */
export function tokenDeclarations(css) {
  let tokens = { light: {}, dark: {} };
  try {
    tokens = css === undefined ? readTokens() : readTokens(css);
  } catch {}
  const hex = (t) => Object.fromEntries(Object.entries(t).filter(([, v]) => /^#[0-9a-f]{3,8}$/i.test(v)));
  const pick = (t) =>
    Object.keys(TOKEN_FALLBACK.light)
      .map((k) => `${k}: ${t[k]};`)
      .join(' ');
  return { light: pick({ ...TOKEN_FALLBACK.light, ...hex(tokens.light) }), dark: pick({ ...TOKEN_FALLBACK.dark, ...hex(tokens.dark) }) };
}

const VARS = tokenDeclarations();

const CSS = `
:root { color-scheme: light dark; ${VARS.light} }
@media (prefers-color-scheme: dark) { :root { ${VARS.dark} } }
* { box-sizing: border-box; }
html { background: var(--sc-bg); }
body { margin: 0 auto; max-width: 44rem; padding: 2.5rem 1rem 4rem; background: var(--sc-bg); color: var(--sc-ink);
  font: 17px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Ubuntu, "Helvetica Neue", Arial, sans-serif;
  -webkit-font-smoothing: antialiased; }
h1, h2, h3, h4, strong { color: var(--sc-ink); }
h1 { font-size: 2rem; line-height: 1.2; letter-spacing: -0.02em; margin: 0 0 0.75rem; }
h2 { font-size: 1.5rem; line-height: 1.25; letter-spacing: -0.015em; margin: 3rem 0 0.75rem; padding-top: 2rem; border-top: 1px solid var(--sc-border); }
h3 { font-size: 1.2rem; margin: 2rem 0 0.5rem; }
h4 { font-size: 1.05rem; margin: 1.5rem 0 0.4rem; }
p { margin: 0.6rem 0; }
ol, ul { padding-left: 1.6rem; margin: 0.5rem 0; }
li { margin: 0.3rem 0; }
li::marker { color: var(--sc-muted); }
li > ol, li > ul { margin: 0.2rem 0; }
strong { font-weight: 600; }
a { color: var(--sc-accent-strong); text-decoration-color: var(--sc-accent); text-decoration-thickness: 1.5px; text-underline-offset: 0.2em; }
code { font: 0.875em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--sc-surface); color: var(--sc-ink);
  border: 1px solid var(--sc-border); padding: 0.1em 0.35em; border-radius: 6px; overflow-wrap: anywhere; }
pre { background: var(--sc-surface); border: 1px solid var(--sc-border); padding: 0.8rem 1rem; border-radius: 8px; overflow-x: auto; }
pre code { padding: 0; border: 0; background: none; }
figure { margin: 1rem 0; }
figure img { display: block; max-width: 100%; height: auto; border: 1px solid var(--sc-border); border-radius: 8px; }
figcaption { color: var(--sc-muted); font-size: 0.85rem; margin-top: 0.4rem; }
.aside { margin: 1rem 0; padding: 0.75rem 1rem; border: 1px solid var(--sc-border); border-left: 3px solid var(--sc-accent); border-radius: 8px; background: var(--sc-surface); }
.aside-tip { border-left-color: var(--sc-success); }
.aside-caution { border-left-color: var(--sc-warning); }
.aside-danger { border-left-color: var(--sc-live); }
.aside-title { color: var(--sc-ink); font-weight: 600; margin-top: 0; }
.lead { color: var(--sc-muted); }
nav { margin-top: 1.5rem; padding: 0.5rem 1.25rem; border: 1px solid var(--sc-border); border-radius: 12px; }
nav ol { columns: 2 14rem; margin: 0 0 0.5rem; }
nav li { margin: 0 0 0.4rem; break-inside: avoid; }
nav a { text-decoration: none; }
nav a:hover { text-decoration: underline; }
footer { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid var(--sc-border); color: var(--sc-muted); font-size: 0.85rem; }
@media print { body { max-width: none; } h2 { break-before: page; border-top: 0; } h2, h3 { break-after: avoid; } }
`;

/**
 * The whole offline guide for one language.
 * @param {{ lang?: 'en' | 'pt-BR', version?: string, siteDir?: string }} options
 */
export function renderGuide({ lang = 'en', version = '', siteDir = SITE_DIR } = {}) {
  const config = loadGuideConfig(siteDir);
  const L = config.languages[lang];
  if (!L) throw new Error(`Unknown language "${lang}" (expected ${Object.keys(config.languages).join(', ')})`);
  const link = makeLinkMapper(config.pages, L.sitePrefix);
  const sections = [];
  const toc = [];
  for (const slug of config.pages) {
    const file = path.join(siteDir, L.contentDir, `${slug}.md`);
    const { data, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    const id = pageId(slug);
    const title = data.title ?? slug;
    toc.push(`<li><a href="#${id}">${escapeHtml(title)}</a></li>`);
    const html = markdownToHtml(body, { baseDir: path.dirname(file), link, headingOffset: 1, idPrefix: `${id}--`, asides: L.asides });
    sections.push(`<section id="${id}">\n<h2>${escapeHtml(title)}</h2>\n${html}\n</section>`);
  }
  const siteUrl = `${SITE_ORIGIN}${L.sitePrefix}`;
  const footer = version ? `\n<footer>SwarmCast v${escapeHtml(version)} · <a href="${siteUrl}">${siteUrl}</a></footer>` : `\n<footer><a href="${siteUrl}">${siteUrl}</a></footer>`;
  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(L.title)}</title>
<style>${CSS}</style>
</head>
<body>
<h1>${escapeHtml(L.title)}</h1>
<p class="lead">${escapeHtml(L.intro)} <a href="${siteUrl}">${siteUrl}</a></p>
<nav aria-label="${escapeHtml(L.contents)}"><p><strong>${escapeHtml(L.contents)}</strong></p><ol>
${toc.join('\n')}
</ol></nav>
${sections.join('\n')}${footer}
</body>
</html>
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opts = { lang: 'en', version: '' };
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--lang') opts.lang = args[++i];
    else if (args[i] === '--version') opts.version = args[++i];
    else files.push(args[i]);
  }
  if (files.length !== 1) {
    console.error('Usage: node scripts/build/guide-html.mjs <out.html> --lang en|pt-BR [--version X.Y.Z]');
    process.exit(2);
  }
  fs.writeFileSync(files[0], renderGuide(opts));
  console.log(`wrote ${files[0]}`);
}
