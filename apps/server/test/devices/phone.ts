// The phone a device test drives (android.ts: Chrome on an Android emulator; ios.ts: Mobile
// Safari on an iOS Simulator) and what the specs read from the watch page on it. Every check
// reads the page through `evaluate`, so the same spec runs on both: Playwright's web-first
// assertions only exist for the Android side, `expect.poll` works for both.
import { expect } from '../e2e/fixtures.js';

export type Platform = 'android' | 'ios';
export type Orientation = 'portrait' | 'landscape';

export interface Phone {
  readonly platform: Platform;
  /**
   * Whether a tap on a text field raises the on-screen keyboard here. False on the iOS Simulator
   * driven by safaridriver (ios.ts IosPhone.onScreenKeyboard has the evidence): the checks of
   * what the keyboard leaves in sight then run on Android only.
   */
  readonly onScreenKeyboard: boolean;
  /** Opens a link the way a viewer does: handed to the browser by the system (Android: a VIEW intent). */
  open(url: string): Promise<void>;
  /** The address of the page the browser shows. */
  url(): Promise<string>;
  /** `fn(arg)` in the page; returns its JSON result. `fn` must not use anything from outside its body. */
  evaluate<R, A = undefined>(fn: (arg: A) => R, arg?: A): Promise<R>;
  /** The orientation the phone was last turned to (rotate()); a test starts upright. */
  readonly orientation: Orientation;
  /**
   * A finger tap in the middle of the element, scrolled into view first, once the element is
   * actionable and the browser shows it where the page has it; it returns once the page got the
   * click (actionability.ts). Taps raise the on-screen keyboard.
   */
  tap(selector: string): Promise<void>;
  /**
   * Types into the element (tap it first), as the on-screen keyboard does. iOS: the text is put
   * in the field as the keyboard would (IosPhone.type says why).
   */
  type(selector: string, text: string): Promise<void>;
  /** Turns the phone (the system rotation, as the viewer turning it or tapping the rotate button). */
  rotate(to: Orientation): Promise<void>;
  /** The system Back gesture (Android: leaves a full-screen video). iOS has none and throws. */
  back(): Promise<void>;
  /** The viewer switches to another app: the browser goes to the background and stops. */
  background(): Promise<void>;
  /** ...and comes back to the browser, which resumes where it was. */
  foreground(): Promise<void>;
  /** The whole screen (system bars and keyboard included), as a PNG. */
  screenshot(): Promise<Buffer>;
  /** What the system says about the on-screen keyboard, for a failure message (Android: the input method service). */
  keyboardState(): Promise<string>;
  /**
   * Whether the system reports the on-screen keyboard shown (Android: the input method service's
   * mInputShown). Asked only where `onScreenKeyboard` is true.
   */
  keyboardShown(): Promise<boolean>;
  /** Ends the test's browser session. */
  close(): Promise<void>;
}

/** The video element's playback, as the specs check it, with what a failure message needs. */
export interface VideoState {
  paused: boolean;
  muted: boolean;
  /** Seconds really played (the `played` ranges): hls.js seeks before the first frame plays. */
  played: number;
  currentTime: number;
  seeking: boolean;
  /** HTMLMediaElement.readyState: 3 (HAVE_FUTURE_DATA) or more once it can play on. */
  readyState: number;
  /** The buffered ranges, `start-end` in seconds, for a failure message. */
  buffered: string;
  /** The page's status line under the player ("Live", "Buffering…"). */
  status: string | null;
}

export function videoState(phone: Phone): Promise<VideoState> {
  return phone.evaluate(() => {
    const v = document.querySelector('video')!;
    let played = 0;
    for (let i = 0; i < v.played.length; i++) played += v.played.end(i) - v.played.start(i);
    const buffered = Array.from({ length: v.buffered.length }, (_, i) => `${v.buffered.start(i).toFixed(2)}-${v.buffered.end(i).toFixed(2)}`).join(' ');
    return { paused: v.paused, muted: v.muted, played, currentTime: v.currentTime, seeking: v.seeking, readyState: v.readyState, buffered: buffered || 'nothing', status: document.getElementById('status')?.textContent ?? null };
  });
}

function describeVideo(v: VideoState): string {
  return `${v.paused ? 'paused' : 'not paused'}${v.seeking ? ', seeking' : ''}, readyState ${v.readyState}, at ${v.currentTime.toFixed(2)} s, buffered ${v.buffered}, ${v.played.toFixed(2)} s played, status "${v.status}"`;
}

/** Seconds of video played before a viewer counts as watching (as waitPlaying() in the e2e fixtures). */
export const WATCHING_S = 1.5;

/**
 * Waits until the viewer is watching the live: the video has played WATCHING_S seconds, and the
 * page shows how far behind live it plays ("~14 s behind live" with its "i" button, watch.ts
 * showDelay), the last of what the watch page reveals by itself as the live starts. "Live", Unmute
 * and Go live come with the video's first `playing`; the delay comes with the next second's update
 * after it, once hls.js has measured the latency (it reads 0 until the video's first timeupdate).
 * Until then a tap can land while the page reveals a button, and iOS takes such a tap for a hover,
 * with no click (WebKit's content-change observer, actionability.ts; Devices run 42524374628: the
 * delay came up 15 ms after the page took the touchstart of a tap on the chat input). The specs
 * tap anything on the watch page only after this.
 */
export async function watching(phone: Phone): Promise<void> {
  const played = async () => {
    const v = await videoState(phone);
    return v.played > WATCHING_S ? 'watching' : `not yet: ${describeVideo(v)}`;
  };
  await expect.poll(played, { message: `the video plays (more than ${WATCHING_S} s played)` }).toBe('watching');
  await expect.poll(() => isShown(phone, '#delay-wrap'), { message: 'the page shows the delay behind live' }).toBe(true);
  await recordFullscreen(phone);
}

/**
 * Keeps, in the page (`__fullscreenSettled`), what was full screen when the last full-screen
 * change ended: the element at the last fullscreenchange (webkitfullscreenchange), and whether
 * the video showed in iOS's own player at the last webkitbeginfullscreen or webkitendfullscreen.
 * WebKit sets the full-screen element as its animation begins and fires the change once it is
 * over, so while the two differ a change is still running: fullScreenState says "changing" and
 * no tap is made (actionability.ts touchState).
 */
function recordFullscreen(phone: Phone): Promise<void> {
  return phone.evaluate(() => {
    const w = window as unknown as { __fullscreenSettled?: { element: Element | null; player: boolean } };
    if (w.__fullscreenSettled) return;
    const v = document.querySelector('video') as HTMLVideoElement & { webkitDisplayingFullscreen?: boolean };
    const current = () => document.fullscreenElement ?? (document as Document & { webkitFullscreenElement?: Element | null }).webkitFullscreenElement ?? null;
    const settled = { element: current(), player: v.webkitDisplayingFullscreen === true };
    w.__fullscreenSettled = settled;
    const note = () => {
      settled.element = current();
      settled.player = v.webkitDisplayingFullscreen === true;
    };
    for (const type of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(type, note);
    for (const type of ['webkitbeginfullscreen', 'webkitendfullscreen']) v.addEventListener(type, note);
  });
}

/**
 * Waits until the video plays on for `seconds` more by the media's own clock (its `played`
 * ranges), counted from the moment it plays after `step`: not paused, not seeking, with data to go
 * on (readyState 3 or more). A step that changes the playback (a turn, full screen, the
 * background, Unmute, Go live) may pause, seek or rebuffer for a moment; that moment is never
 * counted against it, and a failure says what the element was doing.
 */
export async function playsOn(phone: Phone, seconds: number, step: string): Promise<void> {
  let from: VideoState | null = null;
  const playing = async () => {
    const v = await videoState(phone);
    if (v.paused || v.seeking || v.readyState < 3) return `not yet: ${describeVideo(v)}`;
    from = v;
    return 'playing';
  };
  await expect.poll(playing, { message: `after ${step}: the video plays` }).toBe('playing');
  const playedOn = async () => {
    const v = await videoState(phone);
    const more = v.played - from!.played;
    return more > seconds ? 'played on' : `not yet: ${more.toFixed(2)} s more; ${describeVideo(v)}`;
  };
  await expect.poll(playedOn, { message: `after ${step}: the video plays on for more than ${seconds} s` }).toBe('played on');
}

/**
 * The player's state for a failed test's report: the element, the page's lines and hls.js's view
 * (each playlist's first and last media sequence numbers, what its stream controllers do, the
 * source buffers it made). hls.js's controllers are its internals: read for the report, never checked.
 */
export function playerReport(phone: Phone): Promise<string> {
  return phone.evaluate(() => {
    const ranges = (r: TimeRanges) => Array.from({ length: r.length }, (_, i) => [r.start(i), r.end(i)]);
    const v = document.querySelector('video');
    const el = (id: string) => document.getElementById(id);
    type Playlist = { details?: { startSN?: number; endSN?: number } };
    type Controller = { state?: unknown; nextLoadPosition?: unknown; startPosition?: unknown; fragCurrent?: { sn?: unknown; type?: string } | null };
    type Hls = { latency?: number; liveSyncPosition?: number | null; levels?: Playlist[]; audioTracks?: Playlist[]; streamController?: Controller; audioStreamController?: Controller; bufferController?: { sourceBuffers?: object } };
    const h = (window as unknown as { __hls?: Hls }).__hls;
    const controller = (c: Controller | undefined) => c && { state: c.state, nextLoadPosition: c.nextLoadPosition, startPosition: c.startPosition, fragCurrent: c.fragCurrent ? `${c.fragCurrent.type}/${String(c.fragCurrent.sn)}` : null };
    return JSON.stringify({
      page: location.pathname,
      status: el('status')?.textContent,
      overlay: el('overlay')?.hidden === false ? el('overlay')!.textContent : null,
      video: v && { readyState: v.readyState, networkState: v.networkState, error: v.error && { code: v.error.code, message: v.error.message }, paused: v.paused, muted: v.muted, seeking: v.seeking, currentTime: v.currentTime, buffered: ranges(v.buffered), seekable: ranges(v.seekable), played: ranges(v.played) },
      hls: h && {
        latency: h.latency,
        liveSyncPosition: h.liveSyncPosition,
        video: h.levels?.map((l) => [l.details?.startSN, l.details?.endSN]),
        audio: h.audioTracks?.map((t) => [t.details?.startSN, t.details?.endSN]),
        stream: controller(h.streamController),
        audioStream: controller(h.audioStreamController),
        sourceBuffers: h.bufferController?.sourceBuffers ? Object.keys(h.bufferController.sourceBuffers) : null,
      },
    });
  });
}

/** How long the join page may take to answer with the watch page (a browser check included), as fixtures.ts join(). */
const JOIN_MS = 60_000;

/** Whether an element is shown (not [hidden], laid out), by CSS selector. */
export function isShown(phone: Phone, selector: string): Promise<boolean> {
  return phone.evaluate((s) => {
    const el = document.querySelector(s);
    return !!el && !(el as HTMLElement).hidden && el.getClientRects().length > 0;
  }, selector);
}

/** The text in a form field. */
export function fieldValue(phone: Phone, selector: string): Promise<string | null> {
  return phone.evaluate((s) => (document.querySelector(s) as HTMLInputElement | HTMLTextAreaElement | null)?.value ?? null, selector);
}

/** The join page's own state, for a join that never reached the watch page (which step it stopped at). */
function joinPageState(phone: Phone): Promise<string> {
  return phone
    .evaluate(() => {
      const el = (id: string) => document.getElementById(id);
      return JSON.stringify({
        url: location.pathname,
        readyState: document.readyState,
        button: { disabled: (el('join') as HTMLButtonElement | null)?.disabled },
        check: { hidden: el('check')?.hidden, progress: (el('check-progress') as HTMLProgressElement | null)?.value },
        error: el('error')?.hidden ? null : el('error')?.textContent,
      });
    })
    .catch((e: Error) => `unavailable (${e.message})`);
}

/** What the join page showed once the nickname was typed, the on-screen keyboard still up. */
export interface Joined {
  nicknameInSight: boolean;
  watchInSight: boolean;
}

/**
 * Waits until the join page takes a viewer's input: "Watch" enabled, which join.ts does once
 * it handles the form and the page is shown (join-form.ts), as the e2e harness types only then
 * (fixtures.ts joinFrom). The address says /join as soon as the browser commits the page, while
 * its document is still being parsed: the head's stylesheet holds the startup guard's inline
 * script, and the parser with it, so there is no <body> and no nickname field until that
 * stylesheet has arrived (Devices run 42286829225: "MutationObserver.observe: parameter 1 is
 * not of type 'Node'" on document.body). A page that lost a script on the way reloads itself
 * before that (its startup guard), so nothing typed is lost with the page it replaces.
 */
export async function joinPageReady(phone: Phone): Promise<void> {
  await expect
    .poll(
      async () => {
        // A join page that lost a script reloads itself: an evaluate can meet no page for a moment.
        const ready = await phone.evaluate(() => (document.getElementById('join') as HTMLButtonElement | null)?.disabled === false).catch(() => false);
        return ready ? 'ready' : `not yet: ${await joinPageState(phone)}`;
      },
      { message: 'the join page takes input (Watch enabled)' },
    )
    .toBe('ready');
}

/**
 * Checks that the test's first page starts as a viewer's does: shown, in the orientation the
 * phone holds (upright: the device fixtures turn it back before each test), at zoom 1, nothing
 * full screen. A state an earlier test left (a turn, a zoom) fails here, not in a later check.
 */
export async function pageAtRest(phone: Phone): Promise<void> {
  const wanted = JSON.stringify({ visibility: 'visible', landscape: phone.orientation === 'landscape', zoom: 1, fullscreen: false });
  const state = () =>
    phone.evaluate(() => {
      const fullscreen = document.fullscreenElement ?? (document as Document & { webkitFullscreenElement?: Element | null }).webkitFullscreenElement;
      return JSON.stringify({ visibility: document.visibilityState, landscape: matchMedia('(orientation: landscape)').matches, zoom: window.visualViewport!.scale, fullscreen: !!fullscreen });
    });
  await expect.poll(state, { message: 'the page starts shown, upright, at zoom 1, nothing full screen' }).toBe(wanted);
}

/**
 * Opens the live link on the phone, picks the nickname with the on-screen keyboard and taps
 * Watch, then waits for the watch page. A join page that shows an error fails at once with it.
 */
export async function joinOnPhone(phone: Phone, nickname: string, link: string): Promise<Joined> {
  await phone.open(link);
  await expect.poll(() => phone.url(), { message: 'the live link opens the join page' }).toMatch(/\/join$/);
  await joinPageReady(phone);
  await pageAtRest(phone);
  await tapToType(phone, '#nickname');
  await phone.type('#nickname', nickname);
  await expect.poll(() => fieldValue(phone, '#nickname'), { message: 'the nickname is in the field' }).toBe(nickname);
  await still(phone);
  const seen = { nicknameInSight: await inSight(phone, '#nickname'), watchInSight: await inSight(phone, '#join') };
  await phone.tap('#join');
  // Polled until the watch page or a refusal (which fails at once); while neither, the value
  // is the join page's state, so a timeout says which step the page never finished.
  let outcome = '';
  await expect
    .poll(
      async () => {
        if ((await phone.url()).endsWith('/watch')) return (outcome = 'watch');
        const state = await joinPageState(phone);
        outcome = state.includes('"error":"') ? `refused: ${state}` : `waiting: ${state}`;
        return outcome;
      },
      { timeout: JOIN_MS, message: `join as "${nickname}"` },
    )
    .toMatch(/^(watch|refused)/);
  expect(outcome, `join as "${nickname}"`).toBe('watch');
  // The address changes before the watch page has loaded (Safari: "null is not an object
  // (evaluating 'v.played')" right after, Devices run 41227486868).
  const loaded = () => phone.evaluate(() => document.readyState === 'complete' && !!document.querySelector('video')).catch(() => false);
  await expect.poll(loaded, { message: 'the watch page has loaded' }).toBe(true);
  return seen;
}

/** The rectangles the layout checks compare, in CSS pixels of the page (layout viewport). */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function box(phone: Phone, selector: string): Promise<Box | null> {
  return phone.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, selector);
}

/** The visible part of the page (the visual viewport: what the on-screen keyboard leaves), against the layout viewport. */
export interface Viewport {
  innerWidth: number;
  innerHeight: number;
  /** How far the page is scrolled (the layout viewport's top). */
  scrollY: number;
  top: number;
  height: number;
  scale: number;
  landscape: boolean;
}

export function viewport(phone: Phone): Promise<Viewport> {
  return phone.evaluate(() => {
    const vv = window.visualViewport!;
    return { innerWidth, innerHeight, scrollY, top: vv.offsetTop, height: vv.height, scale: vv.scale, landscape: matchMedia('(orientation: landscape)').matches };
  });
}

/**
 * Waits until the page has stopped moving: two viewport readings in a row alike (size, scroll,
 * zoom). Typing moves it too: Chrome scrolls and zooms to keep the caret readable.
 */
export async function still(phone: Phone): Promise<void> {
  let previous = '';
  await expect
    .poll(
      async () => {
        const now = JSON.stringify(await viewport(phone));
        const same = now === previous;
        previous = now;
        return same;
      },
      { message: 'the page has stopped moving' },
    )
    .toBe(true);
}

/** CSS pixels an on-screen keyboard takes at least (Gboard on the Pixel 7 emulator: 312). */
export const KEYBOARD_MIN_PX = 150;

/**
 * Taps a text field and waits until the field can be typed in: the tap reached it as a finger's
 * (trusted touch events on it) and it has focus; where a tap raises the on-screen keyboard
 * (`onScreenKeyboard`), the system reports the keyboard shown and it covers the page, the visible
 * part (the visual viewport, on screen) at least KEYBOARD_MIN_PX shorter than the page (the layout
 * viewport); and the page has stopped moving, two readings in a row alike. The keyboard slides in
 * after the tap and the browser then scrolls (Chrome also zooms) the field into view, and a tap
 * computed while that moves lands off target (it missed Watch once).
 *
 * The state is what counts, not a change across the tap: the keyboard may already be up when the
 * tap comes. Chrome raises it for a focus the page gives a field itself (the join page's
 * autofocus) once the page has had a user gesture, and on Android the join page has one before
 * any tap: Chrome gives it as the page finishes loading, and Playwright's page.evaluate is one
 * too. An autofocus that comes after it raises the keyboard by itself (Devices run 42307812551;
 * docs/TESTING.md "Real devices"). The viewer pages keep Chrome's default for the keyboard (no
 * interactive-widget in their viewport meta): it covers the page and shrinks the visual viewport
 * only. While waiting, the polled value says what the page and the system show.
 */
export async function tapToType(phone: Phone, selector: string): Promise<void> {
  await recordInput(phone);
  await phone.tap(selector);
  await expect
    .poll(async () => ((await touchedAndFocused(phone, selector)) ? 'touched' : `not yet: focus: ${await focused(phone)}; the tap reached the page as: ${await inputEvents(phone)}`), {
      message: `a finger's tap reached ${selector} and focused it`,
    })
    .toBe('touched');
  if (!phone.onScreenKeyboard) {
    await still(phone);
    return;
  }
  let previous = '';
  await expect
    .poll(
      async () => {
        const v = await viewport(phone);
        const now = JSON.stringify(v);
        const covered = v.innerHeight - v.height * v.scale;
        const shown = await phone.keyboardShown();
        const hasFocus = await phone.evaluate((s) => document.activeElement === document.querySelector(s), selector);
        const up = shown && hasFocus && covered > KEYBOARD_MIN_PX && now === previous;
        previous = now;
        if (up) return 'up';
        return `not yet: keyboard ${shown ? 'shown' : 'not shown'} (${await phone.keyboardState()}); visible ${Math.round(v.height * v.scale)} of the page's ${v.innerHeight} px (zoom ${v.scale}); focus: ${await focused(phone)}; the tap reached the page as: ${await inputEvents(phone)}`;
      },
      { message: `the on-screen keyboard is up for ${selector} and the page has stopped moving` },
    )
    .toBe('up');
}

/**
 * Records the input events the page receives from now on (type, target, and "untrusted" for one
 * a script made), for a failure message: whether a tap reached the page as a finger does.
 * The join page focuses the nickname field itself (autofocus), so focus alone says nothing.
 */
function recordInput(phone: Phone): Promise<void> {
  return phone.evaluate(() => {
    const w = window as unknown as { __input?: string[]; __touched?: Element[]; __inputListening?: boolean; __changes?: Record<string, number> };
    w.__input = [];
    w.__touched = [];
    w.__changes = {};
    if (w.__inputListening) return;
    w.__inputListening = true;
    // What the page changed meanwhile (iOS drops the click of a tap when content appears in response to it).
    new MutationObserver((list) => {
      for (const m of list) {
        const t = (m.target.nodeType === 1 ? m.target : m.target.parentElement) as Element | null;
        const key = `${m.type}@${t?.id || t?.getAttribute?.('data-testid') || t?.className || t?.tagName?.toLowerCase() || '?'}${m.attributeName ? `[${m.attributeName}]` : ''}`;
        if (w.__changes) w.__changes[key] = (w.__changes[key] ?? 0) + 1;
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    for (const type of ['touchstart', 'touchend', 'pointerdown', 'pointerup', 'mousedown', 'click', 'focusin', 'focusout']) {
      window.addEventListener(
        type,
        (e) => {
          const t = e.target as Element | null;
          w.__input?.push(`${type}@${t?.id || t?.tagName?.toLowerCase() || '?'}${e.isTrusted ? '' : ' untrusted'}${e instanceof PointerEvent ? ` (${e.pointerType})` : ''}`);
          if (type === 'touchend' && e.isTrusted && t) w.__touched?.push(t);
        },
        // Passive (the viewer pages have no touch listeners of their own): WebKit treats a touch
        // listener that may call preventDefault as a synchronous handler and holds the tap until
        // the web process has run it. Window's touchstart is passive by default, touchend is not.
        { capture: true, passive: true },
      );
    }
  });
}

/** Since recordInput(): a trusted touch ended on the element (or inside it), and the element has focus. */
function touchedAndFocused(phone: Phone, selector: string): Promise<boolean> {
  return phone.evaluate((s) => {
    const el = document.querySelector(s);
    const touched = (window as unknown as { __touched?: Element[] }).__touched ?? [];
    return !!el && document.activeElement === el && touched.some((t) => t === el || el.contains(t));
  }, selector);
}

function inputEvents(phone: Phone): Promise<string> {
  return phone.evaluate(() => {
    const w = window as unknown as { __input?: string[]; __changes?: Record<string, number> };
    const changes = Object.entries(w.__changes ?? {})
      .map(([k, n]) => `${k} x${n}`)
      .join(', ');
    return `${w.__input?.join(', ') || '(none)'}; page changes since: ${changes || '(none)'}`;
  });
}

/** The focused element as `tag#id` (`body` when nothing has focus), for a failure message. */
function focused(phone: Phone): Promise<string> {
  return phone.evaluate(() => {
    const el = document.activeElement;
    return el ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}` : '(none)';
  });
}

/**
 * What the page went through while the tests looked away (the app in the background, where
 * neither driver can read the page): visibility and lifecycle changes and the video's play and
 * pause, in order. `recordLifecycle` starts the record, `lifecycle` reads it.
 */
export function recordLifecycle(phone: Phone): Promise<void> {
  return phone.evaluate(() => {
    const w = window as unknown as { __lifecycle?: string[] };
    if (w.__lifecycle) return;
    const log: string[] = [];
    w.__lifecycle = log;
    const v = document.querySelector('video')!;
    document.addEventListener('visibilitychange', () => log.push(document.visibilityState));
    for (const e of ['pagehide', 'pageshow', 'freeze', 'resume']) window.addEventListener(e, () => log.push(e));
    for (const e of ['pause', 'playing']) v.addEventListener(e, () => log.push(`video ${e}`));
  });
}

export function lifecycle(phone: Phone): Promise<string[]> {
  return phone.evaluate(() => [...((window as unknown as { __lifecycle?: string[] }).__lifecycle ?? [])]);
}

/** The whole element lies in the visible part of the page (above the on-screen keyboard, when it is up). */
export function inSight(phone: Phone, selector: string): Promise<boolean> {
  return phone.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const vv = window.visualViewport!;
    return r.top >= vv.offsetTop - 1 && r.bottom <= vv.offsetTop + vv.height + 1 && r.left >= vv.offsetLeft - 1 && r.right <= vv.offsetLeft + vv.width + 1;
  }, selector);
}

/** A chat message with this text is in the chat list and shown. */
export function chatShows(phone: Phone, text: string): Promise<boolean> {
  return phone.evaluate((t) => [...document.querySelectorAll('[data-testid="chat-list"] li.msg')].some((li) => !!li.textContent?.includes(t) && li.getClientRects().length > 0), text);
}

/**
 * The phone's own row for a message it sent: "pending" while the server has not taken it yet
 * ("sending…"), "failed" when refused, "sent" once taken; null before the row shows.
 */
export function ownMessage(phone: Phone, text: string): Promise<'pending' | 'failed' | 'sent' | null> {
  return phone.evaluate((t) => {
    const row = [...document.querySelectorAll('[data-testid="chat-list"] li.msg')].findLast((li) => !!li.textContent?.includes(t));
    if (!row) return null;
    return row.classList.contains('failed') ? 'failed' : row.classList.contains('pending') ? 'pending' : 'sent';
  }, text);
}

/**
 * Taps one of the player's own controls (viewer player-controls.ts). They fade while the video
 * plays, and a touch on a faded control only brings them back (its press is dropped, as in video
 * apps), so a tap timed by a slow simulator could land on them faded. The keyboard focus holds
 * them shown: the control is focused first, then tapped with a finger, which presses it.
 */
export async function tapControl(phone: Phone, selector: string): Promise<void> {
  await phone.evaluate((s) => (document.querySelector(s) as HTMLElement).focus(), selector);
  await expect.poll(() => phone.evaluate(() => !document.querySelector('.player')!.classList.contains('pc-idle')), { message: `the controls show, ${selector} focused` }).toBe(true);
  await phone.tap(selector);
}

/** What the player's own controls show and what the page may do with the video here. */
export function playerUi(phone: Phone): Promise<{ nativeControls: boolean; bar: boolean; volumeSlider: boolean; volumeApi: boolean; elementFullscreen: boolean; pipButton: boolean; pipApi: boolean; play: string }> {
  return phone.evaluate(() => {
    const v = document.querySelector('video') as HTMLVideoElement & { webkitSupportsPresentationMode?: (m: string) => boolean };
    const shown = (sel: string): boolean => {
      const el = document.querySelector<HTMLElement>(sel);
      return !!el && !el.hidden && el.getClientRects().length > 0;
    };
    // Whether this browser lets a page set the volume: set it, read it back, put it back. Apple's
    // guide says iOS keeps it read-only (always 1); the iOS 26 Simulator accepts it (Devices run
    // 41507746407), so the check asks the browser, as the page does.
    const before = v.volume;
    const probe = before > 0.5 ? before - 0.25 : before + 0.25;
    v.volume = probe;
    const volumeApi = Math.abs(v.volume - probe) < 0.01;
    v.volume = before;
    const player = document.querySelector('.player') as HTMLElement & { webkitRequestFullscreen?: unknown };
    return {
      volumeApi,
      // As player-caps.ts fullscreenMode decides: the container can go full screen.
      elementFullscreen: (typeof player.requestFullscreen === 'function' && document.fullscreenEnabled !== false) || (typeof player.webkitRequestFullscreen === 'function' && (document as Document & { webkitFullscreenEnabled?: boolean }).webkitFullscreenEnabled !== false),
      nativeControls: v.hasAttribute('controls'),
      bar: shown('[data-testid="controls"]'),
      // The slider's own switch (hidden where the page cannot set the volume), not the narrow-screen CSS.
      volumeSlider: !document.querySelector<HTMLElement>('[data-testid="volume"]')!.hidden,
      pipButton: !document.querySelector<HTMLElement>('[data-testid="pip"]')!.hidden,
      pipApi: document.pictureInPictureEnabled === true || v.webkitSupportsPresentationMode?.('picture-in-picture') === true,
      play: document.querySelector('[data-testid="play"] .pc-sr')?.textContent ?? '',
    };
  });
}

/**
 * What is full screen: the player container, iOS's own player (the video alone), or nothing; and
 * "changing" while a change the page asked for has not ended yet (recordFullscreen).
 */
export function fullScreenState(phone: Phone): Promise<'player' | 'ios-player' | 'other' | 'changing' | null> {
  return phone.evaluate(() => {
    const v = document.querySelector('video') as HTMLVideoElement & { webkitDisplayingFullscreen?: boolean };
    const el = document.fullscreenElement ?? (document as Document & { webkitFullscreenElement?: Element | null }).webkitFullscreenElement ?? null;
    const settled = (window as unknown as { __fullscreenSettled?: { element: Element | null; player: boolean } }).__fullscreenSettled;
    if (settled && (settled.element !== el || settled.player !== (v.webkitDisplayingFullscreen === true))) return 'changing';
    if (el) return el === document.querySelector('.player') ? 'player' : 'other';
    return v.webkitDisplayingFullscreen === true ? 'ios-player' : null;
  });
}

/** The "Go live" button: its text and how many seconds behind the live point it says the viewer is. */
export function goLive(phone: Phone): Promise<{ text: string; behind: number | null }> {
  return phone.evaluate(() => {
    const b = document.getElementById('golive')!;
    return { text: b.hidden ? '' : (b.textContent ?? '').trim(), behind: b.dataset.behind ? Number(b.dataset.behind) : null };
  });
}
