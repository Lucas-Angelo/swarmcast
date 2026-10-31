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
  /** A finger tap in the middle of the element, scrolled into view first. Taps raise the on-screen keyboard. */
  tap(selector: string): Promise<void>;
  /** Types into the element (tap it first), as the on-screen keyboard does. */
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
  /** Ends the test's browser session. */
  close(): Promise<void>;
}

/** The video element's playback, as the specs check it. */
export interface VideoState {
  paused: boolean;
  muted: boolean;
  /** Seconds really played (the `played` ranges): hls.js seeks before the first frame plays. */
  played: number;
  currentTime: number;
}

export function videoState(phone: Phone): Promise<VideoState> {
  return phone.evaluate(() => {
    const v = document.querySelector('video')!;
    let played = 0;
    for (let i = 0; i < v.played.length; i++) played += v.played.end(i) - v.played.start(i);
    return { paused: v.paused, muted: v.muted, played, currentTime: v.currentTime };
  });
}

/** Seconds played since `from` (a videoState read earlier), once the video is not paused; 0 while paused. */
export async function playedSince(phone: Phone, from: VideoState): Promise<number> {
  const now = await videoState(phone);
  return now.paused ? 0 : now.played - from.played;
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
 * Opens the live link on the phone, picks the nickname with the on-screen keyboard and taps
 * Watch, then waits for the watch page. A join page that shows an error fails at once with it.
 */
export async function joinOnPhone(phone: Phone, nickname: string, link: string): Promise<Joined> {
  await phone.open(link);
  await expect.poll(() => phone.url(), { message: 'the live link opens the join page' }).toMatch(/\/join$/);
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
 * Taps a text field and waits until the on-screen keyboard it raised is up and the page has
 * stopped moving. On a phone with no on-screen keyboard under automation (`onScreenKeyboard`
 * false: the iOS Simulator), it waits instead for the tap to reach the field as a finger's
 * (trusted touch events on it) and the field to have focus, then for the page to stop moving. Up: the visible part of the page (the visual viewport) is at least a keyboard
 * shorter than before the tap. That holds whether the browser only covers the page (Chrome's
 * default, Safari) or resizes it (a page with interactive-widget=resizes-content, where the
 * layout viewport shrinks with it). The keyboard slides in after the tap and the browser then
 * scrolls (Chrome also zooms) the field into view, and a tap computed while that moves lands off
 * target (it missed Watch once), so this also waits for two readings in a row alike. While
 * waiting, the polled value says what the page and the system show.
 */
export async function tapToType(phone: Phone, selector: string): Promise<void> {
  const before = await viewport(phone);
  await recordInput(phone);
  if (!phone.onScreenKeyboard) {
    // Under test (iOS): the join page's autofocus gives the field focus with no input session;
    // the tap then reaches the field (trusted touch events) but WebKit reports no focused element
    // to UIKit ("disableAutomaticKeyboardUI return empty") and typed keys insert nothing. Does a
    // tap on a field that is not focused yet start the input session?
    await phone.evaluate((s) => {
      const el = document.querySelector(s);
      if (el && document.activeElement === el) (el as HTMLElement).blur();
    }, selector);
  }
  await phone.tap(selector);
  if (!phone.onScreenKeyboard) {
    await expect
      .poll(async () => ((await touchedAndFocused(phone, selector)) ? 'touched' : `not yet: focus: ${await focused(phone)}; the tap reached the page as: ${await inputEvents(phone)}`), {
        message: `a finger's tap reached ${selector} and focused it`,
      })
      .toBe('touched');
    await still(phone);
    return;
  }
  let previous = '';
  await expect
    .poll(
      async () => {
        const v = await viewport(phone);
        const now = JSON.stringify(v);
        const settled = before.height - v.height > KEYBOARD_MIN_PX && now === previous;
        previous = now;
        if (settled) return 'up';
        return `not yet: visible height ${Math.round(before.height)} -> ${Math.round(v.height)}, page height ${before.innerHeight} -> ${v.innerHeight}; focus: ${await focused(phone)}; the tap reached the page as: ${await inputEvents(phone)}; keyboard: ${await phone.keyboardState()}`;
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
    const w = window as unknown as { __input?: string[]; __touched?: Element[]; __inputListening?: boolean };
    w.__input = [];
    w.__touched = [];
    if (w.__inputListening) return;
    w.__inputListening = true;
    for (const type of ['touchstart', 'touchend', 'pointerdown', 'pointerup', 'mousedown', 'click', 'focusin', 'focusout']) {
      window.addEventListener(
        type,
        (e) => {
          const t = e.target as Element | null;
          w.__input?.push(`${type}@${t?.id || t?.tagName?.toLowerCase() || '?'}${e.isTrusted ? '' : ' untrusted'}${e instanceof PointerEvent ? ` (${e.pointerType})` : ''}`);
          if (type === 'touchend' && e.isTrusted && t) w.__touched?.push(t);
        },
        true,
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
  return phone.evaluate(() => (window as unknown as { __input?: string[] }).__input?.join(', ') || '(none)');
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

/** The "Go live" button: its text and how many seconds behind the live point it says the viewer is. */
export function goLive(phone: Phone): Promise<{ text: string; behind: number | null }> {
  return phone.evaluate(() => {
    const b = document.getElementById('golive')!;
    return { text: b.hidden ? '' : (b.textContent ?? '').trim(), behind: b.dataset.behind ? Number(b.dataset.behind) : null };
  });
}

/** Where a finger touches an element, in visual-viewport CSS pixels; see touchPoint(). */
export interface TouchPoint {
  x: number;
  y: number;
  /** From the middle of the element's part inside the layout viewport (W3C's "in-view center point"). */
  dx: number;
  dy: number;
}

/**
 * Where a finger would touch `el` (runs in the page; self-contained, so WebDriver can send its
 * source): the middle of the part of the element the viewer sees, inside the visual viewport,
 * which the on-screen keyboard shrinks; a finger cannot reach the part under the keyboard (the
 * join page's Watch button is half under it while the nickname is typed on a Pixel 7). Null
 * while the element is disabled, shows less than 4 px each way, or something else is on top
 * of that point (Playwright's actionability checks for a click).
 */
export function touchPoint(el: Element): TouchPoint | null {
  if ((el as HTMLButtonElement).disabled) return null;
  const r = el.getBoundingClientRect();
  const vv = window.visualViewport!;
  const left = Math.max(r.left, vv.offsetLeft);
  const right = Math.min(r.right, vv.offsetLeft + vv.width);
  const top = Math.max(r.top, vv.offsetTop);
  const bottom = Math.min(r.bottom, vv.offsetTop + vv.height);
  if (right - left < 4 || bottom - top < 4) return null;
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const hit = document.elementFromPoint(cx, cy);
  if (!hit || !(hit === el || el.contains(hit))) return null;
  const inViewX = (Math.max(r.left, 0) + Math.min(r.right, innerWidth)) / 2;
  const inViewY = (Math.max(r.top, 0) + Math.min(r.bottom, innerHeight)) / 2;
  return { x: (cx - vv.offsetLeft) * vv.scale, y: (cy - vv.offsetTop) * vv.scale, dx: cx - inViewX, dy: cy - inViewY };
}
