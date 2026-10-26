#!/usr/bin/env node
// Builds a fake SwarmCast release for the installer tests.
//
//   node make-fake-release.mjs --dir DIR --version X.Y.Z --os macos|linux|windows --arch x64|arm64
//                              [--exe FILE] [--corrupt]
//                              [--ffmpeg-base URL [--ffmpeg-version V] [--ffmpeg-exe FILE] [--ffmpeg-bad-sha]]
//
// Writes DIR/SwarmCast-vX.Y.Z-<os>-<arch>.<zip|tar.gz> with the release layout (files at the
// archive root) and rewrites DIR/SHA256SUMS.txt in GNU format. The fake `swarmcast` is a shell
// script on macOS/Linux; on Windows pass --exe with a compiled swarmcast.exe (see run.ps1).
// --corrupt keeps the checksum of the good archive but damages the archive bytes.
//
// --ffmpeg-base also writes a fake ffmpeg archive (zip on macOS/Windows, tar.xz on Linux, with
// the binary in a subfolder like the real builds) and binaries.json pointing at
// <URL>/<archive>, and lists binaries.json in SHA256SUMS.txt. The fake ffmpeg prints
// "ffmpeg version <V>" (Windows: pass --ffmpeg-exe). --ffmpeg-bad-sha writes a wrong SHA-256
// for the archive into binaries.json (the scripts must skip ffmpeg, not abort).
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

function parseArgs(argv) {
  const opts = { corrupt: false, 'ffmpeg-bad-sha': false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--corrupt') opts.corrupt = true;
    else if (a === '--ffmpeg-bad-sha') opts['ffmpeg-bad-sha'] = true;
    else if (a.startsWith('--')) opts[a.slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${a}`);
  }
  for (const k of ['dir', 'version', 'os', 'arch']) {
    if (!opts[k]) throw new Error(`missing --${k}`);
  }
  if (opts.os === 'windows' && !opts.exe) throw new Error('--exe is required for windows');
  if (opts.exe && !fs.existsSync(opts.exe)) throw new Error(`--exe file not found: ${opts.exe}`);
  if (opts['ffmpeg-base'] && opts.os === 'windows' && !opts['ffmpeg-exe']) throw new Error('--ffmpeg-exe is required for windows');
  return opts;
}

function fakeUnixBinary(version) {
  return `#!/bin/sh
# Fake SwarmCast binary used by the installer tests.
VERSION="${version}"
case " $* " in
  *" --version "*)
    echo "$VERSION"
    exit 0
    ;;
  *" --smoke-test "*)
    echo "fake swarmcast $VERSION: smoke test"
    if [ -n "$SWARMCAST_DATA_DIR" ]; then printf '%s' "$VERSION" > "$SWARMCAST_DATA_DIR/fake-smoke-ran"; fi
    if [ -n "$FAKE_SMOKE_EXIT" ]; then echo "smoke test failed (forced)"; exit "$FAKE_SMOKE_EXIT"; fi
    # A version that crashes on start also fails its self-test.
    if [ -n "$FAKE_CRASH_VERSION" ] && [ "$FAKE_CRASH_VERSION" = "$VERSION" ]; then echo "fake swarmcast $VERSION: crashed in the smoke test"; exit 3; fi
    echo "smoke test passed"
    exit 0
    ;;
  *)
    if [ -n "$FAKE_CRASH_VERSION" ] && [ "$FAKE_CRASH_VERSION" = "$VERSION" ]; then echo "fake swarmcast $VERSION: crashed on start"; exit 3; fi
    echo "fake swarmcast $VERSION started with: $*"
    if [ -n "$SWARMCAST_DATA_DIR" ]; then printf '%s' "$VERSION $*" > "$SWARMCAST_DATA_DIR/fake-started"; fi
    exit 0
    ;;
esac
`;
}

/**
 * Minimal ZIP writer (stored, no compression). Enough for Expand-Archive / ZipFile.
 * Unix permissions go in the external attributes (ignored on Windows, used by .NET on
 * Linux/macOS so run.ps1 can also be exercised with pwsh there).
 */
function writeZip(file, entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const dosTime = 0;
  const dosDate = ((2024 - 1980) << 9) | (1 << 5) | 1;
  for (const { name, data, mode } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, spec 2.0
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  fs.writeFileSync(file, Buffer.concat([...chunks, cdBuf, end]));
}

function fakeFfmpeg(version) {
  return `#!/bin/sh
# Fake ffmpeg used by the installer tests.
case " $* " in
  *" -version "*) echo "ffmpeg version ${version} Copyright (c) fake"; exit 0 ;;
  *) echo "fake ffmpeg ${version}: $*"; exit 0 ;;
esac
`;
}

/** Writes the fake ffmpeg archive + binaries.json into dir; returns the binaries.json SHA256SUMS line. */
function writeFfmpeg(o) {
  const isWin = o.os === 'windows';
  const version = o['ffmpeg-version'] ?? '9.0.2-fake';
  const target = `${o.os}-${o.arch}`;
  const asset = isWin ? `ffmpeg-fake-${version}-win64.zip` : o.os === 'macos' ? `ffmpeg-fake-${version}-macos.zip` : `ffmpeg-fake-${version}-linux.tar.xz`;
  const archive = path.join(o.dir, asset);
  const binName = isWin ? 'ffmpeg.exe' : 'ffmpeg';
  const data = isWin ? fs.readFileSync(o['ffmpeg-exe']) : Buffer.from(fakeFfmpeg(version));
  if (o.os === 'linux') {
    const payload = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmcast-fake-ff-'));
    try {
      const inner = path.join(payload, `ffmpeg-${version}`, 'bin');
      fs.mkdirSync(inner, { recursive: true });
      fs.writeFileSync(path.join(inner, binName), data, { mode: 0o755 });
      fs.writeFileSync(path.join(inner, 'ffprobe'), 'not this one\n', { mode: 0o755 });
      // Fixed timestamps: the same version gives the same archive bytes (and SHA-256) every time.
      for (const p of [path.join(inner, binName), path.join(inner, 'ffprobe'), inner, path.dirname(inner)]) fs.utimesSync(p, 1_700_000_000, 1_700_000_000);
      const res = spawnSync('tar', ['-cJf', archive, '-C', payload, `ffmpeg-${version}`], { stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } });
      if (res.status !== 0) throw new Error('tar -cJf failed (is xz installed?)');
    } finally {
      fs.rmSync(payload, { recursive: true, force: true });
    }
  } else {
    writeZip(archive, [
      { name: `ffmpeg-${version}/bin/${binName}`, data, mode: 0o755 },
      { name: `ffmpeg-${version}/LICENSE.txt`, data: Buffer.from('fake license\n'), mode: 0o644 },
    ]);
  }
  let sha = sha256(archive);
  if (o['ffmpeg-bad-sha']) sha = `${sha.slice(0, -1)}${sha.endsWith('0') ? '1' : '0'}`;
  const targets = ['windows-x64', 'macos-arm64', 'macos-x64', 'linux-x64', 'linux-arm64'];
  const assets = targets.map((t) => {
    const a =
      t === target
        ? { url: `${o['ffmpeg-base'].replace(/\/$/, '')}/${asset}`, asset, sha256: sha, binary: binName, license: 'LGPL-3.0-or-later' }
        : { url: `https://example.invalid/${t}.zip`, asset: `${t}.zip`, sha256: '0'.repeat(64), binary: t.startsWith('windows') ? 'ffmpeg.exe' : 'ffmpeg', license: 'LGPL-3.0-or-later' };
    return `      ${JSON.stringify(t)}: ${JSON.stringify(a).replace(/","/g, '", "').replace(/":"/g, '": "')}`;
  });
  const json = ['{', '  "schema": 1,', '  "ffmpeg": {', `    "version": ${JSON.stringify(version)},`, '    "license": "LGPL-3.0-or-later",', '    "assets": {', assets.join(',\n'), '    }', '  }', '}', ''].join('\n');
  JSON.parse(json);
  const file = path.join(o.dir, 'binaries.json');
  fs.writeFileSync(file, json);
  return `${sha256(file)}  binaries.json`;
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const isWin = o.os === 'windows';
  const x = isWin ? '.exe' : '';
  const ext = isWin ? 'zip' : 'tar.gz';
  fs.mkdirSync(o.dir, { recursive: true });
  const pkgName = `SwarmCast-v${o.version}-${o.os}-${o.arch}.${ext}`;
  const pkgPath = path.join(o.dir, pkgName);

  /** @type {{name: string, data: Buffer, mode: number}[]} */
  const files = [
    {
      name: `swarmcast${x}`,
      data: isWin ? fs.readFileSync(o.exe) : Buffer.from(fakeUnixBinary(o.version)),
      mode: 0o755,
    },
    { name: `bin/mediamtx${x}`, data: Buffer.from('fake mediamtx\n'), mode: 0o755 },
    { name: `bin/cloudflared${x}`, data: Buffer.from('fake cloudflared\n'), mode: 0o755 },
    { name: 'web/viewer/index.html', data: Buffer.from('<!doctype html><title>viewer</title>\n'), mode: 0o644 },
    { name: 'web/admin/index.html', data: Buffer.from('<!doctype html><title>admin</title>\n'), mode: 0o644 },
    { name: 'LICENSE', data: Buffer.from('MIT (fake)\n'), mode: 0o644 },
    { name: 'THIRD_PARTY_LICENSES.txt', data: Buffer.from('none (fake)\n'), mode: 0o644 },
    { name: 'VERSION', data: Buffer.from(`${o.version}\n`), mode: 0o644 },
  ];

  if (isWin) {
    writeZip(pkgPath, files);
  } else {
    const payload = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmcast-fake-'));
    try {
      for (const f of files) {
        const p = path.join(payload, f.name);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, f.data, { mode: f.mode });
        fs.chmodSync(p, f.mode);
      }
      const res = spawnSync(
        'tar',
        ['-czf', pkgPath, '-C', payload, 'swarmcast', 'bin', 'web', 'LICENSE', 'THIRD_PARTY_LICENSES.txt', 'VERSION'],
        { stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } },
      );
      if (res.status !== 0) throw new Error('tar failed');
    } finally {
      fs.rmSync(payload, { recursive: true, force: true });
    }
  }

  const hash = sha256(pkgPath);
  if (o.corrupt) {
    const buf = fs.readFileSync(pkgPath);
    for (let i = Math.floor(buf.length / 2); i < Math.min(buf.length, Math.floor(buf.length / 2) + 16); i++) buf[i] ^= 0xff;
    fs.writeFileSync(pkgPath, buf);
  }

  // Lines for other platforms (dummy hashes) make sure the scripts pick the right one.
  const other = [
    ['windows', 'x64', 'zip'],
    ['macos', 'arm64', 'tar.gz'],
    ['macos', 'x64', 'tar.gz'],
    ['linux', 'x64', 'tar.gz'],
    ['linux', 'arm64', 'tar.gz'],
  ]
    .filter(([os_, arch]) => !(os_ === o.os && arch === o.arch))
    .map(([os_, arch, e]) => `${'0'.repeat(63)}1  SwarmCast-v${o.version}-${os_}-${arch}.${e}`);
  const extra = o['ffmpeg-base'] ? [writeFfmpeg(o)] : [];
  const lines = [...other, ...extra, `${hash}  ${pkgName}`, `${'a'.repeat(64)}  start-macos.sh`].sort((a, b) =>
    a.slice(66).localeCompare(b.slice(66)),
  );
  fs.writeFileSync(path.join(o.dir, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
  console.log(`fake release ${pkgName}${o.corrupt ? ' (corrupted)' : ''} -> ${o.dir}`);
}

main();
