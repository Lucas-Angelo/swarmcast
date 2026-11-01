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

  const showBrand = (b: PosterBrand | null): void => {
    name.textContent = b?.name ?? '';
    name.hidden = !b?.name;
    if (b?.avatar) {
      const img = doc.createElement('img');
      img.className = 'audio-only-avatar';
      img.alt = '';
      img.width = 128;
      img.height = 128;
      img.decoding = 'async';
      img.src = b.avatar;
      img.dataset.testid = 'audio-only-avatar';
      picture.replaceChildren(img);
    } else {
      picture.replaceChildren(icon);
    }
  };
  let ask = 0;
  state.subscribe((on) => {
    root.hidden = !on;
    player.classList.toggle('audio-only-on', on);
    if (!on || !o.brand) return;
    // Asked again each time it shows: the streamer may have changed "Your page" meanwhile.
    const mine = ++ask;
    void o.brand().then((b) => {
      if (mine === ask) showBrand(b);
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
