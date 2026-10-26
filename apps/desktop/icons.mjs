#!/usr/bin/env node
// Regenerates every desktop app icon from one 1024×1024 PNG (app window, Dock / taskbar, .icns,
// .ico used by the NSIS installer and uninstaller, Linux PNGs) and copies the tray icons.
//
//   node apps/desktop/icons.mjs [source.png]
//
// Source: assets/brand/icon/app-icon-1024.png if it exists, else the neutral placeholder drawn by
// src-tauri/icons/gen.mjs. The small sizes of the Windows .ico (16–48 px) and 32x32.png come from the
// hand-simplified glyphs in assets/brand/icon/sizes/ when present, since a plain downscale of the
// 1024 px art blurs at those sizes. Tray icons (32×32 PNG: off, waiting, live):
// assets/brand/tray/tray-<state>-32.png if they exist, else apps/tray/icons/<state>.png.
// Commit the results.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const iconsDir = path.join(here, 'src-tauri', 'icons');
const brand = path.join(root, 'assets', 'brand');

let source = process.argv[2] ?? path.join(brand, 'icon', 'app-icon-1024.png');
if (!fs.existsSync(source)) {
  execFileSync(process.execPath, [path.join(iconsDir, 'gen.mjs')], { stdio: 'inherit' });
  source = path.join(iconsDir, 'source.png');
}
execFileSync(process.execPath, [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'icon', source, '-o', iconsDir], { stdio: 'inherit' });
// Desktop only: drop what `tauri icon` makes for mobile and the Windows Store.
for (const name of fs.readdirSync(iconsDir)) {
  if (['android', 'ios', '64x64.png', 'StoreLogo.png'].includes(name) || /^Square\d+x\d+Logo\.png$/.test(name)) {
    fs.rmSync(path.join(iconsDir, name), { recursive: true, force: true });
  }
}

// Hand-tuned small sizes: rebuild the .ico (PNG entries, read by Windows Vista and later) and 32x32.png.
const sizes = path.join(brand, 'icon', 'sizes');
if (fs.existsSync(sizes)) {
  const entries = [16, 24, 32, 48, 64, 128, 256].map((px) => ({ px, png: fs.readFileSync(path.join(sizes, `app-icon-${px}.png`)) }));
  fs.writeFileSync(path.join(iconsDir, 'icon.ico'), buildIco(entries));
  fs.copyFileSync(path.join(sizes, 'app-icon-32.png'), path.join(iconsDir, '32x32.png'));
}

const brandTray = path.join(brand, 'tray');
for (const state of ['off', 'waiting', 'live']) {
  const fromBrand = path.join(brandTray, `tray-${state}-32.png`);
  const from = fs.existsSync(fromBrand) ? fromBrand : path.join(root, 'apps', 'tray', 'icons', `${state}.png`);
  fs.copyFileSync(from, path.join(iconsDir, 'tray', `${state}.png`));
}
console.log(`✓ app icons from ${path.relative(root, source)}, tray icons from ${path.relative(root, fs.existsSync(brandTray) ? brandTray : path.join(root, 'apps', 'tray', 'icons'))}`);

/** An .ico file whose images are stored as PNG (one directory entry per size). */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach(({ px, png }, i) => {
    const at = i * 16;
    dir.writeUInt8(px >= 256 ? 0 : px, at); // 0 means 256
    dir.writeUInt8(px >= 256 ? 0 : px, at + 1);
    dir.writeUInt16LE(1, at + 4); // colour planes
    dir.writeUInt16LE(32, at + 6); // bits per pixel
    dir.writeUInt32LE(png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}
