/**
 * A small QR code encoder (ISO/IEC 18004, byte mode, error correction level M, versions 1–10),
 * for the Pix "copia e cola" code. Pure TypeScript, no network, no SVG: the result is a module
 * matrix that callers draw on a canvas with fillRect. Follows the structure of Project Nayuki's
 * reference encoder (MIT). Tests decode the output with an independent decoder.
 */

const MAX_VERSION = 10;
// Error correction level M, index = version (0 unused).
const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const NUM_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
/** Format bits of level M (the 2-bit indicator is 00). */
const ECL_BITS = 0;

function rawModules(ver: number): number {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}

function dataCodewords(ver: number): number {
  return Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver]! * NUM_BLOCKS[ver]!;
}

// ---- Reed–Solomon over GF(256), polynomial 0x11D ----

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const r = new Array<number>(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = gfMul(r[j]!, root);
      if (j + 1 < r.length) r[j] = r[j]! ^ r[j + 1]!;
    }
    root = gfMul(root, 0x02);
  }
  return r;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const r = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ r.shift()!;
    r.push(0);
    divisor.forEach((coef, i) => (r[i] = r[i]! ^ gfMul(coef, factor)));
  }
  return r;
}

export class QrError extends Error {}

/** The QR module matrix of `text` (UTF-8, byte mode, level M): true = dark. */
export function qrMatrix(text: string): boolean[][] {
  const data = Array.from(new TextEncoder().encode(text));
  let ver = 1;
  for (; ver <= MAX_VERSION; ver++) {
    const countBits = ver < 10 ? 8 : 16;
    if (4 + countBits + data.length * 8 <= dataCodewords(ver) * 8) break;
  }
  if (ver > MAX_VERSION) throw new QrError('text too long for a QR code');
  const countBits = ver < 10 ? 8 : 16;
  // Bit stream: mode 0100 (byte), count, data, terminator, pad.
  const bits: number[] = [];
  const put = (val: number, len: number): void => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  put(0b0100, 4);
  put(data.length, countBits);
  for (const b of data) put(b, 8);
  const capacity = dataCodewords(ver) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

  // Blocks, error correction, interleaving.
  const numBlocks = NUM_BLOCKS[ver]!;
  const eccLen = ECC_PER_BLOCK[ver]!;
  const raw = Math.floor(rawModules(ver) / 8);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = codewords.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const all: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((blk, j) => {
      if (i !== shortLen - eccLen || j >= numShort) all.push(blk[i]!);
    });
  }

  const size = ver * 4 + 17;
  const mods: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fn: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean): void => {
    mods[y]![x] = dark;
    fn[y]![x] = true;
  };

  // Timing patterns.
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  // Finder patterns with separators.
  const finder = (cx: number, cy: number): void => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  // Alignment patterns.
  if (ver > 1) {
    const n = Math.floor(ver / 7) + 2;
    const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    const pos = [6];
    for (let i = n - 2, p = size - 7; i >= 0; i--, p -= step) pos.splice(1, 0, p);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(pos[i]! + dx, pos[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  // Format bits (placeholder, drawn for real after masking) and the dark module.
  const drawFormat = (mask: number): void => {
    const d = (ECL_BITS << 3) | mask;
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const b = ((d << 10) | rem) ^ 0x5412;
    const bit = (i: number): boolean => ((b >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  // Version information (version 7 and up).
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const b = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((b >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const c = Math.floor(i / 3);
      set(a, c, dark);
      set(c, a, dark);
    }
  }
  // Codewords in the zigzag order.
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y]![x] && i < all.length * 8) {
          mods[y]![x] = ((all[i >>> 3]! >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
    }
  }
  // Pick the mask with the lowest penalty.
  const masked = (mask: number): boolean[][] => {
    const m = mods.map((row) => row.slice());
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (fn[y]![x]) continue;
        let inv: boolean;
        switch (mask) {
          case 0: inv = (x + y) % 2 === 0; break;
          case 1: inv = y % 2 === 0; break;
          case 2: inv = x % 3 === 0; break;
          case 3: inv = (x + y) % 3 === 0; break;
          case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: inv = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: inv = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: inv = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
        }
        if (inv) m[y]![x] = !m[y]![x];
      }
    }
    return m;
  };
  let best: boolean[][] = mods;
  let bestMask = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    drawFormat(mask);
    const m = masked(mask);
    const score = penalty(m);
    if (score < bestScore) {
      bestScore = score;
      best = m;
      bestMask = mask;
    }
  }
  drawFormat(bestMask);
  // Copy the final format bits (function modules) into the chosen matrix.
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (fn[y]![x]) best[y]![x] = mods[y]![x]!;
  return best;
}

/** ISO 18004 mask penalty (rules 1–4). */
function penalty(m: boolean[][]): number {
  const n = m.length;
  let score = 0;
  const lines = (get: (a: number, b: number) => boolean): void => {
    for (let a = 0; a < n; a++) {
      let run = 1;
      for (let b = 1; b <= n; b++) {
        if (b < n && get(a, b) === get(a, b - 1)) run++;
        else {
          if (run >= 5) score += 3 + run - 5;
          run = 1;
        }
      }
      for (let b = 0; b + 10 < n; b++) {
        let p = '';
        for (let k = 0; k < 11; k++) p += get(a, b + k) ? '1' : '0';
        if (p === '10111010000' || p === '00001011101') score += 40;
      }
    }
  };
  lines((y, x) => m[y]![x]!);
  lines((x, y) => m[y]![x]!);
  let dark = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (m[y]![x]) dark++;
      if (y + 1 < n && x + 1 < n) {
        const c = m[y]![x];
        if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) score += 3;
      }
    }
  }
  score += Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n)) * 10;
  return score;
}

/** What drawQr needs of a 2D canvas context (keeps this module DOM-free for the server and tests). */
export interface QrCanvasContext {
  fillStyle: string | unknown;
  fillRect(x: number, y: number, w: number, h: number): void;
}

/**
 * Draw `matrix` with a quiet zone of 4 modules, `scale` pixels per module: dark modules in
 * `dark`, the background in `light` (always draw on a light background: scanners need it).
 */
export function drawQr(ctx: QrCanvasContext, matrix: boolean[][], scale: number, colors: { dark: string; light: string } = { dark: '#000000', light: '#ffffff' }): number {
  const quiet = 4;
  const side = (matrix.length + quiet * 2) * scale;
  ctx.fillStyle = colors.light;
  ctx.fillRect(0, 0, side, side);
  ctx.fillStyle = colors.dark;
  matrix.forEach((row, y) => row.forEach((dark, x) => dark && ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale)));
  return side;
}
