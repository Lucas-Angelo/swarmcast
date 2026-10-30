import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_EMOTE_CODES, EMOTE_CODE_RE } from '@swarmcast/shared/chat';
import manifest from '../../../../assets/brand/emotes/emotes.json';

const DIR = path.resolve(import.meta.dirname, '../../../../assets/brand/emotes');

/** Width and height of a WebP (VP8, VP8L or VP8X), from its header. */
function webpSize(buf: Buffer): { w: number; h: number } {
  expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
  expect(buf.toString('ascii', 8, 12)).toBe('WEBP');
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
  if (chunk === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { w: 1 + (b & 0x3fff), h: 1 + ((b >> 14) & 0x3fff) };
  }
  return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
}

describe('built-in emote pack (assets/brand/emotes)', () => {
  it('the shared code list is the pack the viewer ships', () => {
    expect([...BUILTIN_EMOTE_CODES]).toEqual(manifest.emotes.map((e) => e.code));
  });

  it('every emote has a valid code and a 56 px and 112 px WebP, small enough to load lazily', () => {
    let total = 0;
    for (const e of manifest.emotes) {
      expect(EMOTE_CODE_RE.test(e.code), e.code).toBe(true);
      for (const [file, px] of [
        [e.file, 56],
        [e.file2x, 112],
      ] as const) {
        const buf = fs.readFileSync(path.join(DIR, file));
        expect(webpSize(buf), file).toEqual({ w: px, h: px });
        expect(buf.length, file).toBeLessThan(16 * 1024);
        if (px === 56) total += buf.length;
      }
    }
    expect(manifest.emotes.length).toBe(20);
    expect(total).toBeLessThan(64 * 1024);
  });

  it('no SVG and nothing else in the folder but the pack, its list and its build script', () => {
    const expected = new Set(['emotes.json', 'build_emotes.py', ...manifest.emotes.flatMap((e) => [e.file, e.file2x])]);
    for (const f of fs.readdirSync(DIR)) expect(expected.has(f), f).toBe(true);
  });
});
