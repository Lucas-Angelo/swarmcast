#!/usr/bin/env node
// Regenerates every desktop app icon from one 1024×1024 PNG (app window, Dock / taskbar, .icns,
// .ico used by the NSIS installer and uninstaller, Linux PNGs) and copies the tray icons.
//
//   node apps/desktop/icons.mjs [source.png]
//
// Source: assets/brand/app-icon-1024.png if it exists, else the neutral placeholder drawn by
// src-tauri/icons/gen.mjs. Tray icons (32×32 PNG: off, waiting, live): assets/brand/tray/*.png
// if they exist, else apps/tray/icons/*.png. Commit the results.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const iconsDir = path.join(here, 'src-tauri', 'icons');
const brand = path.join(root, 'assets', 'brand');

let source = process.argv[2] ?? path.join(brand, 'app-icon-1024.png');
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

const trayFrom = fs.existsSync(path.join(brand, 'tray')) ? path.join(brand, 'tray') : path.join(root, 'apps', 'tray', 'icons');
for (const state of ['off', 'waiting', 'live']) {
  fs.copyFileSync(path.join(trayFrom, `${state}.png`), path.join(iconsDir, 'tray', `${state}.png`));
}
console.log(`✓ app icons from ${path.relative(root, source)}, tray icons from ${path.relative(root, trayFrom)}`);
