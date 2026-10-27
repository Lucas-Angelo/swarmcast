#!/usr/bin/env node
// Renders the social preview cards (og:image, 1200×630) that WhatsApp, Discord, Telegram, X,
// Facebook, LinkedIn and iMessage show when someone pastes a link to the site:
//   public/og/og-en.png   English pages
//   public/og/og-pt-br.png  Portuguese pages
// Each card is an HTML page rendered by Playwright's Chromium, then compressed with sharp to stay
// well under WhatsApp's ~300 KB limit (the script fails above it). Colours come from the brand
// tokens (assets/brand/tokens.css), the lockup and mascot from assets/brand/, the fonts from the
// site's own self-hosted files. The key content (symbol, headline core, mascot) sits in the
// centre, so the square crop some apps show still reads.
//
//   cd site && node scripts/social-cards.mjs            # writes public/og/*.png
//   node scripts/social-cards.mjs --preview <dir>       # also writes the raw renders and square /
//                                                       # thumbnail crops to <dir> for review
// Needs Chromium once: npx playwright install chromium.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import sharp from 'sharp';
import { readTokens } from '../src/tokens.mjs';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRAND = path.resolve(SITE, '../assets/brand');
const OUT = path.join(SITE, 'public/og');
const WIDTH = 1200;
const HEIGHT = 630;
const MAX_BYTES = 300 * 1024;

/** The words on each card. Keep the headline short: it must read at WhatsApp's thumbnail size. */
const CARDS = [
  {
    file: 'og-en.png',
    lang: 'en',
    headline: ['Members-only live streams,', 'straight from your PC'],
    benefits: ['Free', 'No accounts', 'Viewers help share the video'],
  },
  {
    file: 'og-pt-br.png',
    lang: 'pt-BR',
    headline: ['Lives só para membros,', 'direto do seu PC'],
    benefits: ['Grátis', 'Sem cadastro', 'Quem assiste ajuda a transmitir'],
  },
];

const fileUrl = (/** @type {string} */ p) => pathToFileURL(p).href;
const escape = (/** @type {string} */ s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

/** @param {(typeof CARDS)[number]} card */
function html(card) {
  const t = readTokens().light;
  const inter = path.join(SITE, 'node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2');
  return `<!doctype html>
<html lang="${card.lang}">
<head>
<meta charset="utf-8">
<style>
  @font-face { font-family: 'Inter'; src: url('${fileUrl(inter)}') format('woff2'); font-weight: 100 900; }
  * { box-sizing: border-box; margin: 0; }
  html, body { width: ${WIDTH}px; height: ${HEIGHT}px; }
  body {
    position: relative;
    overflow: hidden;
    background: ${t['--sc-bg']};
    color: ${t['--sc-ink']};
    font-family: 'Inter', sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  /* A soft honey disc behind the mascot, cropped by the bottom edge: warm, flat, no gradient. */
  .disc {
    position: absolute;
    left: 50%;
    bottom: -300px;
    width: 580px;
    height: 580px;
    margin-left: -290px;
    border-radius: 50%;
    background: color-mix(in srgb, ${t['--sc-secondary']} 30%, ${t['--sc-bg']});
  }
  .mascot {
    position: absolute;
    left: 50%;
    bottom: -112px;
    width: 390px;
    height: 390px;
    margin-left: -195px;
  }
  .top {
    position: absolute;
    inset: 38px 0 auto 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }
  .lockup { height: 70px; }
  h1 {
    margin-top: 22px;
    font-size: 70px;
    line-height: 1.06;
    font-weight: 750;
    letter-spacing: -0.035em;
  }
  h1 span { display: block; }
  h1 .accent { color: ${t['--sc-accent']}; }
  .benefits {
    margin-top: 20px;
    display: flex;
    align-items: center;
    gap: 16px;
    font-size: 29px;
    font-weight: 550;
    color: ${t['--sc-text']};
    letter-spacing: -0.01em;
  }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: ${t['--sc-secondary']}; }
</style>
</head>
<body>
  <div class="disc"></div>
  <img class="mascot" src="${fileUrl(path.join(BRAND, 'mascot/mascot-live.png'))}" alt="">
  <div class="top">
    <img class="lockup" src="${fileUrl(path.join(BRAND, 'wordmark/swarmcast-lockup-light.svg'))}" alt="SwarmCast">
    <h1><span>${escape(card.headline[0])}</span><span class="accent">${escape(card.headline[1])}</span></h1>
    <div class="benefits">${card.benefits.map((b) => `<span>${escape(b)}</span>`).join('<span class="dot"></span>')}</div>
  </div>
</body>
</html>`;
}

/** Smallest acceptable encoding of a raw PNG render: a palette PNG if it stays crisp and small. */
async function encode(/** @type {Buffer} */ raw) {
  const png = await sharp(raw).png({ palette: true, quality: 95, effort: 10, colours: 256, dither: 0.5 }).toBuffer();
  if (png.length > MAX_BYTES) throw new Error(`card is ${Math.round(png.length / 1024)} KB, over the ${MAX_BYTES / 1024} KB limit`);
  return png;
}

async function main() {
  const previewAt = process.argv.indexOf('--preview');
  const preview = previewAt > 0 ? path.resolve(process.argv[previewAt + 1] ?? '') : undefined;
  fs.mkdirSync(OUT, { recursive: true });
  if (preview) fs.mkdirSync(preview, { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    for (const card of CARDS) {
      const tmp = path.join(OUT, `.${card.file}.html`);
      fs.writeFileSync(tmp, html(card));
      try {
        await page.goto(fileUrl(tmp));
        await page.evaluate(() => document.fonts.ready);
        await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
        const raw = await page.screenshot({ type: 'png' });
        const out = await encode(raw);
        fs.writeFileSync(path.join(OUT, card.file), out);
        console.log(`public/og/${card.file}: ${WIDTH}×${HEIGHT}, ${Math.round(out.length / 1024)} KB`);
        if (preview) {
          const base = path.join(preview, card.file.replace(/\.png$/, ''));
          fs.writeFileSync(`${base}-raw.png`, raw);
          const left = Math.round((WIDTH - HEIGHT) / 2);
          await sharp(out).extract({ left, top: 0, width: HEIGHT, height: HEIGHT }).toFile(`${base}-square.png`);
          await sharp(out).extract({ left, top: 0, width: HEIGHT, height: HEIGHT }).resize(96, 96).toFile(`${base}-square-96.png`);
          await sharp(out).resize(330).toFile(`${base}-330.png`);
        }
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
  } finally {
    await browser.close();
  }
}

await main();
