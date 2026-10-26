#!/usr/bin/env node
// Renders a streamer guide (docs/TUTORIAL_*.md) to one self-contained HTML file that opens by
// double-click in any browser: inline CSS only, no scripts, nothing loaded from the network
// (a Content-Security-Policy meta tag enforces it). Used by the release workflow to put the
// guide inside each installer zip, so the zip and the docs always say the same thing.
//
//   node scripts/build/guide-html.mjs <in.md> <out.html> [--lang en] [--version X.Y.Z]
//
// Supports the Markdown subset the guides use: #/##/### headings, paragraphs, ordered and
// unordered lists (nested by indentation), blockquotes (also inside list items), **bold**,
// `code` and [links](https://...). Links that are not http(s) become plain text, because
// relative links do not work from inside a zip.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Inline Markdown: `code`, **bold**, [text](url). */
export function inline(text) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code>${escapeHtml(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) =>
    /^https?:\/\//.test(url) ? `<a href="${url}">${label}</a>` : label,
  );
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp' };

/** `![alt](relative/path.png)` on its own line -> <figure> with the image inlined as a data URI. */
function figure(alt, src, baseDir) {
  const file = path.resolve(baseDir, src);
  const mime = MIME[path.extname(file).toLowerCase()];
  if (!mime || /^https?:/.test(src) || !fs.existsSync(file)) return `<p>${inline(alt)}</p>`;
  const data = fs.readFileSync(file).toString('base64');
  return `<figure><img src="data:${mime};base64,${data}" alt="${escapeHtml(alt)}"><figcaption>${inline(alt)}</figcaption></figure>`;
}

/** Markdown (guide subset) -> HTML body. Images are resolved relative to `baseDir`. */
export function markdownToHtml(md, baseDir = process.cwd()) {
  const out = [];
  const lists = []; // { tag, indent }
  let para = [];
  let quote = null; // { indent, lines }

  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  const flushQuote = () => {
    if (quote) out.push(`<blockquote><p>${quote.lines.map(inline).join('<br>\n')}</p></blockquote>`);
    quote = null;
  };
  // Closes lists deeper than `indent` (all lists with -1).
  const closeLists = (indent) => {
    while (lists.length && lists[lists.length - 1].indent > indent) {
      out.push(`</li></${lists.pop().tag}>`);
    }
  };

  for (const raw of md.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    let m;
    if (line === '') {
      flushPara();
      flushQuote();
      closeLists(-1);
    } else if ((m = /^( *)!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(line))) {
      // An image belongs to the list item it is indented under.
      flushPara();
      flushQuote();
      if (lists.length && m[1].length <= lists[lists.length - 1].indent) closeLists(m[1].length - 1);
      out.push(figure(m[2], m[3], baseDir));
    } else if ((m = /^(#{1,3}) (.*)$/.exec(line))) {
      flushPara();
      flushQuote();
      closeLists(-1);
      const level = m[1].length;
      out.push(`<h${level}>${inline(m[2])}</h${level}>`);
    } else if ((m = /^( *)(\d+\.|[-*]) (.*)$/.exec(line))) {
      flushPara();
      flushQuote();
      const indent = m[1].length;
      const tag = /\d/.test(m[2]) ? 'ol' : 'ul';
      closeLists(indent);
      const top = lists[lists.length - 1];
      if (top && top.indent === indent && top.tag === tag) {
        out.push('</li>');
      } else {
        if (top && top.indent === indent) out.push(`</li></${lists.pop().tag}>`);
        out.push(`<${tag}>`);
        lists.push({ tag, indent });
      }
      out.push(`<li>${inline(m[3])}`);
    } else if ((m = /^( *)> ?(.*)$/.exec(line))) {
      flushPara();
      const indent = m[1].length;
      if (!quote) {
        // A quote indented under a list item belongs to that item.
        if (lists.length && indent <= lists[lists.length - 1].indent) closeLists(indent - 1);
        quote = { indent, lines: [] };
      }
      quote.lines.push(m[2]);
    } else {
      flushQuote();
      if (lists.length && !/^ /.test(line)) closeLists(-1);
      para.push(line.trim());
    }
  }
  flushPara();
  flushQuote();
  closeLists(-1);
  return out.join('\n');
}

const CSS = `
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1d1d1f; --muted: #5f6368; --accent: #6d28d9;
  --code-bg: #f1f0f5; --quote-bg: #f6f4fb; --border: #e3e0ea; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #16151a; --fg: #ececf1; --muted: #a8a8b3; --accent: #b794f6; --code-bg: #26242d;
    --quote-bg: #1f1d25; --border: #34313d; }
}
* { box-sizing: border-box; }
html { background: var(--bg); }
body { margin: 0 auto; max-width: 46rem; padding: 2rem 1rem 4rem; background: var(--bg); color: var(--fg);
  font: 17px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Ubuntu, "Helvetica Neue", Arial, sans-serif; }
h1 { font-size: 1.9rem; line-height: 1.25; margin: 0 0 1rem; }
h2 { font-size: 1.35rem; margin: 2.2rem 0 0.6rem; padding-top: 1rem; border-top: 1px solid var(--border); }
h3 { font-size: 1.1rem; margin: 1.5rem 0 0.5rem; }
p { margin: 0.6rem 0; }
ol, ul { padding-left: 1.6rem; margin: 0.5rem 0; }
li { margin: 0.3rem 0; }
li > ol, li > ul { margin: 0.2rem 0; }
strong { font-weight: 650; }
a { color: var(--accent); }
code { font: 0.9em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--code-bg);
  padding: 0.1em 0.35em; border-radius: 4px; overflow-wrap: anywhere; }
figure { margin: 0.8rem 0; }
figure img { display: block; max-width: 100%; height: auto; border: 1px solid var(--border); border-radius: 8px; }
figcaption { color: var(--muted); font-size: 0.85rem; margin-top: 0.3rem; }
blockquote { margin: 0.6rem 0; padding: 0.6rem 0.9rem; background: var(--quote-bg); border-left: 4px solid var(--accent);
  border-radius: 6px; }
footer { margin-top: 3rem; color: var(--muted); font-size: 0.85rem; }
@media print { body { max-width: none; } h2 { break-after: avoid; } }
`;

/** Full standalone page. */
export function renderPage(md, { lang = 'en', version = '', baseDir = process.cwd() } = {}) {
  const body = markdownToHtml(md, baseDir);
  const title = (/^# (.*)$/m.exec(md)?.[1] ?? 'SwarmCast').replace(/[`*]/g, '');
  const footer = version ? `\n<footer>SwarmCast v${escapeHtml(version)}</footer>` : '';
  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
${body}${footer}
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
  if (files.length !== 2) {
    console.error('Usage: node scripts/build/guide-html.mjs <in.md> <out.html> [--lang en] [--version X.Y.Z]');
    process.exit(2);
  }
  const [input, output] = files;
  fs.writeFileSync(output, renderPage(fs.readFileSync(input, 'utf8'), { ...opts, baseDir: path.dirname(path.resolve(input)) }));
  console.log(`wrote ${output}`);
}
