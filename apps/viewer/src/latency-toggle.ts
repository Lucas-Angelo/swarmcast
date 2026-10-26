/**
 * "Stable / Lower delay" switch for viewers. Stable is the default; the choice is remembered.
 * Wired into watch.ts as described in INTEGRATION.md.
 */
import { applyProfile, loadProfile, type PlaybackProfileId, type PlayerConfigOptions } from './player-config.js';

export interface LatencyToggleLabels {
  stable: string;
  lowDelay: string;
  title: string;
  /** Short hint under the control for the current choice. */
  hint: Record<PlaybackProfileId, string>;
}

export const DEFAULT_LATENCY_LABELS: LatencyToggleLabels = {
  stable: 'Stable',
  lowDelay: 'Lower delay',
  title: 'Playback',
  hint: {
    stable: 'About 20 s behind live. Smoothest playback; best for P2P.',
    'low-delay': 'About 8 s behind live. May pause on weak connections.',
  },
};

type ApplyArgs = Parameters<typeof applyProfile>;

export interface LatencyToggle {
  element: HTMLElement;
  get value(): PlaybackProfileId;
  destroy(): void;
}

/** A two-option segmented control (radio buttons, keyboard accessible). */
export function createLatencyToggle(
  container: HTMLElement,
  player: { hls: ApplyArgs[0]; engine: ApplyArgs[1] } | null,
  opts: PlayerConfigOptions,
  labels: LatencyToggleLabels = DEFAULT_LATENCY_LABELS,
  onChange?: (id: PlaybackProfileId) => void,
): LatencyToggle {
  let value = loadProfile();
  const wrap = document.createElement('fieldset');
  wrap.className = 'latency-toggle';
  const legend = document.createElement('legend');
  legend.textContent = labels.title;
  wrap.appendChild(legend);
  const hint = document.createElement('small');
  // The two options sit together as a segmented control.
  const segments = document.createElement('div');
  segments.className = 'segmented';
  wrap.appendChild(segments);
  const name = `latency-${Math.random().toString(36).slice(2, 8)}`;
  const options: Array<[PlaybackProfileId, string]> = [
    ['stable', labels.stable],
    ['low-delay', labels.lowDelay],
  ];
  for (const [id, text] of options) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.value = id;
    input.checked = id === value;
    input.addEventListener('change', () => {
      if (!input.checked) return;
      value = id;
      hint.textContent = labels.hint[id];
      if (player) applyProfile(player.hls, player.engine, id, opts);
      onChange?.(id);
    });
    label.append(input, ` ${text}`);
    segments.appendChild(label);
  }
  hint.textContent = labels.hint[value];
  wrap.appendChild(hint);
  container.appendChild(wrap);
  return {
    element: wrap,
    get value() {
      return value;
    },
    destroy: () => wrap.remove(),
  };
}
