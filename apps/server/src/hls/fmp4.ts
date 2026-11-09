/**
 * The little of ISO BMFF (fMP4) the origin reads: where a media segment starts on the stream's
 * media clock (its first track fragment's decode time, `tfdt`, over its track's timescale from
 * the init segment's `mdhd`). Both MediaMTX and the ffmpeg ladder put every track of a stream on
 * one media clock, so this says which segments of the audio and video playlists hold the same
 * moment (HlsOrigin, DiscontinuityClock.dateAt). Anything it cannot read gives undefined.
 */

interface Box {
  type: string;
  /** Offset of the payload. */
  start: number;
  /** Offset just past the box. */
  end: number;
}

/** The boxes in `b[from, to)`, stopping at the first one that does not fit. */
function* boxes(b: Uint8Array, from: number, to: number): Generator<Box> {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = from;
  while (at + 8 <= to) {
    let size = view.getUint32(at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) return;
      const big = view.getBigUint64(at + 8);
      if (big > BigInt(to - at)) return;
      size = Number(big);
      header = 16;
    } else if (size === 0) size = to - at;
    if (size < header || at + size > to) return;
    const type = String.fromCharCode(b[at + 4]!, b[at + 5]!, b[at + 6]!, b[at + 7]!);
    yield { type, start: at + header, end: at + size };
    at += size;
  }
}

/** The first box of `type` inside `parent` (the whole buffer when undefined). */
function child(b: Uint8Array, parent: Box | undefined, type: string): Box | undefined {
  for (const box of boxes(b, parent?.start ?? 0, parent?.end ?? b.byteLength)) if (box.type === type) return box;
  return undefined;
}

/** Every box of `type` inside `parent`. */
function children(b: Uint8Array, parent: Box, type: string): Box[] {
  return [...boxes(b, parent.start, parent.end)].filter((box) => box.type === type);
}

/** A 32-bit field of a full box (version and flags take its first 4 bytes), or a 64-bit one for version 1 where it has one. */
function field(b: Uint8Array, box: Box, offsetV0: number, offsetV1: number, wideInV1: boolean): number | undefined {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const v1 = b[box.start] === 1;
  const at = box.start + (v1 ? offsetV1 : offsetV0);
  const wide = v1 && wideInV1;
  if (at + (wide ? 8 : 4) > box.end) return undefined;
  return wide ? Number(view.getBigUint64(at)) : view.getUint32(at);
}

/** Ticks per second of each track of an init segment, by track ID (empty when it is not one). */
export function trackTimescales(init: Uint8Array): Map<number, number> {
  const out = new Map<number, number>();
  const moov = child(init, undefined, 'moov');
  if (!moov) return out;
  for (const trak of children(init, moov, 'trak')) {
    const tkhd = child(init, trak, 'tkhd');
    const mdia = child(init, trak, 'mdia');
    const mdhd = mdia && child(init, mdia, 'mdhd');
    if (!tkhd || !mdhd) continue;
    // tkhd: creation, modification (32 or 64 bits), then track_ID; mdhd: the same two, then timescale.
    const id = field(init, tkhd, 12, 20, false);
    const timescale = field(init, mdhd, 12, 20, false);
    if (id !== undefined && timescale) out.set(id, timescale);
  }
  return out;
}

/**
 * Where a media segment starts on the media clock, seconds: the decode time of its first track
 * fragment over that track's timescale (`timescales`, from its init segment). Undefined when
 * the segment or its track cannot be read.
 */
export function segmentStart(segment: Uint8Array, timescales: Map<number, number>): number | undefined {
  const moof = child(segment, undefined, 'moof');
  const traf = moof && child(segment, moof, 'traf');
  const tfhd = traf && child(segment, traf, 'tfhd');
  const tfdt = traf && child(segment, traf, 'tfdt');
  if (!tfhd || !tfdt) return undefined;
  const id = field(segment, tfhd, 4, 4, false);
  const time = field(segment, tfdt, 4, 4, true);
  const timescale = (id !== undefined ? timescales.get(id) : undefined) ?? (timescales.size === 1 ? [...timescales.values()][0] : undefined);
  return time === undefined || !timescale ? undefined : time / timescale;
}
