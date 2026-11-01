/**
 * The player's own controls, one look in every browser (research §1, "hybrid custom overlay"): a
 * bar over the bottom of the video with play / pause, sound (mute, and a volume slider where the
 * page may set the volume: not on iOS / iPadOS), LIVE / Go live (watch.ts setupGoLive moves the
 * button here) with the delay while full screen, the quality menu (quality-menu.ts), and on the
 * right picture-in-picture (where the browser has it), theater mode (computers) and full screen;
 * plus a big Play button in the middle while the video is paused (iOS Low Power Mode blocks even
 * muted autoplay, and the viewer must have something to press).
 *
 * - Full screen is the player container (player-caps.ts), so these controls, the status and
 *   stats overlays (and later the chat over the video) stay in it. An iPhone can only show the
 *   video in iOS's own full-screen player: there the button opens that, and our controls come
 *   back when the viewer leaves it (state resynced on webkitendfullscreen).
 * - The controls fade out while the video plays and come back with the pointer, a touch, the
 *   keyboard focus or a shortcut (controls-visibility.ts has the rules). Faded, they stay in the
 *   page for screen readers and the Tab key; a touch on a faded control only shows the controls
 *   (no press by accident), the mouse shows them on its way to a button anyway.
 * - Real <button>s with their names as text (screen readers and voice control read them) and
 *   the shortcut in the tooltip; the volume is a native range input with its value in words;
 *   44 px touch targets; colours only from the --sc-* / player tokens.
 * - The native `controls` attribute stays in watch.html: it is removed here, once this bar is
 *   built, so a page whose script did not run keeps the browser's own controls.
 */
import './player-controls.css';
import { ControlsVisibility } from './controls-visibility.js';
import { fullscreenMode, inPip, isFullscreen, pipMode, toggleFullscreen, togglePip, volumeSettable, type FullscreenMode, type PipMode } from './player-caps.js';

export interface PlayerControlsLabels {
  /** The bar's group name ("Video controls"). */
  group: string;
  play: string;
  pause: string;
  mute: string;
  unmute: string;
  volume: string;
  /** The volume in words, e.g. "40%". */
  volumeValue: (percent: number) => string;
  fullscreen: string;
  exitFullscreen: string;
  pip: string;
  exitPip: string;
  /** A control's tooltip with its keyboard shortcut, e.g. "Pause (K)". */
  withKey: (label: string, key: string) => string;
}

export const DEFAULT_CONTROLS_LABELS: PlayerControlsLabels = {
  group: 'Video controls',
  play: 'Play',
  pause: 'Pause',
  mute: 'Mute',
  unmute: 'Unmute',
  volume: 'Volume',
  volumeValue: (p) => `${p}%`,
  fullscreen: 'Full screen',
  exitFullscreen: 'Exit full screen',
  pip: 'Picture-in-picture',
  exitPip: 'Exit picture-in-picture',
  withKey: (label, key) => `${label} (${key})`,
};

export interface PlayerControlsDeps {
  /** The player container (`.player`): what goes full screen, and where the bar is drawn. */
  player: HTMLElement;
  video: HTMLVideoElement;
  doc: Document;
  /** setTimeout / matchMedia / performance.now of the page (fakes in unit tests). */
  win: Pick<Window, 'setTimeout' | 'clearTimeout' | 'matchMedia'>;
  now?: () => number;
  /** "LIVE / Go live" (watch.html), moved into the bar. */
  goLive?: HTMLButtonElement | null;
  /** "Theater mode" (watch.html), moved into the bar as an icon button. */
  theater?: HTMLButtonElement | null;
  labels?: PlayerControlsLabels;
  /** The adaptive delay's short hold inside a stall pauses the video, but nothing changed for the viewer. */
  isHeld?: () => boolean;
  /** The stream's first picture is there (the big Play button waits for it). */
  started?: () => boolean;
  ended?: () => boolean;
  /** play() was refused (autoplay rules): watch.ts shows its Unmute button. */
  onPlayRefused?: () => void;
}

export interface PlayerControls {
  readonly fullscreenMode: FullscreenMode;
  readonly pipMode: PipMode;
  /** Where the quality menu goes (watch.ts, once hls.js exists). */
  readonly qualitySlot: HTMLElement;
  readonly bar: HTMLElement;
  readonly visibility: ControlsVisibility;
  playPause(): void;
  toggleMute(): void;
  toggleFullscreen(): boolean;
  togglePip(): boolean;
  /** Show the controls for a moment (a shortcut was used). */
  reveal(): void;
  /** A menu of the bar opened or closed: the bar stays while it is open. */
  menuOpen(open: boolean): void;
  /** The delay behind live, shown in the bar while full screen (null: nothing). */
  setDelay(text: string | null): void;
  /** Read the video's state again (watch.ts after its own changes: started, ended). */
  sync(): void;
}

/** A focus within this long after a pointer press inside the bar came from that press (not the keyboard). */
const POINTER_FOCUS_MS = 500;

function button(doc: Document, cls: string, testid: string): HTMLButtonElement {
  const b = doc.createElement('button');
  b.type = 'button';
  b.className = `pc-btn ${cls}`;
  b.dataset.testid = testid;
  const label = doc.createElement('span');
  label.className = 'pc-sr';
  b.append(label);
  return b;
}

/** Sets a control's name (its text, read by screen readers) and its tooltip (with the shortcut). */
function name(b: HTMLButtonElement, label: string, tooltip: string): void {
  const span = b.querySelector('.pc-sr');
  if (span && span.textContent !== label) span.textContent = label;
  if (b.title !== tooltip) b.title = tooltip;
}

/** Builds the bar into `player`, removes the native controls and wires everything. */
export function mountPlayerControls(d: PlayerControlsDeps): PlayerControls {
  const { player, video, doc, win } = d;
  const L = d.labels ?? DEFAULT_CONTROLS_LABELS;
  const now = d.now ?? (() => Date.now());
  const held = d.isHeld ?? (() => false);
  const started = d.started ?? (() => !video.paused);
  const ended = d.ended ?? (() => false);
  const fsMode = fullscreenMode(player, video, doc);
  const pip = pipMode(video, doc);
  const canVolume = volumeSettable(video);

  const root = doc.createElement('div');
  root.className = 'pc';
  root.dataset.testid = 'player-ui';

  const bigPlay = button(doc, 'pc-big-play pc-ico-play', 'big-play');
  bigPlay.hidden = true;

  const bar = doc.createElement('div');
  bar.className = 'pc-bar';
  bar.dataset.testid = 'controls';
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', L.group);
  const left = doc.createElement('div');
  left.className = 'pc-left';
  const right = doc.createElement('div');
  right.className = 'pc-right';
  bar.append(left, right);

  const play = button(doc, 'pc-play', 'play');
  const mute = button(doc, 'pc-mute', 'mute');
  const volume = doc.createElement('input');
  volume.type = 'range';
  volume.className = 'pc-volume';
  volume.dataset.testid = 'volume';
  volume.min = '0';
  volume.max = '100';
  volume.step = '5';
  volume.setAttribute('aria-label', L.volume);
  volume.title = L.volume;
  volume.hidden = !canVolume;
  const sound = doc.createElement('div');
  sound.className = 'pc-sound';
  sound.append(mute, volume);
  const delay = doc.createElement('span');
  delay.className = 'pc-delay';
  delay.dataset.testid = 'controls-delay';
  // The status bar under the player says it to screen readers already (#delay).
  delay.setAttribute('aria-hidden', 'true');
  delay.hidden = true;
  left.append(play, sound);
  if (d.goLive) {
    d.goLive.classList.add('pc-live');
    left.append(d.goLive);
  }
  left.append(delay);

  const qualitySlot = doc.createElement('div');
  qualitySlot.className = 'pc-quality';
  const pipBtn = button(doc, 'pc-pip pc-ico-pip', 'pip');
  pipBtn.hidden = pip === 'none';
  const fsBtn = button(doc, 'pc-fullscreen', 'fullscreen');
  fsBtn.hidden = fsMode === 'none';
  right.append(qualitySlot, pipBtn);
  if (d.theater) {
    // Its translated text becomes the hidden name of an icon button; its tooltip stays.
    const text = d.theater.textContent?.trim() ?? '';
    const label = doc.createElement('span');
    label.className = 'pc-sr';
    label.textContent = text;
    d.theater.replaceChildren(label);
    d.theater.removeAttribute('data-i18n');
    d.theater.classList.remove('secondary');
    d.theater.classList.add('pc-btn', 'pc-ico-theater');
    right.append(d.theater);
  }
  right.append(fsBtn);

  root.append(bigPlay, bar);
  player.append(root);

  // ---- showing and fading -------------------------------------------------------------------
  const visibility = new ControlsVisibility({
    schedule: (fn, ms) => {
      const id = win.setTimeout(fn, ms);
      return () => win.clearTimeout(id);
    },
    onChange: (visible) => player.classList.toggle('pc-idle', !visible),
  });
  const reduced = win.matchMedia?.('(prefers-reduced-motion: reduce)');
  if (reduced) {
    visibility.pin('reduced-motion', reduced.matches);
    reduced.addEventListener?.('change', () => visibility.pin('reduced-motion', reduced.matches));
  }

  // ---- state ---------------------------------------------------------------------------------
  const playingNow = (): boolean => !video.paused || held();
  const sync = (): void => {
    const playing = playingNow();
    visibility.setPlaying(playing && !ended());
    play.classList.toggle('pc-ico-pause', playing);
    play.classList.toggle('pc-ico-play', !playing);
    name(play, playing ? L.pause : L.play, L.withKey(playing ? L.pause : L.play, 'K'));
    bigPlay.hidden = playing || ended() || !started();
    name(bigPlay, L.play, L.play);
    const silent = video.muted || video.volume === 0;
    mute.classList.toggle('pc-ico-volume-off', silent);
    mute.classList.toggle('pc-ico-volume', !silent);
    name(mute, silent ? L.unmute : L.mute, L.withKey(silent ? L.unmute : L.mute, 'M'));
    const percent = silent ? 0 : Math.round(video.volume * 100);
    if (volume.value !== String(percent)) volume.value = String(percent);
    volume.setAttribute('aria-valuetext', L.volumeValue(percent));
    const fs = isFullscreen(video, doc);
    const containerFs = (doc.fullscreenElement ?? (doc as Document & { webkitFullscreenElement?: Element | null }).webkitFullscreenElement) === player;
    player.classList.toggle('is-fullscreen', containerFs);
    fsBtn.classList.toggle('pc-ico-fullscreen-exit', fs);
    fsBtn.classList.toggle('pc-ico-fullscreen', !fs);
    name(fsBtn, fs ? L.exitFullscreen : L.fullscreen, L.withKey(fs ? L.exitFullscreen : L.fullscreen, 'F'));
    const inWindow = inPip(video, doc);
    pipBtn.classList.toggle('active', inWindow);
    name(pipBtn, inWindow ? L.exitPip : L.pip, L.withKey(inWindow ? L.exitPip : L.pip, 'I'));
  };

  const playPause = (): void => {
    if (playingNow()) {
      video.pause();
      return;
    }
    const p = video.play();
    if (p && typeof p.catch === 'function') p.catch(() => d.onPlayRefused?.());
  };
  const toggleMute = (): void => {
    const unmuting = video.muted || video.volume === 0;
    // Back from a volume of 0 (the slider at the left end), unmuting gives some sound again.
    if (unmuting && video.volume === 0 && canVolume) video.volume = 0.5;
    video.muted = !unmuting;
  };

  play.addEventListener('click', playPause);
  bigPlay.addEventListener('click', playPause);
  mute.addEventListener('click', toggleMute);
  volume.addEventListener('input', () => {
    const v = Number(volume.value) / 100;
    video.volume = v;
    video.muted = v === 0;
  });
  pipBtn.addEventListener('click', () => togglePip(video, doc));
  fsBtn.addEventListener('click', () => toggleFullscreen(player, video, doc));

  for (const ev of ['play', 'pause', 'playing', 'waiting', 'ended', 'volumechange', 'loadeddata', 'emptied', 'enterpictureinpicture', 'leavepictureinpicture', 'webkitpresentationmodechanged', 'webkitbeginfullscreen', 'webkitendfullscreen']) {
    video.addEventListener(ev, sync);
  }
  for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) doc.addEventListener(ev, sync);

  // ---- pointer, touch and focus ---------------------------------------------------------------
  let lastPointerAt = -Infinity;
  let lastPointerType = 'mouse';
  /** The press began on a faded control: it only shows the controls, its click is dropped. */
  let swallowClick = false;
  /** A touch on the video began while the controls were faded. */
  let touchRevealed = false;

  const markPointer = (e: Event): void => {
    lastPointerAt = now();
    if (e instanceof PointerEvent) lastPointerType = e.pointerType || 'mouse';
  };
  for (const ev of ['pointerdown', 'pointerup', 'mousedown', 'touchstart', 'touchend']) root.addEventListener(ev, markPointer, { capture: true, passive: true });

  player.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') visibility.activity();
  });
  player.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') visibility.hide();
  });
  player.addEventListener(
    'pointerdown',
    (e) => {
      lastPointerType = e.pointerType || 'mouse';
      if (e.pointerType === 'mouse') return visibility.activity();
      const onControls = root.contains(e.target as Node);
      if (onControls) {
        swallowClick = !visibility.visible;
        visibility.activity();
      } else {
        touchRevealed = !visibility.visible;
      }
    },
    { capture: true },
  );
  player.addEventListener('pointercancel', () => {
    swallowClick = false;
  });
  root.addEventListener(
    'click',
    (e) => {
      // detail 0: a click from the keyboard (Enter / Space), never dropped.
      if (swallowClick && e.detail > 0) {
        e.preventDefault();
        e.stopPropagation();
      }
      swallowClick = false;
    },
    { capture: true },
  );
  // A click on the picture: play / pause with a mouse (as on the big video sites); a touch shows
  // or hides the controls instead (a finger cannot hover).
  video.addEventListener('click', () => {
    if (lastPointerType === 'mouse') {
      playPause();
      visibility.activity();
    } else if (touchRevealed) visibility.activity();
    else visibility.hide();
    touchRevealed = false;
  });
  bar.addEventListener('pointerenter', (e) => {
    if (e.pointerType === 'mouse') visibility.pin('hover', true);
  });
  bar.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') visibility.pin('hover', false);
  });
  // The keyboard focus inside the controls holds them; a focus that a mouse or finger press gave
  // a button does not (Chrome focuses a clicked button: the bar would never fade again).
  root.addEventListener('focusin', () => {
    if (now() - lastPointerAt > POINTER_FOCUS_MS) visibility.pin('focus', true);
    else visibility.activity();
  });
  root.addEventListener('focusout', (e) => {
    if (!root.contains(e.relatedTarget as Node | null)) visibility.pin('focus', false);
  });

  sync();
  // Built: the browser's own controls go (watch.html keeps them for a page whose script failed).
  video.removeAttribute('controls');
  player.classList.add('pc-on');

  return {
    fullscreenMode: fsMode,
    pipMode: pip,
    qualitySlot,
    bar,
    visibility,
    playPause,
    toggleMute,
    toggleFullscreen: () => {
      const done = toggleFullscreen(player, video, doc);
      visibility.activity();
      return done;
    },
    togglePip: () => (pip === 'none' ? false : togglePip(video, doc)),
    reveal: () => visibility.activity(),
    menuOpen: (open) => visibility.pin('menu', open),
    setDelay: (text) => {
      delay.hidden = text === null;
      if (text !== null && delay.textContent !== text) delay.textContent = text;
    },
    sync,
  };
}
