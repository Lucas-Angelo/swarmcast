/** Minimal M3U8 helpers for the subset MediaMTX produces (fMP4, no LL-HLS). */

export interface MediaEntry {
  /** Tag lines that precede the URI (EXTINF, PROGRAM-DATE-TIME, ...). */
  tags: string[];
  uri: string;
  duration: number;
}

export interface MediaPlaylist {
  header: string[];
  mapUri?: string;
  entries: MediaEntry[];
  trailer: string[];
}

/** File name of a URI without query string or directories. */
export function fileName(uri: string): string {
  const noQuery = uri.split(/[?#]/)[0] ?? '';
  const name = noQuery.substring(noQuery.lastIndexOf('/') + 1);
  return name;
}

/** Safe file names we accept from MediaMTX and expose under /hls. */
export const SAFE_NAME = /^[A-Za-z0-9_-]{1,80}\.(m3u8|mp4|m4s)$/;

export function parseMediaPlaylist(text: string): MediaPlaylist {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const out: MediaPlaylist = { header: [], entries: [], trailer: [] };
  let pending: string[] = [];
  let seenSegment = false;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MAP:')) {
      const m = /URI="([^"]+)"/.exec(line);
      if (m) out.mapUri = m[1];
      out.header.push(line);
      continue;
    }
    if (line.startsWith('#EXT-X-ENDLIST')) {
      out.trailer.push(line);
      continue;
    }
    if (line.startsWith('#')) {
      if (!seenSegment && !line.startsWith('#EXTINF') && !line.startsWith('#EXT-X-PROGRAM-DATE-TIME') && pending.length === 0) {
        out.header.push(line);
      } else {
        pending.push(line);
      }
      continue;
    }
    const extinf = pending.find((t) => t.startsWith('#EXTINF:'));
    const duration = extinf ? Number.parseFloat(extinf.slice(8)) : 0;
    out.entries.push({ tags: pending, uri: line, duration: Number.isFinite(duration) ? duration : 0 });
    pending = [];
    seenSegment = true;
  }
  return out;
}

/** URIs of media playlists referenced by a multivariant playlist. */
export function mediaPlaylistUris(multivariant: string): string[] {
  const uris = new Set<string>();
  const lines = multivariant.split(/\r?\n/).map((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const m = /URI="([^"]+)"/.exec(line);
      if (m) uris.add(m[1]!);
    } else if (line.startsWith('#EXT-X-STREAM-INF')) {
      const next = lines.slice(i + 1).find((l) => l.length > 0 && !l.startsWith('#'));
      if (next) uris.add(next);
    }
  }
  return [...uris];
}

/** Replace every URI (plain lines and URI="...") with its bare file name. */
export function rewriteMultivariant(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (t.length === 0) return t;
      if (t.startsWith('#')) return t.replace(/URI="([^"]+)"/g, (_m, uri: string) => `URI="${fileName(uri)}"`);
      return fileName(t);
    })
    .join('\n');
}

export function renderMediaPlaylist(p: MediaPlaylist, entries: MediaEntry[]): string {
  const lines: string[] = [];
  for (const h of p.header) {
    lines.push(h.startsWith('#EXT-X-MAP:') ? h.replace(/URI="([^"]+)"/, (_m, uri: string) => `URI="${fileName(uri)}"`) : h);
  }
  for (const e of entries) {
    lines.push(...e.tags, fileName(e.uri));
  }
  lines.push(...p.trailer);
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Multivariant parsing
// ---------------------------------------------------------------------------

export interface VariantInfo {
  /** Media playlist file name. */
  name: string;
  bandwidth: number;
  averageBandwidth?: number;
  width?: number;
  height?: number;
  frameRate?: number;
  codecs?: string;
  audioGroup?: string;
}

export interface MultivariantInfo {
  variants: VariantInfo[];
  /** Audio renditions (EXT-X-MEDIA TYPE=AUDIO): file names. */
  audio: string[];
}

function attr(line: string, key: string): string | undefined {
  const m = new RegExp(`(?:^|[:,])${key}=("([^"]*)"|[^,]*)`).exec(line);
  if (!m) return undefined;
  return m[2] ?? m[1];
}

const VIDEO_CODEC = /\b(avc[13]|hvc1|hev1|av01|vp09|dvh1|dvhe)\b/;

/** True for a STREAM-INF that carries no video (ffmpeg adds one for the audio group). */
export function isAudioOnlyVariant(v: VariantInfo): boolean {
  return !v.height && !!v.codecs && !VIDEO_CODEC.test(v.codecs);
}

export function parseMultivariant(text: string): MultivariantInfo {
  const out: MultivariantInfo = { variants: [], audio: [] };
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('#EXT-X-MEDIA:') && attr(line, 'TYPE') === 'AUDIO') {
      const uri = attr(line, 'URI');
      if (uri) out.audio.push(fileName(uri));
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const next = lines.slice(i + 1).find((l) => l.length > 0 && !l.startsWith('#'));
      if (!next) continue;
      const res = attr(line, 'RESOLUTION');
      const [w, h] = res ? res.split('x').map((n) => Number.parseInt(n, 10)) : [];
      const fr = attr(line, 'FRAME-RATE');
      const avg = attr(line, 'AVERAGE-BANDWIDTH');
      const codecs = attr(line, 'CODECS');
      const audio = attr(line, 'AUDIO');
      out.variants.push({
        name: fileName(next),
        bandwidth: Number.parseInt(attr(line, 'BANDWIDTH') ?? '0', 10) || 0,
        ...(avg ? { averageBandwidth: Number.parseInt(avg, 10) || 0 } : {}),
        ...(w && h ? { width: w, height: h } : {}),
        ...(fr ? { frameRate: Number.parseFloat(fr) } : {}),
        ...(codecs ? { codecs } : {}),
        ...(audio ? { audioGroup: audio } : {}),
      });
    }
  }
  return out;
}

/**
 * Rewrite a multivariant playlist for viewers: bare file names (rewriteMultivariant), no
 * audio-only variant (hls.js could pick it as the "lowest quality"), highest quality first.
 */
export function cleanMultivariant(text: string): string {
  const lines = rewriteMultivariant(text).split('\n');
  const head: string[] = [];
  const variants: Array<{ inf: string; uri: string; height: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      let j = i + 1;
      while (j < lines.length && (lines[j]!.length === 0 || lines[j]!.startsWith('#'))) j++;
      const uri = lines[j];
      i = j;
      if (!uri) continue;
      const info = parseMultivariant(`${line}\n${uri}`).variants[0];
      if (info && isAudioOnlyVariant(info)) continue;
      variants.push({ inf: line, uri, height: info?.height ?? 0 });
    } else if (line.length > 0) {
      head.push(line);
    }
  }
  variants.sort((a, b) => b.height - a.height);
  return [...head, ...variants.flatMap((v) => [v.inf, v.uri])].join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Stitching: one continuous live playlist across upstream restarts
// ---------------------------------------------------------------------------

interface WindowEntry {
  name: string;
  tags: string[];
  duration: number;
  map?: string;
  discontinuity: boolean;
  seq: number;
}

/** Header tags the stitcher writes itself (or drops: a live playlist never ends). */
const OWN_HEADER = /^#(EXTM3U|EXT-X-VERSION|EXT-X-TARGETDURATION|EXT-X-MEDIA-SEQUENCE|EXT-X-DISCONTINUITY-SEQUENCE|EXT-X-MAP|EXT-X-ENDLIST|EXT-X-PLAYLIST-TYPE)\b/;
const DISCONTINUITY_TAG = /^#EXT-X-DISCONTINUITY$/;

/**
 * Keeps our own sliding window for one media playlist so viewers see a single continuous
 * live playlist even when the upstream muxer restarts (OBS reconnect, ffmpeg restart):
 * media sequence numbers only grow, and a new init segment or an upstream reset becomes an
 * EXT-X-DISCONTINUITY instead of a playlist that silently starts over (which hls.js
 * handles badly: it waits for sequence numbers that will never come).
 */
export class PlaylistStitcher {
  private window: WindowEntry[] = [];
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private nextSeq = 0;
  private discontinuitySeq = 0;
  private lastMap?: string;
  private targetDuration = 1;
  private version = '#EXT-X-VERSION:7';
  private header: string[] = [];

  constructor(private readonly maxEntries = 20) {}

  /** Feed the upstream playlist and the prefix of its entries that is cached. Returns true if anything was added. */
  update(p: MediaPlaylist, ready: MediaEntry[]): boolean {
    const map = p.mapUri ? fileName(p.mapUri) : undefined;
    this.header = p.header.filter((h) => !OWN_HEADER.test(h) && !DISCONTINUITY_TAG.test(h));
    this.version = p.header.find((h) => h.startsWith('#EXT-X-VERSION:')) ?? this.version;
    const td = p.header.find((h) => h.startsWith('#EXT-X-TARGETDURATION:'));
    if (td) this.targetDuration = Math.max(this.targetDuration, Number.parseInt(td.slice(22), 10) || 1);
    let added = false;
    for (const e of ready) {
      const name = fileName(e.uri);
      if (this.seen.has(name)) continue;
      const upstreamDisc = e.tags.some((t) => DISCONTINUITY_TAG.test(t));
      this.window.push({
        name,
        tags: e.tags.filter((t) => !DISCONTINUITY_TAG.test(t) && !OWN_HEADER.test(t)),
        duration: e.duration,
        map,
        discontinuity: this.lastMap !== undefined && (map !== this.lastMap || upstreamDisc),
        seq: this.nextSeq++,
      });
      this.targetDuration = Math.max(this.targetDuration, Math.round(e.duration));
      this.lastMap = map;
      this.seen.add(name);
      this.seenOrder.push(name);
      if (this.seenOrder.length > 1000) this.seen.delete(this.seenOrder.shift()!);
      added = true;
    }
    while (this.window.length > Math.max(this.maxEntries, ready.length)) this.dropFirst();
    return added;
  }

  private dropFirst(): void {
    const e = this.window.shift();
    // EXT-X-DISCONTINUITY-SEQUENCE counts the discontinuity tags that left the playlist.
    if (e?.discontinuity) this.discontinuitySeq += 1;
  }

  /** Drop entries whose files are no longer cached (only ever from the old end). */
  prune(exists: (name: string) => boolean): boolean {
    let changed = false;
    while (this.window.length > 0) {
      const first = this.window[0]!;
      if (exists(first.name) && (first.map === undefined || exists(first.map))) break;
      this.dropFirst();
      changed = true;
    }
    return changed;
  }

  get length(): number {
    return this.window.length;
  }

  /** File names (segments and init segments) the rendered playlist references. */
  names(): string[] {
    const out = new Set<string>();
    for (const e of this.window) {
      out.add(e.name);
      if (e.map) out.add(e.map);
    }
    return [...out];
  }

  /** Last `n` entries (for bitrate estimates). */
  tail(n: number): Array<{ name: string; duration: number }> {
    return this.window.slice(-n).map((e) => ({ name: e.name, duration: e.duration }));
  }

  render(): string {
    const lines = ['#EXTM3U', this.version, `#EXT-X-TARGETDURATION:${this.targetDuration}`];
    lines.push(`#EXT-X-MEDIA-SEQUENCE:${this.window[0]?.seq ?? this.nextSeq}`);
    if (this.discontinuitySeq > 0) lines.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${this.discontinuitySeq}`);
    lines.push(...this.header);
    let map: string | undefined;
    for (const e of this.window) {
      if (e.discontinuity) lines.push('#EXT-X-DISCONTINUITY');
      if (e.map && e.map !== map) {
        lines.push(`#EXT-X-MAP:URI="${e.map}"`);
        map = e.map;
      }
      lines.push(...e.tags, e.name);
    }
    return lines.join('\n') + '\n';
  }
}
