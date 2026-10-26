#!/usr/bin/env node
// Draws a placeholder of the SwarmCast app icon (a broadcast symbol on a forest tile) as a
// 1024×1024 PNG, used until the brand ships assets/brand/app-icon-1024.png. No image libraries:
// shapes are signed distance fields, so edges are anti-aliased. The per-OS sizes are then made
// by apps/desktop/icons.mjs (see apps/desktop/README.md, "Icons").
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SIZE = 1024;
const here = path.dirname(fileURLToPath(import.meta.url));

// "Forest & Cream": forest primary (#0F5C53), slightly lighter at the top; cream mark (#FFFDF8).
const TOP = [0x16, 0x72, 0x67];
const BOTTOM = [0x0f, 0x5c, 0x53];
const MARK = [0xff, 0xfd, 0xf8];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const coverage = (d) => clamp(0.5 - d, 0, 1);

/** Rounded square (macOS grid: 824 px body, 100 px margin, ~185 px corner radius). */
function sdRoundRect(x, y, cx, cy, half, r) {
  const qx = Math.abs(x - cx) - (half - r);
  const qy = Math.abs(y - cy) - (half - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Arc of radius `r`, stroke `w`, opening ±`half` radians around the horizontal axis, on
 *  both sides of the center (mirrored), with round caps. */
function sdArcs(x, y, cx, cy, r, w, half) {
  const px = Math.abs(x - cx);
  const py = y - cy;
  const angle = Math.atan2(Math.abs(py), px);
  if (angle <= half) return Math.abs(Math.hypot(px, py) - r) - w / 2;
  const ex = r * Math.cos(half);
  const ey = r * Math.sin(half) * Math.sign(py || 1);
  return Math.hypot(px - ex, py - ey) - w / 2;
}

const pixels = Buffer.alloc(SIZE * SIZE * 4);
const c = SIZE / 2;
for (let y = 0; y < SIZE; y++) {
  const t = (y - 100) / 824;
  const bg = TOP.map((v, i) => Math.round(v + (BOTTOM[i] - v) * clamp(t, 0, 1)));
  for (let x = 0; x < SIZE; x++) {
    const px = x + 0.5;
    const py = y + 0.5;
    const body = coverage(sdRoundRect(px, py, c, c, 412, 185));
    if (body === 0) continue;
    const dot = coverage(Math.hypot(px - c, py - c) - 74);
    const inner = coverage(sdArcs(px, py, c, c, 175, 58, 0.78));
    const outer = coverage(sdArcs(px, py, c, c, 290, 58, 0.78));
    const fg = Math.max(dot, inner, outer * 0.85);
    const o = (y * SIZE + x) * 4;
    for (let i = 0; i < 3; i++) pixels[o + i] = Math.round(bg[i] + (MARK[i] - bg[i]) * fg);
    pixels[o + 3] = Math.round(255 * body);
  }
}

// ---- PNG (RGBA, 8 bit) ----
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let v = n;
  for (let k = 0; k < 8; k++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1;
  return v >>> 0;
});
function crc32(buf) {
  let v = 0xffffffff;
  for (const b of buf) v = CRC_TABLE[(v ^ b) & 0xff] ^ (v >>> 8);
  return (v ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr.set([8, 6, 0, 0, 0], 8);
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(here, 'source.png');
fs.writeFileSync(out, png);
console.log(`✓ ${path.relative(process.cwd(), out)}`);
