// The few Cap'n Proto pieces the local Cloudflare edge (cloudflare.mjs) needs to answer
// cloudflared: messages on a byte stream (the "stream framing": segment table, then segments),
// structs, data, text, struct lists and capability pointers, read and written by hand
// (https://capnproto.org/encoding.html). Enough for the RPC answers of one interface, nothing
// more: no packing, no generics, one segment per message written.

const WORD = 8;

/**
 * Splits complete messages off the front of `buf` (stream framing). Returns the messages and
 * the bytes left over (an incomplete message).
 * @param {Buffer} buf
 * @returns {{ messages: Reader[], rest: Buffer }}
 */
export function readFrames(buf) {
  const messages = [];
  let at = 0;
  for (;;) {
    if (buf.length - at < 4) break;
    const count = buf.readUInt32LE(at) + 1;
    const table = 4 + count * 4;
    const header = table + (table % WORD ? WORD - (table % WORD) : 0);
    if (buf.length - at < header) break;
    const sizes = Array.from({ length: count }, (_, i) => buf.readUInt32LE(at + 4 + i * 4) * WORD);
    const total = header + sizes.reduce((a, b) => a + b, 0);
    if (buf.length - at < total) break;
    const segments = [];
    let s = at + header;
    for (const size of sizes) {
      segments.push(buf.subarray(s, s + size));
      s += size;
    }
    messages.push(new Reader(segments));
    at += total;
  }
  return { messages, rest: buf.subarray(at) };
}

/** A message read from the stream: its root struct and what its pointers lead to. */
export class Reader {
  /** @param {Buffer[]} segments */
  constructor(segments) {
    this.segments = segments;
  }

  /** @returns {StructReader | null} */
  root() {
    return this.pointer(0, 0);
  }

  /**
   * What the pointer at word `word` of segment `seg` points to: a StructReader, a Buffer (a
   * list of bytes: Data, or Text with its NUL), `{ cap: index }`, or null.
   * @param {number} seg
   * @param {number} word
   */
  pointer(seg, word) {
    const s = this.segments[seg];
    const lo = s.readUInt32LE(word * WORD);
    const hi = s.readUInt32LE(word * WORD + 4);
    if (lo === 0 && hi === 0) return null;
    const kind = lo & 3;
    if (kind === 2) {
      // Far pointer: a landing pad in segment `hi` (double-far pads are not written by Go's capnp for these messages).
      if (lo & 4) throw new Error('capnp: double-far pointers are not supported');
      return this.pointer(hi, lo >>> 3);
    }
    if (kind === 3) return { cap: hi };
    const target = word + 1 + (lo >> 2);
    if (kind === 0) return new StructReader(this, seg, target, hi & 0xffff, hi >>> 16);
    const size = hi & 7;
    const count = hi >>> 3;
    if (size !== 2) throw new Error(`capnp: list of element size ${size} is not supported`);
    return s.subarray(target * WORD, target * WORD + count);
  }
}

export class StructReader {
  constructor(msg, seg, word, dataWords, ptrCount) {
    Object.assign(this, { msg, seg, word, dataWords, ptrCount });
  }

  #data(byte, bytes) {
    return byte + bytes <= this.dataWords * WORD ? this.msg.segments[this.seg].subarray(this.word * WORD + byte, this.word * WORD + byte + bytes) : null;
  }

  u8(byte) {
    return this.#data(byte, 1)?.readUInt8(0) ?? 0;
  }

  u16(byte) {
    return this.#data(byte, 2)?.readUInt16LE(0) ?? 0;
  }

  u32(byte) {
    return this.#data(byte, 4)?.readUInt32LE(0) ?? 0;
  }

  u64(byte) {
    return this.#data(byte, 8)?.readBigUInt64LE(0) ?? 0n;
  }

  /** @param {number} i */
  ptr(i) {
    return i < this.ptrCount ? this.msg.pointer(this.seg, this.word + this.dataWords + i) : null;
  }
}

/** Builds one single-segment message; `root(dataWords, ptrCount)` first, then fill the structs. */
export class Builder {
  #buf = Buffer.alloc(64 * WORD);
  #used = 1; // word 0: the root pointer

  #alloc(words) {
    const at = this.#used;
    this.#used += words;
    if (this.#used * WORD > this.#buf.length) {
      const grown = Buffer.alloc(Math.max(this.#buf.length * 2, this.#used * WORD));
      this.#buf.copy(grown);
      this.#buf = grown;
    }
    return at;
  }

  #setPtr(slot, lo, hi) {
    this.#buf.writeUInt32LE(lo >>> 0, slot * WORD);
    this.#buf.writeUInt32LE(hi >>> 0, slot * WORD + 4);
  }

  /** A new struct pointed to by the pointer at word `slot`. */
  #struct(slot, dataWords, ptrCount) {
    const at = this.#alloc(dataWords + ptrCount);
    this.#setPtr(slot, ((at - slot - 1) << 2) | 0, dataWords | (ptrCount << 16));
    return new StructBuilder(this, at, dataWords, ptrCount);
  }

  root(dataWords, ptrCount) {
    return this.#struct(0, dataWords, ptrCount);
  }

  /** @internal */
  buf() {
    return this.#buf;
  }

  /** @internal */
  structAt(slot, dataWords, ptrCount) {
    return this.#struct(slot, dataWords, ptrCount);
  }

  /** @internal */
  bytesAt(slot, bytes) {
    const at = this.#alloc(Math.ceil(bytes.length / WORD));
    bytes.copy(this.#buf, at * WORD);
    this.#setPtr(slot, ((at - slot - 1) << 2) | 1, 2 | (bytes.length << 3));
  }

  /** @internal */
  structListAt(slot, dataWords, ptrCount, n) {
    const perElement = dataWords + ptrCount;
    const tag = this.#alloc(1 + n * perElement);
    this.#setPtr(slot, ((tag - slot - 1) << 2) | 1, 7 | ((n * perElement) << 3));
    this.#setPtr(tag, (n << 2) | 0, dataWords | (ptrCount << 16));
    return Array.from({ length: n }, (_, i) => new StructBuilder(this, tag + 1 + i * perElement, dataWords, ptrCount));
  }

  /** @internal */
  capAt(slot, index) {
    this.#setPtr(slot, 3, index);
  }

  /** The message with its stream framing (one segment). */
  frame() {
    const head = Buffer.alloc(WORD);
    head.writeUInt32LE(0, 0);
    head.writeUInt32LE(this.#used, 4);
    return Buffer.concat([head, this.#buf.subarray(0, this.#used * WORD)]);
  }
}

export class StructBuilder {
  constructor(b, word, dataWords, ptrCount) {
    Object.assign(this, { b, word, dataWords, ptrCount });
  }

  #at(byte) {
    return this.word * WORD + byte;
  }

  #slot(i) {
    return this.word + this.dataWords + i;
  }

  u16(byte, v) {
    this.b.buf().writeUInt16LE(v, this.#at(byte));
    return this;
  }

  u32(byte, v) {
    this.b.buf().writeUInt32LE(v >>> 0, this.#at(byte));
    return this;
  }

  bit(bit, on) {
    const at = this.#at(bit >> 3);
    const buf = this.b.buf();
    buf[at] = on ? buf[at] | (1 << (bit & 7)) : buf[at] & ~(1 << (bit & 7));
    return this;
  }

  struct(i, dataWords, ptrCount) {
    return this.b.structAt(this.#slot(i), dataWords, ptrCount);
  }

  data(i, bytes) {
    this.b.bytesAt(this.#slot(i), bytes);
    return this;
  }

  text(i, s) {
    this.b.bytesAt(this.#slot(i), Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]));
    return this;
  }

  structList(i, dataWords, ptrCount, n) {
    return this.b.structListAt(this.#slot(i), dataWords, ptrCount, n);
  }

  cap(i, index) {
    this.b.capAt(this.#slot(i), index);
    return this;
  }
}

// ---- RPC (rpc.capnp): the messages a server of one bootstrap interface sends and reads ----

/** Message union members (rpc.capnp `Message`). */
export const Msg = { abort: 1, call: 2, return: 3, finish: 4, resolve: 5, release: 6, bootstrap: 8, disembargo: 13 };

/**
 * A Return of `answerId` whose results are filled by `fill(content)` (a StructBuilder of
 * `dataWords`/`ptrCount`, or the bootstrap capability when `cap` is set: capTable [senderHosted 0]).
 * @param {number} answerId
 * @param {{ dataWords?: number, ptrCount?: number, fill?: (s: StructBuilder) => void, cap?: boolean }} results
 */
export function returnMessage(answerId, { dataWords = 0, ptrCount = 0, fill, cap = false } = {}) {
  const b = new Builder();
  const msg = b.root(1, 1).u16(0, Msg.return);
  // Return: answerId u32 @0, releaseParamCaps bit 32 (stored inverted: default true), which u16 @6 (0 = results).
  const ret = msg.struct(0, 2, 1).u32(0, answerId).u16(6, 0);
  const payload = ret.struct(0, 0, 2);
  if (cap) {
    payload.cap(0, 0);
    // CapDescriptor: which u16 @0 (1 = senderHosted), id u32 @4.
    payload.structList(1, 1, 1, 1)[0].u16(0, 1).u32(4, 0);
  } else {
    const content = payload.struct(0, dataWords, ptrCount);
    fill?.(content);
    payload.structList(1, 1, 1, 0);
  }
  return b.frame();
}

/** A Return of `answerId` with an exception (`reason`). */
export function exceptionMessage(answerId, reason) {
  const b = new Builder();
  const msg = b.root(1, 1).u16(0, Msg.return);
  const ret = msg.struct(0, 2, 1).u32(0, answerId).u16(6, 1);
  // Exception: reason text ptr 0, type u16 @4 (0 = failed).
  ret.struct(0, 1, 1).text(0, reason);
  return b.frame();
}

/**
 * What one RPC message asks: `{ which, id }` for every message (the question id of a bootstrap,
 * call or finish), plus for a call its interface, method and params struct.
 * @param {Reader} m
 */
export function readRpc(m) {
  const root = m.root();
  const which = root?.u16(0) ?? -1;
  const body = root?.ptr(0);
  if (!(body instanceof StructReader)) return { which, id: -1 };
  if (which !== Msg.call) return { which, id: body.u32(0) };
  const payload = body.ptr(1);
  const params = payload instanceof StructReader ? payload.ptr(0) : null;
  return { which, id: body.u32(0), interfaceId: body.u64(8), methodId: body.u16(4), params: params instanceof StructReader ? params : null };
}
