import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PLAYLIST_WINDOW_S, type SourceInfo } from '@swarmcast/shared';
import type { Logger } from '../core/logger.js';
import {
  SAFE_NAME,
  DiscontinuityClock,
  PlaylistStitcher,
  cleanMultivariant,
  fileName,
  isAudioOnlyVariant,
  mediaPlaylistUris,
  parseMediaPlaylist,
  parseMultivariant,
  type MediaEntry,
  type MultivariantInfo,
} from './playlist.js';

/**
 * Typical (median) EXTINF duration among the newest `count` entries (0 when there are none).
 * The median ignores a single long segment at an OBS reconnect or a quality-ladder switch, so
 * the keyframe warning only fires when OBS really sends keyframes too far apart.
 */
export function maxRecentDuration(entries: readonly MediaEntry[], count = 5): number {
  const d = entries
    .slice(-count)
    .map((e) => e.duration)
    .sort((a, b) => a - b);
  if (d.length === 0) return 0;
  const mid = Math.floor(d.length / 2);
  return d.length % 2 ? d[mid]! : (d[mid - 1]! + d[mid]!) / 2;
}

export interface CachedFile {
  name: string;
  data: Buffer;
  sha256: string;
  contentType: string;
  addedAt: number;
  /** Last time the file was referenced by a live playlist. */
  lastListedAt: number;
}

/** Where the origin pulls HLS from. */
export interface HlsSource {
  readonly kind: 'mediamtx' | 'ladder';
  fetch(uri: string): Promise<Response>;
  /** Forget session state (cookies) after an error. */
  reset(): void;
}

/** MediaMTX's local HLS server, with its cookie check and hlsSession cookie. */
export class MediaMtxSource implements HlsSource {
  readonly kind = 'mediamtx';
  private cookies = new Map<string, string>();
  constructor(private readonly baseUrl: string) {}

  reset(): void {
    this.cookies.clear();
  }

  async fetch(uri: string): Promise<Response> {
    const url = new URL(uri, this.baseUrl);
    for (let hop = 0; hop < 3; hop++) {
      const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await fetch(url, {
        redirect: 'manual',
        headers: cookie ? { cookie } : {},
        signal: AbortSignal.timeout(5000),
      });
      for (const sc of res.headers.getSetCookie()) {
        const [pair] = sc.split(';');
        const eq = pair?.indexOf('=') ?? -1;
        if (pair && eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
      // MediaMTX does a cookie check redirect, then sets an hlsSession cookie.
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        await res.body?.cancel();
        url.href = new URL(res.headers.get('location')!, url).href;
        continue;
      }
      return res;
    }
    throw new Error('too many redirects from MediaMTX');
  }
}

/** A directory written by the local ffmpeg ladder (fMP4 HLS with temp_file renames). */
export class DirectorySource implements HlsSource {
  readonly kind = 'ladder';
  /** `renderIndex` replaces index.m3u8 (null = not ready yet, served as 404). */
  constructor(
    readonly dir: string,
    private readonly renderIndex?: (dir: string) => string | null,
  ) {}
  reset(): void {}
  async fetch(uri: string): Promise<Response> {
    const name = fileName(uri);
    if (!SAFE_NAME.test(name)) return new Response(null, { status: 404 });
    if (name === 'index.m3u8' && this.renderIndex) {
      const text = this.renderIndex(this.dir);
      return text === null ? new Response(null, { status: 404 }) : new Response(text, { status: 200 });
    }
    try {
      return new Response(await fs.readFile(path.join(this.dir, name)), { status: 200 });
    } catch {
      return new Response(null, { status: 404 });
    }
  }
}

export interface ServedVariant {
  name: string;
  height: number;
  width: number;
  /** Advertised BANDWIDTH, kbps. */
  bandwidthKbps: number;
  /** Measured over the last segments (video + its audio), kbps; 0 until known. */
  measuredKbps: number;
}

/**
 * Pulls HLS from a source (MediaMTX or the ffmpeg ladder), keeps a small in-memory cache,
 * hashes every segment and produces rewritten playlists that only list segments we already
 * have (and hashed). Viewers therefore never see a segment whose hash is not in the signed
 * manifest. Media playlists are stitched (PlaylistStitcher) so upstream restarts become
 * discontinuities rather than resets.
 */
export class HlsOrigin extends EventEmitter<{ updated: []; available: [boolean]; multivariant: [MultivariantInfo] }> {
  private source: HlsSource;
  private files = new Map<string, CachedFile>();
  private playlists = new Map<string, string>();
  private stitchers = new Map<string, PlaylistStitcher>();
  /** One numbering of upstream runs for every playlist (see DiscontinuityClock). */
  private discontinuities = new DiscontinuityClock();
  private kbpsByPlaylist = new Map<string, number>();
  private multivariant: string | null = null;
  private multivariantRaw = '';
  private multivariantInfo: MultivariantInfo = { variants: [], audio: [] };
  private multivariantAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private polling = false;
  /**
   * Bumped whenever the set of hashed files grows, and after every poll that changed a
   * playlist. The signed manifest is cached per version (ManifestSigner), so a file added in
   * the middle of a poll, and listed in a playlist served right away, is never answered with a
   * manifest signed before it existed.
   */
  version = 0;
  available = false;
  lastSegmentAt = 0;
  bitrateKbps = 0;
  /** Longest of the newest video segments, seconds. Segments are cut at OBS keyframes. */
  maxSegmentDurationS = 0;
  /** While true the origin keeps polling (so source info is known) but never reports itself available. */
  private holdOff = false;
  /**
   * Seconds every playlist viewers get must cover (shared PLAYLIST_WINDOW_S: the furthest
   * behind live a player sits, plus a margin). Kept per playlist from its actual segment
   * durations, so the ladder's 1 s audio segments get twice the entries of 2 s video.
   */
  get windowSeconds(): number {
    return this._windowSeconds;
  }

  /** Changing it applies to every playlist from its next update (tests emulate older servers). */
  set windowSeconds(s: number) {
    this._windowSeconds = s;
    for (const st of this.stitchers.values()) st.minWindowS = s;
  }

  private _windowSeconds = PLAYLIST_WINDOW_S;

  constructor(
    source: string | HlsSource,
    private readonly log: Logger,
    private readonly pollMs = 1000,
    private readonly retentionMs = 60_000,
  ) {
    super();
    this.source = typeof source === 'string' ? new MediaMtxSource(source) : source;
  }

  get sourceKind(): HlsSource['kind'] {
    return this.source.kind;
  }

  /**
   * Switch where HLS comes from (MediaMTX ↔ ladder, or a new ladder directory after OBS
   * reconnects). Stitchers are kept per playlist name, so a playlist that exists in both
   * (v1080.m3u8 across reconnects) continues with a discontinuity instead of starting over.
   */
  setSource(source: HlsSource): void {
    if (source === this.source) return;
    this.source = source;
    this.multivariant = null;
    this.multivariantRaw = '';
    this.multivariantInfo = { variants: [], audio: [] };
    this.multivariantAt = 0;
    this.playlists.clear();
    this.kbpsByPlaylist.clear();
    this.setAvailable(false);
  }

  /** Hold back availability (used while the quality ladder is starting). */
  hold(on: boolean): void {
    this.holdOff = on;
    if (on) this.setAvailable(false);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = async (): Promise<void> => {
      if (!this.running) return;
      await this.poll();
      if (this.running) this.timer = setTimeout(() => void tick(), this.pollMs);
    };
    void tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.clear();
  }

  /** Delete all cached video from memory. */
  clear(): void {
    this.files.clear();
    this.playlists.clear();
    this.stitchers.clear();
    this.discontinuities = new DiscontinuityClock();
    this.kbpsByPlaylist.clear();
    this.multivariant = null;
    this.multivariantRaw = '';
    this.multivariantInfo = { variants: [], audio: [] };
    this.source.reset();
    this.setAvailable(false);
    this.bitrateKbps = 0;
    this.maxSegmentDurationS = 0;
  }

  get cachedFileCount(): number {
    return this.files.size;
  }

  getPlaylist(name: string): string | undefined {
    if (name === 'index.m3u8') return this.multivariant ?? undefined;
    return this.playlists.get(name);
  }

  /**
   * A media playlist the stream being served does not list: gone for good (the rendition the
   * quality ladder dropped, every ladder playlist once it fell back to the original quality, a
   * quality OBS's reconnect no longer has), not one still to come. Only while the stream is
   * available: before OBS starts, while it reconnects and while the ladder starts or switches
   * (setSource), any playlist may still come (back).
   */
  isGone(name: string): boolean {
    if (!this.available || name === 'index.m3u8') return false;
    return !mediaPlaylistUris(this.multivariantRaw).some((uri) => fileName(uri) === name);
  }

  getFile(name: string): CachedFile | undefined {
    return this.files.get(name);
  }

  /** Map of "/hls/<file>" → sha256 for every cached segment (including init segments). */
  segmentHashes(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of this.files.values()) out[`/hls/${f.name}`] = f.sha256;
    return out;
  }

  /** Video variants of the current multivariant playlist, highest first. */
  variants(): ServedVariant[] {
    const audioKbps = this.multivariantInfo.audio.reduce((a, n) => a + (this.kbpsByPlaylist.get(n) ?? 0), 0);
    return this.multivariantInfo.variants
      .filter((v) => !isAudioOnlyVariant(v))
      .map((v) => {
        const video = this.kbpsByPlaylist.get(v.name) ?? 0;
        return {
          name: v.name,
          height: v.height ?? 0,
          width: v.width ?? 0,
          bandwidthKbps: Math.round(v.bandwidth / 1000),
          measuredKbps: video > 0 ? video + audioKbps : 0,
        };
      })
      .sort((a, b) => b.height - a.height);
  }

  /** What OBS sends, as seen in the source's playlists (highest variant). */
  sourceInfo(): SourceInfo | null {
    const top = this.multivariantInfo.variants.filter((v) => !isAudioOnlyVariant(v)).sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0];
    if (!top?.height || !top.width) return null;
    const hasAudio = this.multivariantInfo.audio.length > 0 || /mp4a|opus|ac-3|ec-3/.test(top.codecs ?? '');
    return {
      width: top.width,
      height: top.height,
      fps: top.frameRate && top.frameRate > 0 ? Math.round(top.frameRate) : 30,
      // Measured when available, otherwise what the source playlist advertises.
      kbps: this.bitrateKbps || Math.round((top.averageBandwidth || top.bandwidth) / 1000),
      hasAudio,
      ...(top.codecs ? { codecs: top.codecs } : {}),
    };
  }

  private setAvailable(v: boolean): void {
    if (this.available !== v) {
      this.available = v;
      this.emit('available', v);
    }
  }

  private markUnavailable(): void {
    this.multivariant = null;
    this.multivariantRaw = '';
    this.playlists.clear();
    this.source.reset();
    this.setAvailable(false);
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    const src = this.source;
    try {
      const now = Date.now();
      if (!this.multivariantRaw || now - this.multivariantAt > 10_000) {
        const res = await src.fetch('index.m3u8');
        if (src !== this.source) return;
        if (!res.ok) {
          await res.body?.cancel();
          if (this.available) this.log.info({ source: src.kind }, 'stream not available from its source (OBS disconnected?)');
          this.markUnavailable();
          return;
        }
        const text = await res.text();
        if (src !== this.source) return;
        this.multivariantRaw = text;
        this.multivariant = cleanMultivariant(text);
        this.multivariantInfo = parseMultivariant(text);
        this.multivariantAt = now;
        this.emit('multivariant', this.multivariantInfo);
      }
      let changed = false;
      const audio = new Set(this.multivariantInfo.audio);
      let maxSegment = 0;
      for (const uri of mediaPlaylistUris(this.multivariantRaw)) {
        const name = fileName(uri);
        if (!SAFE_NAME.test(name)) continue;
        const res = await src.fetch(uri);
        if (src !== this.source) return;
        if (!res.ok) {
          await res.body?.cancel();
          // Session expired or muxer restarted: refetch the multivariant next tick.
          this.multivariantAt = 0;
          src.reset();
          return;
        }
        const parsed = parseMediaPlaylist(await res.text());
        if (parsed.mapUri && !(await this.ensureFile(src, parsed.mapUri, now))) continue;
        const ready: MediaEntry[] = [];
        for (const e of parsed.entries) {
          const fname = fileName(e.uri);
          if (!SAFE_NAME.test(fname)) break;
          const isNew = !this.files.has(fname);
          if (!(await this.ensureFile(src, e.uri, now))) break;
          if (isNew) this.lastSegmentAt = now;
          ready.push(e);
        }
        if (!audio.has(name)) maxSegment = Math.max(maxSegment, maxRecentDuration(ready));
        if (src !== this.source) return;
        let st = this.stitchers.get(name);
        if (!st) this.stitchers.set(name, (st = new PlaylistStitcher(0, this.windowSeconds, this.discontinuities)));
        changed = st.update(parsed, ready) || changed;
        let bytes = 0;
        let seconds = 0;
        for (const e of st.tail(5)) {
          bytes += this.files.get(e.name)?.data.length ?? 0;
          seconds += e.duration;
        }
        if (seconds > 0) this.kbpsByPlaylist.set(name, Math.round((bytes * 8) / seconds / 1000));
        if (st.length > 0) {
          const rendered = st.render();
          if (this.playlists.get(name) !== rendered) {
            this.playlists.set(name, rendered);
            changed = true;
          }
        }
      }
      // Only playlists of the current source keep their files alive; a stitcher left over
      // from the other source just ages out (and is reused if that source comes back).
      const active = new Set(mediaPlaylistUris(this.multivariantRaw).map(fileName));
      if (this.alignRuns(active, audio)) changed = true;
      for (const [name, st] of this.stitchers) {
        if (!active.has(name)) continue;
        for (const n of st.names()) {
          const f = this.files.get(n);
          if (f) f.lastListedAt = now;
        }
      }
      for (const [name, f] of this.files) {
        if (now - f.lastListedAt > this.retentionMs) this.files.delete(name);
      }
      this.maxSegmentDurationS = maxSegment;
      for (const st of this.stitchers.values()) st.prune((n) => this.files.has(n));
      // Bitrate of what OBS sends: the highest video variant plus the audio rendition(s).
      const videoKbps = Math.max(0, ...[...this.kbpsByPlaylist].filter(([n]) => !audio.has(n)).map(([, k]) => k));
      const audioKbps = [...audio].reduce((a, n) => a + (this.kbpsByPlaylist.get(n) ?? 0), 0);
      const sourceVariant = this.variants()[0];
      const topKbps = sourceVariant ? this.kbpsByPlaylist.get(sourceVariant.name) ?? videoKbps : videoKbps;
      if (topKbps > 0) this.bitrateKbps = topKbps + audioKbps;
      const ready = this.playlists.size > 0 && this.multivariant !== null;
      this.setAvailable(ready && !this.holdOff);
      if (changed) {
        this.version += 1;
        this.emit('updated');
      }
    } catch (err) {
      this.log.debug({ err: (err as Error).message }, 'origin poll failed');
      this.setAvailable(false);
    } finally {
      this.polling = false;
    }
  }

  /**
   * The oldest segment of every video playlist has its audio, and the other way round. A player
   * starts at the oldest segment when the window is short and plays a segment only with the audio
   * of the same upstream run (hls.js `cc`): a video playlist that began with a run the audio
   * playlist no longer (or never) had left it with video and no audio, frozen until the stall
   * watchdog moved it. Seen when the ladder fell back to the original: MediaMTX's video playlist,
   * left over from before the ladder, still began with the one segment of a 2 s OBS connection
   * that never reached its audio playlist (quality.spec on macOS CI: a 9 s freeze after the
   * switch). Only such a head goes, and never a whole playlist: the window slides on, sequence and
   * run numbers only grow. Returns true if a playlist changed.
   */
  private alignRuns(active: ReadonlySet<string>, audio: ReadonlySet<string>): boolean {
    const live = [...active].flatMap((name) => {
      const st = this.stitchers.get(name);
      return st && st.length > 0 ? [{ name, st, audio: audio.has(name) }] : [];
    });
    const audios = live.filter((p) => p.audio);
    const videos = live.filter((p) => !p.audio);
    if (audios.length === 0 || videos.length === 0) return false;
    const audioRuns = audios.map((p) => p.st.runs());
    const videoRuns = videos.map((p) => p.st.runs());
    let changed = false;
    for (const p of live) {
      // Video needs its run in every audio playlist; audio needs it in at least one video playlist.
      const stale = p.audio ? (cc: number) => !videoRuns.some((r) => r.has(cc)) : (cc: number) => !audioRuns.every((r) => r.has(cc));
      if (!p.st.dropOldRunsWhile(stale)) continue;
      this.playlists.set(p.name, p.st.render());
      changed = true;
    }
    return changed;
  }

  private async ensureFile(src: HlsSource, uri: string, now: number): Promise<boolean> {
    const name = fileName(uri);
    if (this.files.has(name)) return true;
    if (!SAFE_NAME.test(name)) return false;
    const res = await src.fetch(uri);
    if (!res.ok) {
      await res.body?.cancel();
      return false;
    }
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length === 0) return false;
    this.files.set(name, {
      name,
      data,
      sha256: crypto.createHash('sha256').update(data).digest('hex'),
      contentType: name.includes('audio') ? 'audio/mp4' : 'video/mp4',
      addedAt: now,
      lastListedAt: now,
    });
    // Before any playlist can list it: the next manifest request is signed afresh.
    this.version += 1;
    return true;
  }
}
