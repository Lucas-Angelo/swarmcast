#!/usr/bin/env node
// Assembles local release folders from the real windows-x64 package(s), the same way
// .github/workflows/release.yml does for a GitHub release:
//
//   <out>/rel/          start-windows.ps1/.cmd (+ uninstall-windows.* when present),
//                       SwarmCast-v<V>-windows-x64.zip, SHA256SUMS.txt   (served over HTTP)
//   <out>/rel-new/      same with the newer package v<V2> only (when built)
//   <out>/rel-corrupt/  v9.9.9 package whose bytes do not match SHA256SUMS.txt
//   <out>/SwarmCast-v<V>-windows-x64-installer.zip   the installer bundle sent to the streamer
//
// Usage: node scripts/test/windows/make-release.mjs --out <dir> [--version V] [--newer V2]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { writeChecksums } from '../../build/checksums.mjs';
import { renderBinariesJson } from '../../build/binaries-json.mjs';
import { opt, pkgVersion, repoRoot, sha256File } from './lib.mjs';

const out = path.resolve(opt('out', path.join(repoRoot, 'release', 'win-e2e')));
const V = opt('version', pkgVersion());
const V2 = opt('newer');
const pkgName = (v) => `SwarmCast-v${v}-windows-x64.zip`;
const scripts = ['start-windows.ps1', 'start-windows.cmd', 'uninstall-windows.ps1', 'uninstall-windows.cmd'].filter((f) => fs.existsSync(path.join(repoRoot, 'scripts', f)));

function assertCrlf(file) {
  const text = fs.readFileSync(file, 'latin1');
  if (/[^\r]\n/.test(text) || /^\n/.test(text)) throw new Error(`${file} does not have CRLF line endings (cmd.exe needs them).`);
}

async function releaseDir(name, versions) {
  const dir = path.join(out, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of scripts) {
    fs.copyFileSync(path.join(repoRoot, 'scripts', f), path.join(dir, f));
    if (f.endsWith('.cmd') || f.endsWith('.ps1')) assertCrlf(path.join(dir, f));
  }
  for (const v of versions) fs.copyFileSync(path.join(repoRoot, 'release', pkgName(v)), path.join(dir, pkgName(v)));
  writeBinariesJson(dir);
  await writeChecksums(dir);
  console.log(`${dir}: ${fs.readdirSync(dir).join(', ')}`);
  return dir;
}

/** binaries.json (ffmpeg pins), as release.yml publishes it; the start script downloads ffmpeg from it. */
function writeBinariesJson(dir) {
  const versions = JSON.parse(fs.readFileSync(path.join(repoRoot, 'scripts', 'build', 'versions.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'binaries.json'), renderBinariesJson(versions));
}

fs.mkdirSync(out, { recursive: true });
await releaseDir('rel', [V]);
if (V2) await releaseDir('rel-new', [V2]);

// Corrupted download: SHA256SUMS.txt lists the real hash, the file has one byte flipped.
{
  const dir = path.join(out, 'rel-corrupt');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of scripts) fs.copyFileSync(path.join(repoRoot, 'scripts', f), path.join(dir, f));
  const src = path.join(repoRoot, 'release', pkgName(V));
  const bad = path.join(dir, pkgName('9.9.9'));
  const hash = sha256File(src);
  const buf = fs.readFileSync(src);
  buf[Math.floor(buf.length / 2)] ^= 0xff;
  fs.writeFileSync(bad, buf);
  fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), `${hash}  ${pkgName('9.9.9')}\n`);
  console.log(`${dir}: corrupted ${pkgName('9.9.9')} (listed hash ${hash})`);
}

// Installer bundle, as built by release.yml ("Build installer bundles").
{
  const dir = path.join(out, 'bundle-staging');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const bundleScripts = scripts.filter((f) => f.endsWith('.cmd') || f.endsWith('.ps1'));
  for (const f of bundleScripts) fs.copyFileSync(path.join(repoRoot, 'scripts', f), path.join(dir, f));
  fs.copyFileSync(path.join(repoRoot, 'release', pkgName(V)), path.join(dir, pkgName(V)));
  writeBinariesJson(dir);
  fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), `${sha256File(path.join(dir, pkgName(V)))}  ${pkgName(V)}\n${sha256File(path.join(dir, 'binaries.json'))}  binaries.json\n`);
  const guides = [
    ['docs/TUTORIAL_EN.md', 'READ-ME - How to go live.html', 'en'],
    ['docs/TUTORIAL_PT-BR.md', 'LEIA-ME - Como fazer a live.html', 'pt-BR'],
  ];
  for (const [md, html, lang] of guides) {
    execFileSync(process.execPath, [path.join(repoRoot, 'scripts/build/guide-html.mjs'), path.join(repoRoot, md), path.join(dir, html), '--lang', lang, '--version', V], { stdio: 'inherit' });
  }
  const readme = [
    'EN: 1) Extract this zip (right-click > Extract All). 2) In the extracted folder, double-click start-windows.cmd.',
    'PT: 1) Extraia este zip (botão direito > Extrair tudo). 2) Na pasta extraída, dê dois cliques em start-windows.cmd.',
  ].join('\r\n');
  fs.writeFileSync(path.join(dir, 'README.txt'), '\ufeff' + readme + '\r\n');
  const zip = path.join(out, `SwarmCast-v${V}-windows-x64-installer.zip`);
  fs.rmSync(zip, { force: true });
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'zip';
  const files = fs.readdirSync(dir);
  if (process.platform === 'win32') execFileSync(tar, ['-a', '-cf', zip, ...files], { cwd: dir, stdio: 'inherit' });
  else execFileSync('zip', ['-X', '-q', zip, ...files], { cwd: dir, stdio: 'inherit' });
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`${zip}: ${files.join(', ')}`);
}
