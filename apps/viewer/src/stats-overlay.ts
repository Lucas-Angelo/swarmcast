/**
 * "Stats for nerds": a small panel over the top of the video with what the player is doing right
 * now (resolution, quality and bitrate, buffer, delay behind live, dropped frames, how much video
 * came from other viewers, the connection type). Off by default; stats-toggle.ts loads this chunk
 * only when the viewer opens it, and the numbers refresh once a second only while it is open.
 *
 * It shows nothing that identifies anyone: no peer IDs, no IP addresses, no session, no host name
 * (Copy gives the same lines as text, for a support message).
 */
import './stats-overlay.css';
import { formatNumber, t } from './i18n.js';

/** What the panel reads of the <video> element. */
export interface StatsVideo {
  readonly videoWidth: number;
  readonly videoHeight: number;
  readonly currentTime: number;
  readonly playbackRate: number;
  readonly buffered: { readonly length: number; start(i: number): number; end(i: number): number };
  getVideoPlaybackQuality?: () => { droppedVideoFrames: number; totalVideoFrames: number };
}

/** What the panel reads of an hls.js level. */
export interface StatsLevel {
  height?: number;
  bitrate?: number;
  frameRate?: number;
}

/** What the panel reads of hls.js (absent on the browser's own HLS player). */
export interface StatsHls {
  readonly levels: readonly StatsLevel[];
  readonly currentLevel: number;
  readonly autoLevelEnabled: boolean;
  readonly bandwidthEstimate: number;
  readonly latency: number;
}

/** The page's own counters (watch.ts `stats`). */
export interface StatsCounters {
  httpBytes: number;
  p2pDownBytes: number;
  p2pUpBytes: number;
  peers: number;
  p2pEnabled: boolean;
}

/** navigator.connection (Chrome, Edge, Android): all optional. */
export interface StatsConnection {
  effectiveType?: string;
  type?: string;
  downlink?: number;
}

export interface StatsSource {
  video: StatsVideo;
  hls(): StatsHls | null;
  counters(): StatsCounters;
  /** The adaptive delay (adaptive-delay.ts): seconds behind live and the target, null before playback. */
  delay(): { delay: number | null; target: number } | null;
  profile(): 'stable' | 'low-delay';
  /** MediaSource, ManagedMediaSource (iOS, Safari) or the browser's own HLS player. */
  engine(): 'mse' | 'mms' | 'native';
  connection(): StatsConnection | undefined;
}

export type StatsRowId = 'resolution' | 'quality' | 'bandwidth' | 'buffer' | 'delay' | 'playback' | 'frames' | 'p2p' | 'fromPeers' | 'shared' | 'fromServer' | 'connection' | 'engine';

export interface StatsRow {
  id: StatsRowId;
  label: string;
  value: string;
}

const NONE = '—';

const finite = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);
const seconds = (s: number): string => t('time.secondsShort', { count: Math.round(s * 10) / 10 });
const mbps = (bps: number): string => t('watch.stats.mbps', { n: Math.round(bps / 1e5) / 10 });
const mb = (bytes: number): string => formatNumber(Math.round(bytes / 1e5) / 10);
/** The playback speed with two decimals (the adaptive delay moves it by 1-3 %), in the page's language. */
const rate = (r: number): string => {
  try {
    return r.toLocaleString(document.documentElement.lang || 'en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } catch {
    return r.toFixed(2);
  }
};

/** Seconds of video loaded past the playhead (in the buffered range that holds it). */
export function bufferAhead(video: Pick<StatsVideo, 'buffered' | 'currentTime'>): number {
  const b = video.buffered;
  for (let i = 0; i < b.length; i++) {
    if (video.currentTime >= b.start(i) - 0.1 && video.currentTime <= b.end(i)) return Math.max(0, b.end(i) - video.currentTime);
  }
  return 0;
}

/** The share of the downloaded video that came from other viewers, in whole percent. */
export function p2pShare(c: Pick<StatsCounters, 'httpBytes' | 'p2pDownBytes'>): number {
  const total = c.httpBytes + c.p2pDownBytes;
  return total > 0 ? Math.round((c.p2pDownBytes / total) * 100) : 0;
}

/** Every line of the panel, in order, as text in the page's language. */
export function collectStats(src: StatsSource): StatsRow[] {
  const v = src.video;
  const hls = src.hls();
  const level = hls && hls.currentLevel >= 0 ? hls.levels[hls.currentLevel] : undefined;
  const c = src.counters();
  const d = src.delay();
  const conn = src.connection();
  const rows: StatsRow[] = [];
  const add = (id: StatsRowId, value: string): void => void rows.push({ id, label: t(`watch.stats.${id}`), value });

  const size = v.videoWidth > 0 && v.videoHeight > 0 ? `${v.videoWidth}×${v.videoHeight}` : null;
  add('resolution', size === null ? NONE : finite(level?.frameRate) && level.frameRate > 0 ? t('watch.stats.fps', { size, fps: Math.round(level.frameRate) }) : size);

  if (hls && level) {
    const parts = [finite(level.height) && level.height > 0 ? `${level.height}p` : null, finite(level.bitrate) && level.bitrate > 0 ? mbps(level.bitrate) : null, hls.autoLevelEnabled ? t('watch.quality.auto') : t('watch.stats.chosen')];
    add('quality', parts.filter((p): p is string => p !== null).join(' · '));
  } else add('quality', NONE);

  add('bandwidth', hls && finite(hls.bandwidthEstimate) && hls.bandwidthEstimate > 0 ? mbps(hls.bandwidthEstimate) : NONE);
  add('buffer', seconds(bufferAhead(v)));

  const behind = finite(d?.delay) ? d.delay : hls && finite(hls.latency) && hls.latency > 0 ? hls.latency : null;
  add('delay', behind === null ? NONE : d && finite(d.target) && d.target > 0 ? t('watch.stats.delayTarget', { delay: seconds(behind), target: seconds(d.target) }) : seconds(behind));

  const profile = src.profile() === 'low-delay' ? t('watch.latency.lowDelay') : t('watch.latency.stable');
  add('playback', `${profile} · ${t('watch.stats.speed', { rate: rate(v.playbackRate) })}`);

  const q = typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null;
  add('frames', q ? t('watch.stats.framesOf', { dropped: q.droppedVideoFrames, total: q.totalVideoFrames }) : NONE);

  add('p2p', c.p2pEnabled ? t('watch.stats.p2pOn', { peers: t('watch.peers', { count: c.peers }) }) : t('watch.stats.p2pOff'));
  add('fromPeers', t('watch.stats.fromPeersValue', { mb: mb(c.p2pDownBytes), share: p2pShare(c) }));
  add('shared', t('watch.stats.mb', { mb: mb(c.p2pUpBytes) }));
  add('fromServer', t('watch.stats.mb', { mb: mb(c.httpBytes) }));

  const kind = conn?.effectiveType ?? conn?.type;
  add('connection', kind ? [kind, finite(conn?.downlink) && conn.downlink > 0 ? `~${mbps(conn.downlink * 1e6)}` : null].filter((p): p is string => p !== null).join(' · ') : NONE);

  const engine = src.engine();
  add('engine', engine === 'native' ? t('watch.stats.engine.native') : engine === 'mms' ? 'hls.js · ManagedMediaSource' : 'hls.js · MediaSource');
  return rows;
}

/** The lines as plain text (Copy). */
export function statsText(rows: readonly StatsRow[]): string {
  return rows.map((r) => `${r.label}: ${r.value}`).join('\n');
}

export interface StatsPanel {
  /** Stops the refresh and empties the host. */
  destroy(): void;
}

export interface StatsPanelDeps {
  /** The empty, hidden container in the player (watch.html #stats). */
  host: HTMLElement;
  source: StatsSource;
  /** The viewer closed it (the × button or Esc). */
  onClose(): void;
  clipboard?: { writeText(text: string): Promise<void> };
  /** Refresh period (ms). */
  everyMs?: number;
}

/** Fills the host with the panel, refreshes it every second and listens for Esc until destroy(). */
export function mountStatsPanel(d: StatsPanelDeps): StatsPanel {
  const { host } = d;
  const doc = host.ownerDocument;
  host.replaceChildren();
  host.setAttribute('role', 'region');
  host.setAttribute('aria-labelledby', 'stats-title');

  const head = doc.createElement('div');
  head.className = 'stats-head';
  const title = doc.createElement('h2');
  title.id = 'stats-title';
  title.textContent = t('watch.stats.title');
  const copy = doc.createElement('button');
  copy.type = 'button';
  copy.className = 'stats-btn';
  copy.textContent = t('watch.stats.copy');
  copy.dataset.testid = 'stats-copy';
  const close = doc.createElement('button');
  close.type = 'button';
  close.className = 'stats-btn stats-close';
  close.textContent = '×';
  close.setAttribute('aria-label', t('watch.stats.close'));
  close.dataset.testid = 'stats-close';
  const status = doc.createElement('span');
  status.className = 'stats-status';
  status.setAttribute('role', 'status');
  head.append(title, status, copy, close);

  const list = doc.createElement('dl');
  list.className = 'stats-list';
  const values = new Map<StatsRowId, HTMLElement>();
  let rows = collectStats(d.source);
  for (const r of rows) {
    const row = doc.createElement('div');
    row.dataset.stat = r.id;
    const dt = doc.createElement('dt');
    dt.textContent = r.label;
    const dd = doc.createElement('dd');
    dd.textContent = r.value;
    row.append(dt, dd);
    list.append(row);
    values.set(r.id, dd);
  }
  host.append(head, list);

  const refresh = (): void => {
    rows = collectStats(d.source);
    for (const r of rows) {
      const dd = values.get(r.id);
      if (dd && dd.textContent !== r.value) dd.textContent = r.value;
    }
  };
  const timer = setInterval(refresh, d.everyMs ?? 1000);

  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  copy.addEventListener('click', () => {
    const text = statsText(rows);
    void (d.clipboard ? d.clipboard.writeText(text) : Promise.reject(new Error('no clipboard'))).then(
      () => {
        status.textContent = t('watch.stats.copied');
        clearTimeout(statusTimer);
        statusTimer = setTimeout(() => (status.textContent = ''), 3000);
      },
      () => {
        /* clipboard refused: the lines stay on screen to read */
      },
    );
  });
  close.addEventListener('click', () => d.onClose());

  // Esc closes it, unless something else took that Esc (a menu of the chat, a dialog, a text field).
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    const el = e.target instanceof Element ? e.target : null;
    if (el && el !== host && !host.contains(el) && el.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), dialog, #chat')) return;
    d.onClose();
  };
  doc.addEventListener('keydown', onKey);
  // The link is under the video (the settings card): bring the video, with the panel on it, into view.
  host.scrollIntoView?.({ block: 'nearest' });
  close.focus({ preventScroll: true });

  return {
    destroy() {
      clearInterval(timer);
      clearTimeout(statusTimer);
      doc.removeEventListener('keydown', onKey);
      host.replaceChildren();
    },
  };
}
