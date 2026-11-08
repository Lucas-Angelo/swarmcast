/**
 * "Audio only (saves data)" (docs/QUALITY.md "Audio only"): the viewer hears the stream without
 * the picture. The server writes /hls/audio-only.m3u8, a multivariant playlist whose one variant
 * is the stream's own audio rendition (apps/server/src/hls/playlist.ts
 * renderAudioOnlyMultivariant); the player loads it instead of index.m3u8, and back. About
 * 0.1-0.16 Mbps instead of 0.9 (360p) to 6 (the original): roughly 85 % less than 360p.
 *
 * - `audioOnlyState`: what the player plays now (not the saved choice), for anything that
 *   depends on it: the poster here, the quality menu, the P2P swarm id (player-config.ts
 *   swarmIdBuilderFor) and a screen wake lock, which has nothing to keep on while only sound plays.
 * - `createAudioOnlySwitch`: the source to load (every load and reload of the player goes through
 *   `url()`, so the stall watchdog, vanished playlists and network errors keep the choice) and
 *   the switch itself, remembered per browser (player-config.ts loadAudioOnly).
 * - `mountAudioOnlyPoster`: what the video area shows meanwhile: the streamer's picture and name
 *   ("Your page", when set) and "Audio only", never a frozen last frame.
 */
import './audio-only.css';
import { AUDIO_ONLY_PLAYLIST } from '@swarmcast/shared';

/** The audio-only playlist under /hls (served with the session cookie, like index.m3u8). */
export const AUDIO_ONLY_URL = `/hls/${AUDIO_ONLY_PLAYLIST}`;

/**
 * 404s on its media playlist after which audio-only playback loads the audio-only playlist
 * again (player-config.ts createManifestReloader; video keeps its 3). The server answers 404 only
 * for a playlist the stream being served no longer lists (HlsOrigin.isGone: the ladder's
 * audio.m3u8 once it fell back to the original), so the first is final. Waiting for three cost
 * the 1 s audio playlist about 3 s, and a viewer who had joined a young ladder stream held only
 * about 2 s of audio: a freeze of up to 4.7 s (audio-only.spec.ts, WebKit) instead of none.
 */
export const AUDIO_ONLY_GONE_AFTER = 1;

/** The parts of TimeRanges and of the media element a reload in place touches. */
export interface Ranges {
  readonly length: number;
  start(i: number): number;
  end(i: number): number;
}
export interface KeptElement {
  readonly buffered: Ranges;
  readonly seeking: boolean;
  currentTime: number;
  addEventListener(type: 'seeked', fn: () => void, o: { once: true }): void;
}

/** What hls.js `transferMedia()` hands over: the element with its MediaSource and SourceBuffers. */
export interface KeptMedia {
  media: KeptElement;
}

/** The part of hls.js a reload of the audio-only playlist uses. */
export interface ReloadablePlayer {
  /** The source loaded last (absolute). */
  readonly url: string | null;
  /** Where hls.js starts the source it loaded (for a live one, its live sync position); -1 before it knows. */
  readonly startPosition: number;
  loadSource(url: string): void;
  /** Detaches the media but keeps its MediaSource and SourceBuffers (hls.js ≥ 1.6), or null. */
  transferMedia(): KeptMedia | null;
  attachMedia(media: never): void;
  on(event: never, fn: never): void;
  off(event: never, fn: never): void;
  trigger(event: never, data: never): unknown;
}

export interface ReloadInPlaceOptions {
  /** The page's URL, to resolve the sources against. */
  base: string;
  events: { FRAG_BUFFERED: string; BUFFER_FLUSHING: string };
  audioUrl?: string;
}

/** A few ms at either edge of a range do not count. */
const EDGE_S = 0.01;

/** `r` holds media between `from` and `to`. */
const holds = (r: Ranges, from: number, to: number): boolean => {
  for (let i = 0; i < r.length; i++) if (r.start(i) < to - EDGE_S && r.end(i) > from + EDGE_S) return true;
  return false;
};

/** What `r` holds outside [start, end]. */
function outside(r: Ranges, start: number, end: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < r.length; i++) {
    const a = r.start(i);
    const z = r.end(i);
    if (a < start - EDGE_S) out.push([a, Math.min(z, start)]);
    if (z > end + EDGE_S) out.push([Math.max(a, end), z]);
  }
  return out;
}

/**
 * Reads the audio-only playlist again while audio only plays (a media playlist it listed went
 * away: the quality ladder's audio, once the ladder fell back to the original quality) and keeps
 * the element's MediaSource and its audio SourceBuffer: hls.js `transferMedia()` hands them over,
 * `loadSource()` reads the playlist again, `attachMedia()` takes them back. A plain
 * `hls.loadSource()` detaches the media and gives the element a new MediaSource, and Linux WebKit
 * (GStreamer) kills the page's process doing that for sound alone (SIGSEGV on the web process's
 * main thread, always at the same address in WebKit; about 1 audio-only reload in 300-900 on the
 * Linux CI runners, with or without a sound server, a bare hls.js page too; never for video):
 * the viewer's tab is gone.
 *
 * The playlist then starts afresh on that MediaSource, as on a new one: hls.js places a playlist
 * it reads anew from the first segment its live window lists now (at 0 on the element's
 * timeline), while what the element buffered and its playhead sit on the timeline of the read
 * before, which began where the window began then. Left as they were, the two lay apart by as
 * much as the window had moved on since: once a viewer's window had moved 32 s, the playhead
 * stood 28 s "ahead of live", the old buffer played out, the sound froze 2 s and hls.js jumped
 * back to its live sync position, playing 15 s of sound again (Chromium and WebKit alike; the
 * reload probe of soak run 41757062883 took that jump back, after 26 reloads in a row, for a
 * stop). So once the first segment of the new read is buffered, the playhead moves into it, to
 * where hls.js starts (hls.js itself only moves a playhead that is before its start position),
 * and, once that seek is over, what the buffer held besides that segment, all from the read
 * before, goes through hls.js's own flush (leaving out the segments of the new read buffered
 * meanwhile). Until then the old buffer plays on: emptied any earlier, the element waits with
 * nothing buffered, which the adaptive delay takes for a network stall and holds playback for,
 * and Linux WebKit then stayed paused for good about one time in two (soak run 41766158247).
 * Flushed while the seek still runs, Linux WebKit (GStreamer) then played about one time in
 * eight with no clock: the buffer ran through in a fraction of a second and every new segment
 * vanished as it came, so the sound stopped (main run 41828698597; logged probe 18 in 120,
 * against none in 120 with the flush after `seeked`, soak runs 41838099514, 41841700897).
 * A second append of the segment hls.js seeks into does the same, which is why the player
 * turns off hls.js's interstitials (player-config.ts hlsConfigFor), and why `play()` is sent
 * after the reload only to a paused element (player-config.ts playOnLoad).
 * Diagnosis: docs/QUALITY.md "Audio only".
 *
 * Returns false and does nothing unless the player has the audio-only playlist loaded, `url` is
 * that playlist and hls.js can hand the media over; the caller then loads the source as usual.
 */
export function reloadAudioOnlyInPlace(hls: ReloadablePlayer, url: string, o: ReloadInPlaceOptions): boolean {
  const path = (u: string | null): string => (u ? new URL(u, o.base).pathname : '');
  const target = path(o.audioUrl ?? AUDIO_ONLY_URL);
  if (path(hls.url) !== target || path(url) !== target) return false;
  const kept = hls.transferMedia();
  if (!kept) return false;
  const media = kept.media;
  const onBuffered = ((_e: unknown, data: { frag: { type: string; start: number; end: number } }) => {
    if (data.frag.type !== 'main') return;
    hls.off(o.events.FRAG_BUFFERED as never, onBuffered);
    const { start, end } = data.frag;
    if (!media.seeking && !(media.currentTime >= start && media.currentTime < end)) {
      const at = hls.startPosition;
      media.currentTime = at >= start && at < end ? at : start;
    }
    const old = outside(media.buffered, start, end);
    // The new read grows on from `end` while the seek runs; none of that is old.
    let newEnd = end;
    const grow = ((_e: unknown, d: { frag: { type: string; start: number; end: number } }) => {
      if (d.frag.type === 'main' && d.frag.start <= newEnd + EDGE_S) newEnd = Math.max(newEnd, d.frag.end);
    }) as never;
    const flushOld = (): void => {
      hls.off(o.events.FRAG_BUFFERED as never, grow);
      for (const [a, z] of old) {
        const from = a >= end - EDGE_S ? Math.max(a, newEnd) : a;
        if (z > from + EDGE_S && holds(media.buffered, from, z)) hls.trigger(o.events.BUFFER_FLUSHING as never, { startOffset: from, endOffset: z, type: null } as never);
      }
    };
    if (!media.seeking) {
      flushOld();
      return;
    }
    hls.on(o.events.FRAG_BUFFERED as never, grow);
    media.addEventListener('seeked', flushOld, { once: true });
  }) as never;
  hls.on(o.events.FRAG_BUFFERED as never, onBuffered);
  hls.loadSource(url);
  hls.attachMedia(kept as never);
  return true;
}

/**
 * Browsers whose media engine is GStreamer: WebKit on Linux (GNOME Web and the other WebKitGTK and
 * WPE browsers). WebKit by its user agent (AppleWebKit, not Chromium-based: those name AppleWebKit
 * too), Linux by `navigator.platform` or the user agent: a WebKit browser may send a macOS-like
 * user agent (Playwright's WebKit on Linux sends Desktop Safari's), never a macOS platform.
 */
export function usesGStreamer(userAgent: string, platform = ''): boolean {
  const webkit = /AppleWebKit\//.test(userAgent) && !/Chrome\/|Chromium\/|CriOS\/|Edg\/|Android/.test(userAgent);
  return webkit && (/^Linux/i.test(platform) || /\bLinux\b/.test(userAgent));
}

/** Seconds a sound-only start plays from the window start before it moves to live. */
export const WINDOW_START_PLAY_S = 0.25;

/** The part of hls.js a sound-only start at the window start uses. */
export interface WindowStartPlayer {
  config: { startPosition: number };
  /** Where hls.js would start or catch up to now; null before it knows. */
  readonly liveSyncPosition: number | null;
}

/** The part of the media element a sound-only start at the window start uses. */
export interface WindowStartMedia {
  readonly seeking: boolean;
  readonly paused: boolean;
  currentTime: number;
  addEventListener(type: 'timeupdate', fn: () => void): void;
  removeEventListener(type: 'timeupdate', fn: () => void): void;
}

export interface WindowStart {
  /**
   * Call before every load of the source on a new MediaSource (hls.js `loadSource`), with the URL
   * loaded: for the audio-only playlist on an engine that needs it, hls.js starts at the first
   * segment of the live window, and the playhead moves to the live sync position once playback
   * has run WINDOW_START_PLAY_S from there; any other load starts where hls.js picks (live).
   */
  beforeLoad(url: string): void;
  /** A start at the window start is waiting to move to live: hls.js must not move the playhead meanwhile (watch.ts fitLatency). */
  readonly active: boolean;
}

/**
 * Starts sound-only playback on a new MediaSource where its media begins, and seeks to live only
 * once it plays. Linux WebKit (GStreamer, `usesGStreamer`) kills the page's web process when a
 * new sound-only pipeline is sought before it has played anything: SIGSEGV on the main thread, at
 * the same WebKit address every time, 0.7-1 s after the seek. hls.js always seeks there on such a
 * start: the element starts at 0 and hls.js buffers the segment at its live sync position (about
 * 20 s on), then sets `currentTime` to it, right after the first append; WebKit flushes its
 * pipeline before the first sample went out, and the pipeline then drops its video sink and
 * builds its audio sink while the seek is pending (its GStreamer log ends there). About one
 * sound-only start in 100-150 (a page that starts on audio only) and one switch to audio only in
 * 500 on the Linux CI runners; never for video (0 of about 2,560 switches back), never on a kept
 * MediaSource (reloadAudioOnlyInPlace), never once the pipeline plays. Neither holding the
 * appends during that seek, nor seeking before the first append, nor an <audio> element, nor
 * hls.js without its first-fragment prefetch avoided it. Starting at the first segment of the
 * window needs no seek (the media begins where the element is), and the jump to live comes when
 * the pipeline already plays, as any Go live does. The cost there: a quarter of a second of the
 * oldest sound of the window, and its first segments. Elsewhere `enabled` is false and nothing
 * changes. Diagnosis: docs/QUALITY.md "Audio only".
 */
export function createWindowStart(hls: WindowStartPlayer, media: WindowStartMedia, o: { enabled: boolean; base: string; audioUrl?: string }): WindowStart {
  const target = new URL(o.audioUrl ?? AUDIO_ONLY_URL, o.base).pathname;
  let armed: (() => void) | null = null;
  // hls.js reads startPosition when it starts loading a source; any later load starts live again
  // unless beforeLoad says otherwise (reloadAudioOnlyInPlace places its read from hls.js's start).
  const disarm = (): void => {
    armed?.();
    armed = null;
    hls.config.startPosition = -1;
  };
  return {
    get active() {
      return armed !== null;
    },
    beforeLoad(url) {
      disarm();
      if (!o.enabled || new URL(url, o.base).pathname !== target) return;
      hls.config.startPosition = 0;
      let from: number | null = null;
      const onTime = (): void => {
        if (media.seeking || media.paused) return;
        if (from === null) {
          from = media.currentTime;
          return;
        }
        if (media.currentTime < from + WINDOW_START_PLAY_S) return;
        disarm();
        const live = hls.liveSyncPosition;
        if (live !== null && live > media.currentTime + 1) media.currentTime = live;
      };
      media.addEventListener('timeupdate', onTime);
      armed = () => media.removeEventListener('timeupdate', onTime);
    },
  };
}

/**
 * hls.js resets of the MediaSource (`mediaSourceRequiresReset`) within AUDIO_ONLY_BROKEN_WINDOW_MS
 * after which audio-only playback gives up for this page and the video comes back. A browser that
 * cannot output the sound plays video on the picture's clock, but sound alone not at all: Firefox
 * on a computer without an audio output (the Linux CI runners) fails the element with
 * MEDIA_ERR_DECODE "OnMediaSinkAudioError" as soon as it is unmuted; hls.js then reset the
 * MediaSource and loaded the whole audio playlist again, every 2 s, forever (34 MB in 8 s instead
 * of 0.1 MB, soak run 41330071767, diagnosis run 41333831170). One reset can be a one-off.
 */
export const AUDIO_ONLY_BROKEN_AFTER = 2;
export const AUDIO_ONLY_BROKEN_WINDOW_MS = 30_000;

type Listener = (on: boolean) => void;

/**
 * Whether the player plays the audio-only playlist right now. `subscribe` calls the listener at
 * once with the current value, then on every change; it returns the unsubscribe function.
 * A screen wake lock subscribes here: `audioOnlyState.subscribe((on) => awake.block('audio-only', on))`.
 */
export class AudioOnlyState {
  private value = false;
  private readonly listeners = new Set<Listener>();

  get on(): boolean {
    return this.value;
  }

  set(on: boolean): void {
    if (on === this.value) return;
    this.value = on;
    for (const fn of [...this.listeners]) fn(on);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.value);
    return () => void this.listeners.delete(fn);
  }
}

/** The page's one audio-only state (watch.ts wires the player into it). */
export const audioOnlyState = new AudioOnlyState();

/** The part of a parsed multivariant (hls.js MANIFEST_PARSED) the switch reads. */
export interface ParsedManifest {
  levels: ReadonlyArray<{ height?: number }>;
  audioTracks: readonly unknown[];
}

interface HlsLike {
  on(event: never, fn: never): void;
}

export interface AudioOnlySwitchOptions {
  hls: HlsLike;
  events: { MANIFEST_PARSED: string };
  /** The normal multivariant (ViewerConfig.playlistUrl). */
  videoUrl: string;
  audioUrl?: string;
  /** Loads `url` into the player (watch.ts reloadSource: it counts the reload and says why). */
  load(url: string, why: string): void;
  /** The saved choice (player-config.ts loadAudioOnly); the player starts on it. */
  saved: boolean;
  save(on: boolean): void;
  state?: AudioOnlyState;
  /** Audio only could not play on this device and the video came back (AUDIO_ONLY_BROKEN_AFTER): tell the viewer. */
  onBroken?(): void;
  now?: () => number;
}

export interface AudioOnlySwitch {
  /** The player plays (or is loading) the audio-only playlist. */
  readonly active: boolean;
  /**
   * The audio-only choice can be offered: the stream has a separate audio rendition (the last
   * normal playlists had an alternate audio track), or the player is on it already.
   */
  readonly available: boolean;
  /** Video heights of the last normal playlists, highest first (the menu offers them while audio only is on). */
  readonly heights: readonly number[];
  /** What to load now: every load and reload of the player uses it. */
  url(): string;
  /** Switch to audio only (true) or back to video (false), remembered for this browser. */
  set(on: boolean): void;
  /**
   * Feed every hls.js ERROR. A 404 on the audio-only playlist means the stream has no separate
   * audio (OBS sends it muxed, or none): the player goes back to video for this page (its next
   * reload loads index.m3u8), and the saved choice stays for the next stream. Repeated resets
   * of the MediaSource (AUDIO_ONLY_BROKEN_AFTER) mean this device cannot play the sound alone: the
   * video comes back at once, and audio only is not offered again on this page.
   */
  onError(details: string, httpCode?: number): void;
  subscribe(fn: () => void): () => void;
}

export function createAudioOnlySwitch(o: AudioOnlySwitchOptions): AudioOnlySwitch {
  const state = o.state ?? audioOnlyState;
  const audioUrl = o.audioUrl ?? AUDIO_ONLY_URL;
  const now = o.now ?? (() => Date.now());
  let hasAudio = false;
  let broken = false;
  let resets: number[] = [];
  let heights: number[] = [];
  const listeners = new Set<() => void>();
  const changed = (): void => {
    for (const fn of [...listeners]) fn();
  };
  state.set(o.saved);
  o.hls.on(o.events.MANIFEST_PARSED as never, ((_e: unknown, data: ParsedManifest) => {
    // Only the normal playlists say what the stream has; the audio-only one has a single level.
    if (state.on) return;
    hasAudio = data.audioTracks.length > 0;
    heights = [...new Set(data.levels.map((l) => l.height ?? 0).filter((h) => h > 0))].sort((a, b) => b - a);
    changed();
  }) as never);
  return {
    get active() {
      return state.on;
    },
    get available() {
      return state.on || (hasAudio && !broken);
    },
    get heights() {
      return heights;
    },
    url: () => (state.on ? audioUrl : o.videoUrl),
    set(on) {
      o.save(on);
      if (on === state.on) return;
      // Before the load: the new playlists register their P2P swarm with this value.
      state.set(on);
      changed();
      o.load(on ? audioUrl : o.videoUrl, on ? 'audio only' : 'video again');
    },
    onError(details, httpCode) {
      if (!state.on) return;
      if (details === 'mediaSourceRequiresReset') {
        const t = now();
        resets = [...resets.filter((at) => t - at < AUDIO_ONLY_BROKEN_WINDOW_MS), t];
        if (resets.length < AUDIO_ONLY_BROKEN_AFTER) return;
        resets = [];
        broken = true;
        state.set(false);
        changed();
        o.load(o.videoUrl, 'audio only cannot play here');
        o.onBroken?.();
        return;
      }
      if (httpCode !== 404 || details !== 'manifestLoadError') return;
      hasAudio = false;
      state.set(false);
      changed();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}

/** The streamer's name and picture for the poster (from "Your page"), null when not set. */
export interface PosterBrand {
  name?: string;
  /** Same-origin /brand/<sha>.<ext> URL. */
  avatar?: string;
}

/**
 * The streamer's name and picture from /api/brand, kept to well-formed fields by the branding
 * chunk's own sanitizer (the chunk the page loads anyway for "Your page"). Null when branding is
 * off or the request fails: the poster then shows "Audio only" alone.
 */
export async function fetchPosterBrand(f: typeof fetch = (input, init) => fetch(input, init)): Promise<PosterBrand | null> {
  try {
    const res = await f('/api/brand', { credentials: 'same-origin', cache: 'no-cache' });
    if (!res.ok) return null;
    const raw: unknown = await res.json();
    const { sanitizeBranding } = await import('./branding/brand.js');
    const b = sanitizeBranding(raw);
    if (!b) return null;
    return { ...(b.name ? { name: b.name } : {}), ...(b.avatar ? { avatar: b.avatar.s256 } : {}) };
  } catch {
    return null;
  }
}

export interface PosterLabels {
  title: string;
  hint: string;
}

/**
 * The "Audio only" poster over the video area, shown while audio only is on. It lets every click
 * through (pointer-events: none in the CSS), so the player's own controls (pause, volume) stay
 * usable. Text from the streamer only through textContent. Returns the element.
 */
export function mountAudioOnlyPoster(player: HTMLElement, o: { state?: AudioOnlyState; labels: PosterLabels; brand?: () => Promise<PosterBrand | null> }): HTMLElement {
  const state = o.state ?? audioOnlyState;
  const doc = player.ownerDocument;
  const root = doc.createElement('div');
  root.className = 'audio-only';
  root.dataset.testid = 'audio-only';
  root.hidden = true;
  const card = doc.createElement('div');
  card.className = 'audio-only-card';
  const picture = doc.createElement('span');
  picture.className = 'audio-only-picture';
  const icon = doc.createElement('span');
  icon.className = 'audio-only-icon sc-ico-volume';
  icon.setAttribute('aria-hidden', 'true');
  picture.append(icon);
  const name = doc.createElement('bdi');
  name.className = 'audio-only-name';
  name.setAttribute('dir', 'auto');
  name.dataset.testid = 'audio-only-name';
  name.hidden = true;
  const title = doc.createElement('strong');
  title.className = 'audio-only-title';
  title.textContent = o.labels.title;
  const hint = doc.createElement('span');
  hint.className = 'audio-only-hint';
  hint.textContent = o.labels.hint;
  card.append(picture, name, title, hint);
  root.append(card);
  // Under the status overlay ("Waiting for the stream…"), which stays on top when it shows.
  const overlay = player.querySelector('.overlay');
  if (overlay) overlay.before(root);
  else player.append(root);

  let ask = 0;
  const showBrand = (b: PosterBrand | null, mine: number): void => {
    name.textContent = b?.name ?? '';
    name.hidden = !b?.name;
    if (b?.avatar) {
      // In the poster once it has loaded: a picture that cannot load (the connection gone) leaves
      // the speaker icon, never a broken image.
      const img = doc.createElement('img');
      img.className = 'audio-only-avatar';
      img.alt = '';
      img.width = 128;
      img.height = 128;
      img.decoding = 'async';
      img.dataset.testid = 'audio-only-avatar';
      img.addEventListener('load', () => {
        if (mine === ask) picture.replaceChildren(img);
      });
      img.addEventListener('error', () => {
        if (mine === ask) picture.replaceChildren(icon);
      });
      img.src = b.avatar;
    } else {
      picture.replaceChildren(icon);
    }
  };
  state.subscribe((on) => {
    root.hidden = !on;
    player.classList.toggle('audio-only-on', on);
    if (!on || !o.brand) return;
    // Asked again each time it shows: the streamer may have changed "Your page" meanwhile.
    const mine = ++ask;
    void o.brand().then((b) => {
      if (mine === ask) showBrand(b, mine);
    });
  });
  return root;
}

/**
 * A short line over the player (role="status", read by screen readers) that goes away by itself:
 * why the video came back (AudioOnlySwitchOptions.onBroken).
 */
export function showPlayerNotice(player: HTMLElement, text: string, ms = 8000): HTMLElement {
  const doc = player.ownerDocument;
  let el = player.querySelector<HTMLElement>('.audio-only-notice');
  if (!el) {
    el = doc.createElement('p');
    el.className = 'audio-only-notice';
    el.setAttribute('role', 'status');
    el.dataset.testid = 'audio-only-notice';
    player.append(el);
  }
  el.textContent = text;
  el.hidden = false;
  const shown = el;
  setTimeout(() => {
    if (shown.textContent === text) shown.hidden = true;
  }, ms);
  return el;
}
