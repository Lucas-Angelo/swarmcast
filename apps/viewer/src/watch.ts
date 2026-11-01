import './peer-guard-install.js';
import './style.css';
import { formatNumber, t, type MessageKey } from './i18n.js';
import Hls, { type ErrorData, type LevelDetails } from 'hls.js';
import { HlsJsP2PEngine } from 'p2p-media-loader-hlsjs';
import { debug as p2pDebug } from 'p2p-media-loader-core';
import { CONTROL_CLOSE, type P2PBlockReason, type ServerMessage, type ViewerConfig } from '@swarmcast/shared';
import { IntegrityVerifier } from './integrity.js';
import { attachAdaptiveDelay, delayTestFlags, type AdaptiveDelay } from './adaptive-delay.js';
import { createLatencyToggle } from './latency-toggle.js';
import { CoreActivity, PeerStrikes, withHttpFallback } from './p2p-fallback.js';
import { asciiToHex, peerGuard } from './peer-guard.js';
import {
  createManifestReloader,
  hlsConfigFor,
  latencyFor,
  loadAudioOnly,
  mismatchWindow,
  playlistsKnown,
  type applyProfile,
  loadProfile,
  p2pCoreConfigFor,
  type PlaybackProfileId,
  type PlaylistWindow,
  saveAudioOnly,
  saveEstimate,
  swarmIdBuilderFor,
  urgentSecondsFor,
} from './player-config.js';
import { AUDIO_ONLY_GONE_AFTER, audioOnlyState, createAudioOnlySwitch, fetchPosterBrand, mountAudioOnlyPoster, showPlayerNotice, type AudioOnlySwitch } from './audio-only.js';
import { installStallRecovery } from './stall-recovery.js';
import { createQualityMenu } from './quality-menu.js';
import { trackerMux } from './tracker-mux.js';
import { createChatRouter } from './chat/loader.js';
import { createScreenAwake, type WakeLockLike } from './wake-lock.js';
import { createMediaSession, imageAsDataUrl } from './media-session.js';
import { createShareControl, fetchShareLink } from './share.js';
import { installPlayerExtras } from './player-extras.js';
import { mountPlayerControls, type PlayerControls } from './player-controls.js';
import { exitFullscreen } from './player-caps.js';
import fallbackArtworkUrl from '../../../assets/brand/favicon/favicon-512.png?url';
// ---- branding: watch ----
import { createBrandRouter } from './branding/loader.js';
// ---- end branding: watch ----

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const video = $<HTMLVideoElement>('video');
const overlay = $<HTMLDivElement>('overlay');
const statusEl = $<HTMLSpanElement>('status');
const liveDot = $<HTMLSpanElement>('live-dot');
const p2pToggle = $<HTMLInputElement>('p2p');
const p2pStats = $<HTMLParagraphElement>('p2p-stats');
const p2pStatsRow = $<HTMLDivElement>('p2p-stats-row');
const p2pStatsTip = $<HTMLSpanElement>('p2p-stats-tip');
const unmute = $<HTMLButtonElement>('unmute');
const goLive = $<HTMLButtonElement>('golive');
const viewerCountWrap = $<HTMLSpanElement>('viewer-count-wrap');
const viewerCountEl = $<HTMLSpanElement>('viewer-count');
const playerControls = $<HTMLDivElement>('player-controls');
const delayWrap = $<HTMLSpanElement>('delay-wrap');
const delayEl = $<HTMLSpanElement>('delay');

let ended = false;
let adaptive: AdaptiveDelay | null = null;
/** The stream's first picture is there (set on loadeddata; "Go live" and the big Play button wait for it). */
let started = false;

// The player's own controls over the video (player-controls.ts): built first, so "LIVE / Go
// live" and "Theater mode" move into the bar before anything else uses them. Should building
// them fail, the video keeps the browser's own controls (the attribute stays in watch.html until
// they are built) and everything else works as before.
const controls = ((): PlayerControls | null => {
  try {
    return mountPlayerControls({
      player: video.parentElement!,
      video,
      doc: document,
      win: window,
      goLive,
      theater: $<HTMLButtonElement>('theater'),
      labels: {
        group: t('watch.controls'),
        play: t('watch.play'),
        pause: t('watch.pause'),
        mute: t('watch.mute'),
        unmute: t('watch.unmute'),
        volume: t('watch.volume'),
        volumeValue: (percent) => t('watch.volume.value', { percent }),
        fullscreen: t('watch.fullscreen'),
        exitFullscreen: t('watch.fullscreen.exit'),
        pip: t('watch.pip'),
        exitPip: t('watch.pip.exit'),
        withKey: (label, key) => t('watch.withKey', { label, key }),
      },
      isHeld: () => adaptive?.holding ?? false,
      started: () => started,
      ended: () => ended,
      onPlayRefused: () => {
        unmute.hidden = false;
      },
    });
  } catch (err) {
    console.error(err);
    return null;
  }
})();
// After the bar's own listener, so it reads the new value (the native-HLS path of main() too).
for (const ev of ['loadeddata', 'playing'] as const) {
  video.addEventListener(ev, () => {
    started = true;
    controls?.sync();
  });
}

// Chat: a separate, lazily loaded chunk (chat/loader.ts); the player never depends on it.
const chat = createChatRouter({
  root: $<HTMLElement>('chat'),
  showButton: $<HTMLButtonElement>('chat-show'),
  nickname: () => $('nick').textContent ?? '',
  send: (msg) => sendControl(msg),
  debug: (msg) => debugLog(msg),
});

// Keep the screen on while the stream plays (wake-lock.ts), but not while only the sound plays
// (audio-only.ts): no screen is needed then, and letting it sleep saves the battery.
const awake = createScreenAwake({
  wakeLock: 'wakeLock' in navigator ? (navigator.wakeLock as WakeLockLike) : undefined,
  doc: document,
  debug: (msg) => debugLog(msg),
});
audioOnlyState.subscribe((on) => awake.block('audio-only', on));

// Lock-screen and notification controls (media-session.ts): play / pause, the streamer's name and picture.
const media = createMediaSession({
  mediaSession: 'mediaSession' in navigator ? navigator.mediaSession : undefined,
  Metadata: typeof MediaMetadata === 'function' ? MediaMetadata : undefined,
  player: {
    play: () => void video.play().catch(() => {}),
    pause: () => video.pause(),
  },
  labels: { title: t('watch.live'), artist: t('watch.media.artist') },
  fallbackArtwork: { src: fallbackArtworkUrl, sizes: '512x512', type: 'image/png' },
  toDataUrl: (url) => imageAsDataUrl(url),
});

/** The streamer's name from "Your page", once known (lock screen, share sheet). */
let brandName: string | undefined;

// The Share button (share.ts): shown once the server says this viewer may share and the link is in hand.
const share = createShareControl({
  button: $<HTMLButtonElement>('share'),
  status: $<HTMLSpanElement>('share-status'),
  fallback: $<HTMLDivElement>('share-fallback'),
  field: $<HTMLInputElement>('share-field'),
  nav: navigator,
  fetchLink: () => fetchShareLink(),
  title: () => (brandName ? t('brand.viewer.titleLive', { name: brandName }) : t('watch.pageTitle')),
  labels: { copied: t('watch.share.copied') },
});

// ---- branding: watch ----
// The streamer's page (name, picture, about, support): its own chunk, the player never waits for it.
const brand = createBrandRouter(
  'watch',
  (msg) => debugLog(msg),
  (b) => {
    brandName = b?.name;
    void media.setBrand(b ? { ...(b.name ? { name: b.name } : {}), ...(b.avatar ? { avatar: b.avatar.s256 } : {}) } : null);
  },
);
// ---- end branding: watch ----

// Playing or not, for the screen lock and the lock-screen controls. A short hold inside a stall
// (adaptive delay) pauses the video but is not a viewer pause: the screen stays on.
video.addEventListener('playing', () => {
  awake.setPlaying(true);
  media.setPlaying(true);
});
for (const ev of ['pause', 'ended'] as const) {
  video.addEventListener(ev, () => {
    const held = ev === 'pause' && (adaptive?.holding ?? false);
    awake.setPlaying(held);
    media.setPlaying(held);
  });
}

let tipSeq = 0;
/** An (i) tooltip like the static ones in watch.html (installTooltips() handles it). */
function tip(text: string): HTMLSpanElement {
  const id = `tip-dyn-${++tipSeq}`;
  const wrap = document.createElement('span');
  wrap.className = 'tip';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tip-btn';
  btn.textContent = 'i';
  btn.setAttribute('aria-label', t('tip.more'));
  btn.setAttribute('aria-describedby', id);
  const bubble = document.createElement('span');
  bubble.className = 'tip-bubble';
  bubble.setAttribute('role', 'tooltip');
  bubble.id = id;
  bubble.textContent = text;
  wrap.append(btn, bubble);
  return wrap;
}

/**
 * The quality menu (Auto/1080p/720p/480p/360p/Audio only) in the player's control bar, and the
 * Stable / Lower-delay switch under the player, with its tooltip.
 */
function mountSettings(hls: InstanceType<typeof Hls>, engine: Parameters<typeof applyProfile>[1], window: () => PlaylistWindow | null, onProfile: (id: PlaybackProfileId) => void, source: AudioOnlySwitch): void {
  // Without the bar (it failed to build), the menu sits in the settings card as before.
  const qualityHost = controls?.qualitySlot ?? playerControls.appendChild(Object.assign(document.createElement('div'), { className: 'control-group quality-group' }));
  createQualityMenu(
    hls,
    qualityHost,
    Hls.Events,
    {
      auto: t('watch.quality.auto'),
      autoWith: (label) => t('watch.quality.autoWith', { label }),
      title: t('watch.quality.title'),
      audioOnly: t('watch.quality.audioOnly'),
      hint: t('watch.quality.tip'),
    },
    source,
    { onOpenChange: (open) => controls?.menuOpen(open) },
  );

  const latencyGroup = document.createElement('div');
  latencyGroup.className = 'control-group latency-group';
  playerControls.appendChild(latencyGroup);
  const toggle = createLatencyToggle(
    latencyGroup,
    { hls, engine },
    { isMobile, window },
    {
      stable: t('watch.latency.stable'),
      lowDelay: t('watch.latency.lowDelay'),
      title: t('watch.latency.title'),
      hint: { stable: t('watch.latency.hint.stable'), 'low-delay': t('watch.latency.hint.lowDelay') },
    },
    onProfile,
  );
  toggle.element.querySelector('legend')?.after(tip(t('watch.latency.tip')));
}

/** "12 watching" (eye icon from CSS) next to the status; hidden when the streamer hides the count (null). */
function showViewerCount(count: number | null | undefined): void {
  const show = typeof count === 'number' && count >= 0 && !ended;
  viewerCountWrap.hidden = !show;
  if (show) {
    viewerCountEl.textContent = t('watch.viewers', { count });
    viewerCountEl.dataset.count = String(count);
  }
}

/** The viewer's own P2P choice: off unless they turned it on (opt-in; a saved "on" is kept). */
const P2P_PREF_KEY = 'swarmcast.p2p';
function p2pWanted(): boolean {
  try {
    return localStorage.getItem(P2P_PREF_KEY) === 'on';
  } catch {
    return false;
  }
}
function rememberP2P(on: boolean): void {
  try {
    localStorage.setItem(P2P_PREF_KEY, on ? 'on' : 'off');
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
}

/** One line under the toggle: P2P stats (with their tooltip) or a notice. */
function showP2PLine(text: string | null, isStats = false): void {
  p2pStatsRow.hidden = text === null;
  p2pStatsTip.hidden = !isStats;
  if (text !== null) p2pStats.textContent = text;
}

/** Test/diagnostics only: `?debug=1` (or localStorage sc.debug=1) turns on hls.js and P2P logs. */
const debugMode = ((): boolean => {
  try {
    return new URLSearchParams(location.search).get('debug') === '1' || localStorage.getItem('sc.debug') === '1';
  } catch {
    return false;
  }
})();
if (debugMode) p2pDebug.enable('p2pml-core:hybrid-loader*,p2pml-core:request*,p2pml-core:p2p-loader*');
const debugLog = (msg: string): void => {
  if (debugMode) console.warn(`[swarmcast] ${msg}`);
};

const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform));

/** Live counters (also exposed read-only on window for diagnostics and tests). */
const stats = {
  httpBytes: 0,
  p2pDownBytes: 0,
  p2pUpBytes: 0,
  http429: 0,
  peers: new Set<string>(),
  hashFailures: 0,
  /** Fragments the P2P core held too long and that were fetched over HTTPS instead. */
  httpFallbacks: 0,
  /** Peers dropped locally because they did not deliver. */
  peersDropped: 0,
  stallRecoveries: 0,
  /** Source reloads (hls.loadSource after the first), and why the last one happened. */
  reloads: 0,
  lastReload: null as string | null,
  p2pEnabled: false,
  p2pAllowed: true,
  /** The streamer's switch for everyone (false = P2P off for this live). */
  p2pForAll: true,
  /** Why P2P is off although the streamer allows it (the streamer's own connection, or a check in progress). */
  p2pBlock: null as P2PBlockReason | null,
  playing: false,
};
(window as unknown as { __swarmcast: unknown }).__swarmcast = {
  get stats() {
    return { ...stats, peers: [...stats.peers] };
  },
  /** Adaptive delay controller state (adaptive-delay.ts). */
  get delay() {
    return adaptive?.snapshot() ?? null;
  },
  /** Tracker channels open inside /control (tracker-mux.ts). */
  get trackerChannels() {
    return trackerMux.openCount;
  },
  /** Screen wake lock: 'held' while playing where the browser has the API (wake-lock.ts). */
  get wakeLock() {
    return awake.state;
  },
};

let control: WebSocket | null = null;

// Theater mode, keyboard shortcuts and "stats for nerds" (player-extras.ts; the stats panel is a
// chunk of its own, loaded only when opened). hls.js is there once main() has made it.
let playerHls: InstanceType<typeof Hls> | null = null;
installPlayerExtras({
  doc: document,
  video,
  player: video.parentElement!,
  goLive,
  unmute,
  chatRoot: $<HTMLElement>('chat'),
  storage: (() => {
    try {
      return localStorage;
    } catch {
      return undefined;
    }
  })(),
  stats: {
    video,
    hls: () => playerHls,
    counters: () => ({ httpBytes: stats.httpBytes, p2pDownBytes: stats.p2pDownBytes, p2pUpBytes: stats.p2pUpBytes, peers: stats.peers.size, p2pEnabled: stats.p2pEnabled }),
    delay: () => (adaptive ? { delay: adaptive.delay, target: adaptive.target } : null),
    profile: () => loadProfile(),
    engine: () => (!playerHls ? 'native' : 'ManagedMediaSource' in window && playerHls.config.preferManagedMediaSource !== false ? 'mms' : 'mse'),
    connection: () => (navigator as Navigator & { connection?: { effectiveType?: string; type?: string; downlink?: number } }).connection,
  },
  clipboard: navigator.clipboard,
  debug: (msg) => debugLog(msg),
  onAction: () => controls?.reveal(),
});

// The "Unmute" button goes once the sound is on, whichever control turned it on, and comes back
// when the viewer mutes again (as after the muted autoplay).
video.addEventListener('volumechange', () => {
  if (started && !ended) unmute.hidden = !video.muted;
});

/** "~14 s behind live" next to the status while playing (the delay adapts to the connection). */
function showDelay(): void {
  const d = adaptive?.delay ?? null;
  const show = d !== null && stats.playing && !ended;
  delayWrap.hidden = !show;
  if (show) delayEl.textContent = t('watch.delay', { count: Math.max(1, Math.round(d)) });
  controls?.setDelay(show ? delayEl.textContent : null);
}

function setStatus(key: MessageKey, live = false): void {
  statusEl.textContent = t(key);
  liveDot.classList.toggle('live', live);
  // Dot colour: live (red), waiting for video (honey) or paused (muted).
  liveDot.dataset.state = live ? 'live' : key === 'watch.paused' ? 'off' : 'wait';
}

function showOverlay(key: MessageKey | null): void {
  overlay.hidden = key === null;
  if (key) overlay.textContent = t(key);
}

function endScreen(titleKey: MessageKey, textKey: MessageKey): void {
  ended = true;
  $('ended-title').textContent = t(titleKey);
  $('ended-text').textContent = t(textKey);
  $('ended').hidden = false;
  brand.ended();
  awake.block('ended', true);
  media.setPlaying(false);
  void share.setAllowed(false);
  goLive.hidden = true;
  viewerCountWrap.hidden = true;
  // The end card is outside the player: a full-screen player would hide it.
  exitFullscreen(video, document);
  try {
    video.pause();
  } catch {
    /* ignore */
  }
  controls?.sync();
}

async function loadConfig(): Promise<ViewerConfig | null> {
  const res = await fetch('/api/config', { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) return null;
  return (await res.json()) as ViewerConfig;
}

async function main(): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg) {
    endScreen('invalid.title', 'viewer.err.linkInvalid');
    return;
  }
  $('nick').textContent = cfg.nickname;
  stats.p2pAllowed = cfg.p2pAllowed;
  stats.p2pBlock = cfg.p2pBlock ?? null;
  // p2p-media-loader's tracker socket becomes a channel inside /control (tracker-mux.ts).
  trackerMux.trackerUrl = cfg.trackerUrl;

  const verifier = new IntegrityVerifier(cfg.manifestUrl, cfg.manifestPublicKey);
  await verifier.init();

  if (!Hls.isSupported()) {
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Very old iOS without (Managed)MediaSource: native HLS over HTTPS, no P2P.
      video.src = cfg.playlistUrl;
      p2pToggle.disabled = true;
      p2pToggle.checked = false;
      showP2PLine(t('watch.p2pUnavailable'));
      connectControl(cfg, null);
      setupGoLive(null, cfg.segmentDurationS);
      void video.play().catch(() => {});
      return;
    }
    endScreen('watch.unsupported.title', 'watch.unsupported.text');
    return;
  }

  // ManagedMediaSource (iOS 17.1+) needs remote playback disabled; harmless elsewhere.
  video.disableRemotePlayback = true;

  const HlsWithP2P = HlsJsP2PEngine.injectMixin(Hls);
  // P2P is off by default (opt-in); a viewer who turned it on keeps it on; the streamer can forbid it.
  stats.p2pEnabled = p2pWanted() && stats.p2pAllowed;
  // Playback profile (docs/QUALITY.md): "stable" (~20 s behind live, the default) or
  // "low-delay" (~8 s). Segments further than highDemandTimeWindow from the playhead can come
  // from peers (one random peer fetches each new segment over HTTPS and shares it); closer
  // ones are fetched over HTTPS directly. Latency buys P2P share.
  const profile = loadProfile();
  const hls = new HlsWithP2P({
    ...hlsConfigFor(profile, { isMobile }),
    debug: debugMode,
    p2p: {
      core: {
        swarmId: cfg.swarmId,
        // One swarm per quality (height), predictable so the server can allowlist exactly
        // these infohashes. Must match apps/server/src/tracker/tracker.ts. Audio only shares
        // the video viewers' audio swarm (player-config.ts swarmIdBuilderFor).
        streamSwarmIdBuilder: swarmIdBuilderFor(() => audioOnlyState.on),
        announceTrackers: [cfg.trackerUrl],
        rtcConfig: { iceServers: cfg.stunServers.map((urls) => ({ urls })) },
        isP2PDisabled: !stats.p2pEnabled,
        validateP2PSegment: (url, byteRange, data) => verifier.check(url, byteRange, data),
        segmentMemoryStorageLimit: isMobile ? 48 : 192,
        p2pMaxPeers: isMobile ? 6 : 15,
        simultaneousP2PDownloads: isMobile ? 2 : 3,
        ...p2pCoreConfigFor(profile),
      },
    },
  });

  const engine = hls.p2pEngine;

  // How much the playlists in use (video AND audio: the audio one can be shorter) still offer.
  const liveDetails = (): { video?: LevelDetails; audio?: LevelDetails } => {
    const v = hls.levels[hls.currentLevel >= 0 ? hls.currentLevel : hls.loadLevel]?.details;
    const a = hls.audioTracks[hls.audioTrack]?.details;
    return { ...(v?.live ? { video: v } : {}), ...(a?.live ? { audio: a } : {}) };
  };
  const playlistWindow = (): PlaylistWindow | null => {
    const { video, audio } = liveDetails();
    return mismatchWindow(video, audio);
  };
  // The shortest playlist in use, mismatch or not (short at stream start, or a server keeping
  // fewer segments): the adaptive delay must stay inside it.
  const shortestWindow = (): PlaylistWindow | null => {
    const d = Object.values(liveDetails());
    return d.length === 0 ? null : { windowS: Math.min(...d.map((x) => x.totalduration)), targetDurationS: Math.max(...d.map((x) => x.targetduration)) };
  };
  const windowStart = (): number | null => {
    const d = Object.values(liveDetails());
    return d.length === 0 ? null : Math.max(...d.map((x) => x.fragmentStart));
  };
  // Keep the live delay inside that window (player-config.ts latencyFor). The adaptive delay
  // (adaptive-delay.ts) owns liveSyncDuration; the window only caps it (setCeiling).
  // While the viewer has paused, hls.js must not move the playhead: its catch-up jump
  // (liveMaxLatencyDuration) would drag a paused viewer to live and "Go live −N s" would read 0.
  // Playing again restores the limit, so a viewer who paused past the window is brought back.
  // A short hold inside a stall (adaptive delay) is not a viewer pause.
  // While the playlists in use are (re)loading (a source reload: hls.js forgets them and loads
  // the video one first), the windows measured before still hold: the stream did not change.
  // Dropping them let a target raised by a long stall (27 s) place the restart before the
  // oldest audio segment of a 20 s audio playlist; video and audio then started 14 s apart and
  // the player sat frozen until the stall watchdog moved it again.
  let lastWindow: PlaylistWindow | null = null;
  let lastShortest: PlaylistWindow | null = null;
  const fitLatency = (): void => {
    const known = playlistsKnown(hls.audioTracks.length > 0, liveDetails());
    if (known) {
      lastWindow = playlistWindow();
      lastShortest = shortestWindow();
    }
    const w = lastWindow;
    const fit = latencyFor(loadProfile(), w);
    const max = video.paused && !video.ended && !adaptive?.holding ? Infinity : fit.liveMaxLatencyDuration;
    // The latencyFor rule (target ≤ min(max, window − 2 TD) − 2 TD): a playlist mismatch caps
    // the target itself; the shortest window only stops the controller building delay past it.
    const room = (x: PlaylistWindow | null): number | null => (x ? Math.max(2 * x.targetDurationS, Math.floor(latencyFor(loadProfile(), x).liveMaxLatencyDuration - 2 * x.targetDurationS)) : null);
    adaptive?.setCeiling(room(w));
    adaptive?.setGrowthLimit(room(lastShortest));
    if (hls.config.liveMaxLatencyDuration !== max) {
      debugLog(`live delay max ${max}s for window ${JSON.stringify(w)}`);
      hls.config.liveMaxLatencyDuration = max;
    }
    if (!adaptive && hls.config.liveSyncDuration !== fit.liveSyncDuration) hls.config.liveSyncDuration = fit.liveSyncDuration;
  };
  hls.on(Hls.Events.LEVEL_UPDATED, fitLatency);
  hls.on(Hls.Events.AUDIO_TRACK_LOADED, fitLatency);
  video.addEventListener('pause', fitLatency);
  video.addEventListener('play', fitLatency);

  // P2P must never starve playback: a fragment needed soon that the P2P core still holds is
  // fetched over HTTPS (p2p-fallback.ts), and peers that keep failing are dropped.
  const activity = new CoreActivity();
  activity.attach(engine);
  const strikes = new PeerStrikes();
  const strikePeer = (peerId: string | undefined, why: string): void => {
    if (!peerId || !strikes.strike(peerId)) return;
    stats.peersDropped += 1;
    debugLog(`dropping peer ${peerId} (${why})`);
    peerGuard.drop(asciiToHex(peerId), 120_000);
  };
  // Only peers that stop delivering count here. A peer that sends altered data is reported to
  // the server (onPeerError below), which removes it from P2P for everyone after a few reports;
  // dropping it locally first would hide it from that check.
  engine.addEventListener('onSegmentError', (d) => {
    if (d.downloadSource === 'p2p' && d.error.type === 'bytes-receiving-timeout') strikePeer(d.peerId, d.error.type);
  });
  const p2pLoader = hls.config.fLoader;
  if (p2pLoader) {
    hls.config.fLoader = withHttpFallback(p2pLoader, {
      media: () => hls.media,
      urgentS: () => urgentSecondsFor(loadProfile()),
      activity,
      onFallback: ({ url, type, reason, waitedMs, attempt }) => {
        stats.httpFallbacks += 1;
        debugLog(`HTTP fallback (${reason}, ${type}, waited ${Math.round(waitedMs)} ms, core: ${attempt?.source ?? 'idle'}) ${url.split('/').pop()}`);
        if (attempt?.source === 'p2p') strikePeer(attempt.peerId, 'too slow');
      },
      onFallbackLoaded: (bytes) => {
        stats.httpBytes += bytes;
      },
    });
  }
  engine.addEventListener('onChunkDownloaded', (bytes, source) => {
    if (source === 'p2p') stats.p2pDownBytes += bytes;
    else stats.httpBytes += bytes;
  });
  engine.addEventListener('onChunkUploaded', (bytes) => {
    stats.p2pUpBytes += bytes;
  });
  engine.addEventListener('onPeerConnect', (p) => {
    stats.peers.add(p.peerId);
    if (peerGuard.isBlocked(asciiToHex(p.peerId))) peerGuard.closePeer(asciiToHex(p.peerId));
  });
  engine.addEventListener('onPeerClose', (p) => {
    stats.peers.delete(p.peerId);
  });
  engine.addEventListener('onPeerError', (p) => {
    if (p.error.type === 'validation-failed') {
      stats.hashFailures += 1;
      sendControl({ t: 'hash-fail', peerId: asciiToHex(p.peerId), segment: 'p2p' });
    }
  });

  // Each viewer's delay adapts to their connection (latency-controller.ts, docs/QUALITY.md).
  adaptive = attachAdaptiveDelay(hls, engine, video, { profile, events: Hls.Events, p2pEnabled: () => stats.p2pEnabled, ...delayTestFlags(location.search, cfg.testHooks === true) });
  fitLatency();
  // "Audio only" (audio-only.ts): every load of the source below asks it which playlist to load.
  const source = createAudioOnlySwitch({
    hls,
    events: Hls.Events,
    videoUrl: cfg.playlistUrl,
    saved: loadAudioOnly(),
    save: saveAudioOnly,
    load: (_url, why) => reloadSource(why),
    onBroken: () => showPlayerNotice(video.parentElement!, t('watch.audioOnly.failed')),
  });
  mountAudioOnlyPoster(video.parentElement!, { labels: { title: t('watch.audioOnly.title'), hint: t('watch.audioOnly.hint') }, brand: () => fetchPosterBrand() });
  mountSettings(hls, engine, playlistWindow, (id) => adaptive?.setProfile(id), source);
  setInterval(showDelay, 1000);
  window.addEventListener('pagehide', () => saveEstimate(hls));

  // Every load of the source after the first goes through here, so the stats count it.
  const reloadSource = (why: string): void => {
    stats.reloads += 1;
    stats.lastReload = why;
    debugLog(`reloading the source (${why})`);
    hls.loadSource(source.url());
  };
  // The set of qualities can change when OBS reconnects (quality options turned on or off,
  // or ffmpeg fell back to the original quality): a media playlist the player knows may be
  // gone for good. Repeated 404s on media playlists re-read the multivariant playlist.
  const reloader = createManifestReloader(() => reloadSource('media playlists gone'), () => (source.active ? AUDIO_ONLY_GONE_AFTER : 3));
  hls.on(Hls.Events.LEVEL_LOADED, () => reloader.reset());

  let networkErrors = 0;
  hls.on(Hls.Events.ERROR, (_ev, data: ErrorData) => {
    const code = (data.response as { code?: number } | undefined)?.code;
    reloader.onError(data.details, code);
    source.onError(data.details, code);
    if (code === 429) stats.http429 += 1;
    if (code === 401 || code === 403) {
      void loadConfig().then((c) => {
        if (!c && !ended) endScreen('watch.disconnected.title', 'viewer.err.linkInvalid');
      });
    }
    if (!data.fatal) return;
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      networkErrors += 1;
      showOverlay(code === 429 ? 'watch.lotsOfViewers' : 'watch.waiting');
      // A failed manifest/playlist load (stream not started yet, OBS reconnecting) cannot be
      // resumed with startLoad(); load the source again instead.
      const reload =
        hls.levels.length === 0 ||
        data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR ||
        data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT ||
        data.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR ||
        data.details === Hls.ErrorDetails.LEVEL_LOAD_ERROR;
      setTimeout(() => (reload ? reloadSource(`network error: ${data.details}`) : hls.startLoad()), Math.min(10_000, 1000 * networkErrors));
    } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      hls.recoverMediaError();
    } else {
      showOverlay('watch.playbackError');
      setTimeout(() => location.reload(), 3000);
    }
  });
  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    networkErrors = 0;
    void video.play().catch(() => {
      unmute.hidden = false;
    });
  });
  hls.on(Hls.Events.FRAG_BUFFERED, () => {
    networkErrors = 0;
    brand.firstFrame(); // ---- branding: the banner loads after the first fragment ----
  });

  video.addEventListener('playing', () => {
    stats.playing = true;
    showOverlay(null);
    setStatus('watch.live', true);
    unmute.hidden = !video.muted;
  });
  // The first picture is there: the stream has started even if the viewer paused before it
  // began to play (or autoplay was blocked), so "Go live" and the picture are shown.
  video.addEventListener('loadeddata', () => {
    stats.playing = true;
    showOverlay(null);
  });
  video.addEventListener('waiting', () => setStatus('watch.buffering'));
  video.addEventListener('pause', () => {
    if (!ended && !adaptive?.holding) setStatus('watch.paused');
  });
  unmute.addEventListener('click', () => {
    video.muted = false;
    void video.play();
    unmute.hidden = true;
  });

  const setP2P = (on: boolean): void => {
    stats.p2pEnabled = on && stats.p2pAllowed;
    engine.applyDynamicConfig({
      core: {
        isP2PDisabled: !stats.p2pEnabled,
        mainStream: { isP2PDisabled: !stats.p2pEnabled },
        secondaryStream: { isP2PDisabled: !stats.p2pEnabled },
      },
    });
    if (!stats.p2pEnabled) peerGuard.closeAll();
    updateP2PUi();
  };
  p2pToggle.addEventListener('change', () => {
    rememberP2P(p2pToggle.checked);
    setP2P(p2pToggle.checked);
  });

  const renderP2PLine = (): void => {
    if (!stats.p2pAllowed) {
      showP2PLine(t(p2pOffKey()));
    } else if (stats.p2pEnabled) {
      const total = stats.httpBytes + stats.p2pDownBytes;
      const share = total > 0 ? Math.round((stats.p2pDownBytes / total) * 100) : 0;
      const peers = t('watch.peers', { count: stats.peers.size });
      showP2PLine(t('watch.p2pStats', { peers, share, mb: formatNumber(Math.round(stats.p2pUpBytes / 1e5) / 10) }), true);
    } else {
      showP2PLine(null);
    }
  };

  function updateP2PUi(): void {
    p2pToggle.checked = stats.p2pEnabled;
    p2pToggle.disabled = !stats.p2pAllowed;
    renderP2PLine();
  }
  updateP2PUi();
  setInterval(renderP2PLine, 2000);

  connectControl(cfg, {
    onP2P: (allowed, forAll, reason) => {
      stats.p2pAllowed = allowed;
      stats.p2pForAll = forAll ?? true;
      stats.p2pBlock = reason ?? null;
      if (!allowed) setP2P(false);
      else if (!stats.p2pEnabled && p2pWanted()) setP2P(true);
      updateP2PUi();
    },
  });
  setupGoLive(hls, cfg.segmentDurationS);

  // Keep the session cookie fresh even when playback is paused.
  setInterval(() => {
    void fetch('/api/session/refresh', { method: 'POST', credentials: 'same-origin' }).then((r) => {
      if (r.status === 401 && !ended) endScreen('watch.disconnected.title', 'viewer.err.linkInvalid');
    });
  }, 4 * 60_000);

  showOverlay('watch.waiting');
  setStatus('watch.connecting');
  hls.loadSource(source.url());
  hls.attachMedia(video);
  (window as unknown as { __hls: unknown }).__hls = hls;
  playerHls = hls;

  // If playback stays stuck anyway, restart loading where every track has data (stall-recovery.ts).
  installStallRecovery({
    video,
    hls,
    windowStart,
    isEnded: () => ended,
    // The adaptive delay's deliberate hold inside a stall is not a stuck player.
    isHeld: () => adaptive?.holding ?? false,
    reload: () => reloadSource('stall watchdog'),
    log: (msg) => {
      stats.stallRecoveries += 1;
      debugLog(msg);
    },
  });
}

function sendControl(msg: unknown): boolean {
  if (control?.readyState !== WebSocket.OPEN) return false;
  control.send(JSON.stringify(msg));
  return true;
}

/** The line under the P2P switch while P2P is not allowed: who turned it off, and why. */
function p2pOffKey(): MessageKey {
  if (!stats.p2pForAll) return 'watch.p2pOffForAll';
  if (stats.p2pBlock === 'own-connection') return 'watch.p2pOwnConnection';
  if (stats.p2pBlock === 'checking') return 'watch.p2pChecking';
  return 'watch.p2pRevoked';
}

function connectControl(cfg: ViewerConfig, handlers: { onP2P: (allowed: boolean, forAll?: boolean, reason?: P2PBlockReason) => void } | null): void {
  let attempts = 0;
  const open = (): void => {
    if (ended) return;
    const ws = new WebSocket(chat.controlUrl(cfg.controlUrl));
    control = ws;
    ws.onopen = () => {
      attempts = 0;
      trackerMux.attach(ws);
      chat.connection(true);
    };
    ws.onmessage = (ev) => {
      const text = String(ev.data);
      if (trackerMux.onFrame(text)) return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(text) as ServerMessage;
      } catch {
        return;
      }
      if (chat.frame(msg)) return;
      switch (msg.t) {
        case 'hello':
          chat.hello(msg.chat);
          brand.rev(msg.brandRev);
          void share.setAllowed(msg.shareAllowed === true);
          showViewerCount(msg.viewerCount);
          peerGuard.block(msg.blockedPeers);
          handlers?.onP2P(msg.p2pAllowed, msg.p2pForAll, msg.p2pBlock);
          break;
        case 'p2p':
          handlers?.onP2P(msg.allowed, msg.forAll, msg.reason);
          break;
        case 'viewers':
          showViewerCount(msg.count);
          break;
        case 'share':
          void share.setAllowed(msg.allowed);
          break;
        case 'block-peers':
          peerGuard.block(msg.peerIds);
          break;
        case 'unblock-peers':
          peerGuard.unblock(msg.peerIds);
          break;
        case 'kicked':
          endScreen('watch.removed.title', 'watch.removed.text');
          (window as unknown as { __hls?: { destroy(): void } }).__hls?.destroy();
          break;
        case 'ended':
          endScreen('watch.ended.title', 'watch.ended.text');
          (window as unknown as { __hls?: { destroy(): void } }).__hls?.destroy();
          break;
        case 'ping':
          sendControl({ t: 'pong' });
          break;
        // ---- branding: control ----
        case 'branding':
          brand.rev(msg.rev);
          break;
        // ---- end branding: control ----
      }
    };
    ws.onclose = (ev) => {
      control = null;
      trackerMux.detach(ws);
      chat.connection(false);
      if (ended) return;
      if (ev.code === CONTROL_CLOSE.kicked) {
        endScreen('watch.removed.title', 'watch.removed.text');
        return;
      }
      if (ev.code === CONTROL_CLOSE.ended) {
        endScreen('watch.ended.title', 'watch.ended.text');
        return;
      }
      attempts += 1;
      setTimeout(async () => {
        // If our session is gone (disconnected by the streamer / link changed), stop here.
        const still = await loadConfig().catch(() => null);
        if (!still) {
          endScreen('watch.disconnected.title', 'viewer.err.linkInvalid');
          (window as unknown as { __hls?: { destroy(): void } }).__hls?.destroy();
          return;
        }
        open();
      }, Math.min(15_000, 1000 * 2 ** Math.min(attempts, 4)));
    };
  };
  open();
  setInterval(() => {
    sendControl({
      t: 'stats',
      p2pEnabled: stats.p2pEnabled,
      httpBytes: Math.round(stats.httpBytes),
      p2pDownBytes: Math.round(stats.p2pDownBytes),
      p2pUpBytes: Math.round(stats.p2pUpBytes),
      peers: stats.peers.size,
      http429: stats.http429,
      device: isMobile ? 'mobile' : 'desktop',
      ...(adaptive?.delay ? { delayS: Math.round(adaptive.delay) } : {}),
    });
  }, 5000);
}

/**
 * "LIVE" badge while at the live edge; "Go live" (with how far behind) after pausing or
 * buffering. Clicking/tapping seeks to hls.js' live sync position (or near the end of the
 * seekable range) and plays.
 */
function setupGoLive(hls: { liveSyncPosition: number | null; latency: number } | null, segmentDurationS: number): void {
  const behindThresholdS = Math.max(4, segmentDurationS * 2);
  const liveTarget = (): number | null => {
    const sync = hls?.liveSyncPosition;
    if (typeof sync === 'number' && Number.isFinite(sync)) return sync;
    const r = video.seekable;
    if (r.length > 0) return Math.max(r.start(r.length - 1), r.end(r.length - 1) - segmentDurationS * 3);
    return null;
  };
  const latency = (): number | null => {
    if (hls && Number.isFinite(hls.latency) && hls.latency > 0) return hls.latency;
    const r = video.seekable;
    return r.length > 0 ? Math.max(0, r.end(r.length - 1) - video.currentTime) : null;
  };
  const seconds = (s: number): string => t('time.secondsShort', { count: Math.round(s) });
  const update = (): void => {
    if (ended || !stats.playing) {
      goLive.hidden = true;
      return;
    }
    const target = liveTarget();
    const behind = target === null ? null : Math.max(0, target - video.currentTime);
    // A short hold inside a stall (adaptive delay) is not a pause.
    const atLive = (!video.paused || !!adaptive?.holding) && (behind === null || behind < behindThresholdS);
    goLive.hidden = false;
    goLive.classList.toggle('at-live', atLive);
    goLive.dataset.behind = behind === null ? '' : behind.toFixed(1);
    if (atLive) {
      goLive.textContent = t('watch.atLive');
      const l = latency();
      goLive.title = l === null ? t('watch.goLive.tipUnknown') : t('watch.atLive.tip', { latency: seconds(l) });
    } else {
      goLive.textContent = t('watch.goLive');
      if (behind !== null && behind >= 1) {
        const span = document.createElement('span');
        span.className = 'behind';
        span.textContent = ` −${seconds(behind)}`;
        goLive.append(span);
      }
      goLive.title = behind === null ? t('watch.goLive.tipUnknown') : t('watch.goLive.tip', { behind: seconds(behind) });
    }
  };
  goLive.addEventListener('click', () => {
    const target = liveTarget();
    if (target !== null && Math.abs(target - video.currentTime) > 0.5) video.currentTime = target;
    void video.play().catch(() => {
      unmute.hidden = false;
    });
    update();
  });
  for (const ev of ['playing', 'pause', 'seeked', 'waiting'] as const) video.addEventListener(ev, update);
  setInterval(update, 1000);
}

void main().catch((err: unknown) => {
  console.error(err);
  showOverlay('watch.wrong');
});
