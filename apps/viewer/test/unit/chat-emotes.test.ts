// The built-in emote pack (assets/brand/emotes): the codes the shared chat core knows are the pack
// the viewer ships, every emote has a 56 px and a 112 px WebP small enough to load lazily, and the
// folder holds nothing else (no SVG: emotes are images, never markup).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_EMOTE_CODES, EMOTE_CODE_RE } from '@swarmcast/shared/chat';
import manifest from '../../../../assets/brand/emotes/emotes.json';

const DIR = path.resolve(import.meta.dirname, '../../../../assets/brand/emotes');
const MAX_FILE_BYTES = 16 * 1024;
/** What all the 56 px files together may weigh: the picker loads them at once. */
const MAX_PACK_BYTES = 64 * 1024;
/** What macOS Finder leaves in a folder it showed: never committed (.gitignore), never built (only *.webp is). */
const FINDER_FILES = ['.DS_Store'];
/** Every file of the pack with its expected square size. */
const FILES = manifest.emotes.flatMap((e) => [
  { code: e.code, file: e.file, px: 56 },
  { code: e.code, file: e.file2x, px: 112 },
]);

/** Width and height of a WebP (VP8, VP8L or VP8X) from its header; null when it is not a WebP. */
function webpSize(buf: Buffer): { w: number; h: number } | null {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
  if (chunk === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { w: 1 + (b & 0x3fff), h: 1 + ((b >> 14) & 0x3fff) };
  }
  return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
}

describe('built-in emote pack (assets/brand/emotes)', () => {
  it('the shared code list is the pack the viewer ships (20 emotes)', () => {
    // Act
    const codes = manifest.emotes.map((e) => e.code);

    // Assert
    expect([...BUILTIN_EMOTE_CODES]).toEqual(codes);
    expect(codes).toHaveLength(20);
  });

  it.each(manifest.emotes.map((e) => e.code))('%s is a valid emote code', (code) => {
    // Act
    const ok = EMOTE_CODE_RE.test(code);

    // Assert
    expect(ok).toBe(true);
  });

  it.each(FILES)(`$file is a $px px square WebP under ${MAX_FILE_BYTES / 1024} KB`, ({ file, px }) => {
    // Act
    const buf = fs.readFileSync(path.join(DIR, file));

    // Assert
    expect(webpSize(buf)).toEqual({ w: px, h: px });
    expect(buf.length).toBeLessThan(MAX_FILE_BYTES);
  });

  it(`the 56 px files together stay under ${MAX_PACK_BYTES / 1024} KB`, () => {
    // Act
    const total = FILES.filter((f) => f.px === 56).reduce((n, f) => n + fs.statSync(path.join(DIR, f.file)).size, 0);

    // Assert
    expect(total).toBeLessThan(MAX_PACK_BYTES);
  });

  it('no SVG and nothing else in the folder but the pack, its list and its build script', () => {
    // Arrange
    const expected = new Set(['emotes.json', 'build_emotes.py', ...FILES.map((f) => f.file), ...FINDER_FILES]);

    // Act
    const extra = fs.readdirSync(DIR).filter((f) => !expected.has(f));

    // Assert
    expect(extra).toEqual([]);
  });
});
