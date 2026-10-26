/**
 * Viewer quality menu: "Auto (720p)" / 1080p / 720p / 480p, built from hls.levels.
 * Manual picks switch at the next segment (no buffer flush, so no stall); "Auto" hands
 * control back to hls.js ABR. The pick is remembered by height for the next visit.
 * Wired into watch.ts as described in INTEGRATION.md.
 */
import type Hls from 'hls.js';
import './quality.css';
import { loadPreferredHeight, savePreferredHeight } from './player-config.js';

export interface QualityMenuLabels {
  auto: string;
  /** Shown next to "Auto" with the level currently playing, e.g. "Auto (720p)". */
  autoWith: (label: string) => string;
  title: string;
}

export const DEFAULT_QUALITY_LABELS: QualityMenuLabels = {
  auto: 'Auto',
  autoWith: (l) => `Auto (${l})`,
  title: 'Video quality',
};

type HlsLike = Pick<Hls, 'levels' | 'currentLevel' | 'loadLevel' | 'nextLevel' | 'autoLevelEnabled' | 'on' | 'off'>;

export function levelLabel(level: { height?: number; bitrate?: number }): string {
  if (level.height) return `${level.height}p`;
  return level.bitrate ? `${Math.round(level.bitrate / 1000)} kbps` : '?';
}

/** Index of the level whose height is closest to `height` (at or below it when possible). */
export function levelForHeight(levels: Array<{ height?: number }>, height: number): number {
  let best = -1;
  levels.forEach((l, i) => {
    const h = l.height ?? 0;
    const bh = best >= 0 ? (levels[best]!.height ?? 0) : -1;
    if (h <= height && h > bh) best = i;
  });
  if (best >= 0) return best;
  // Everything is above the wish: take the smallest.
  let min = 0;
  levels.forEach((l, i) => {
    if ((l.height ?? 0) < (levels[min]!.height ?? 0)) min = i;
  });
  return levels.length ? min : -1;
}

export interface QualityMenu {
  element: HTMLSelectElement;
  /** Rebuild from hls.levels (call on MANIFEST_PARSED). */
  refresh(): void;
  destroy(): void;
}

/**
 * Create the menu inside `container`. `events` are hls.js event names (pass Hls.Events) so
 * this module does not import hls.js at runtime.
 */
export function createQualityMenu(
  hls: HlsLike,
  container: HTMLElement,
  events: { MANIFEST_PARSED: string; LEVEL_SWITCHED: string },
  labels: QualityMenuLabels = DEFAULT_QUALITY_LABELS,
): QualityMenu {
  const select = document.createElement('select');
  select.className = 'quality-menu';
  select.title = labels.title;
  select.setAttribute('aria-label', labels.title);
  container.appendChild(select);

  const render = (): void => {
    const levels = hls.levels;
    select.replaceChildren();
    const playing = levels[hls.currentLevel];
    const auto = new Option(playing && hls.autoLevelEnabled ? labels.autoWith(levelLabel(playing)) : labels.auto, '-1');
    select.add(auto);
    levels
      .map((l, i) => ({ l, i }))
      .sort((a, b) => (b.l.height ?? 0) - (a.l.height ?? 0) || (b.l.bitrate ?? 0) - (a.l.bitrate ?? 0))
      .forEach(({ l, i }) => select.add(new Option(levelLabel(l), String(i))));
    select.value = hls.autoLevelEnabled ? '-1' : String(hls.loadLevel);
    select.hidden = levels.length < 2;
  };

  const onParsed = (): void => {
    const wanted = loadPreferredHeight();
    if (wanted !== null && hls.levels.length > 1) {
      const idx = levelForHeight(hls.levels, wanted);
      if (idx >= 0) hls.loadLevel = idx;
    }
    render();
  };
  const onSwitched = (): void => render();

  select.addEventListener('change', () => {
    const idx = Number(select.value);
    if (idx < 0) {
      hls.loadLevel = -1;
      savePreferredHeight(null);
    } else {
      // nextLevel: switch at the next segment boundary; keeps what is already buffered.
      hls.nextLevel = idx;
      savePreferredHeight(hls.levels[idx]?.height ?? null);
    }
    render();
  });

  hls.on(events.MANIFEST_PARSED as never, onParsed as never);
  hls.on(events.LEVEL_SWITCHED as never, onSwitched as never);
  if (hls.levels.length) onParsed();
  return {
    element: select,
    refresh: render,
    destroy: () => {
      hls.off(events.MANIFEST_PARSED as never, onParsed as never);
      hls.off(events.LEVEL_SWITCHED as never, onSwitched as never);
      select.remove();
    },
  };
}
