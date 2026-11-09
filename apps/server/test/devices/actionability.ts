// One tap, the same way on both phones (android.ts AndroidPhone.tap, ios.ts IosPhone.tap):
//   1. armTap: the page records what the tap delivers (touch, the synthetic mouse events, the
//      click) and every control it reveals meanwhile, in sessionStorage (a tap may navigate);
//   2. actionablePoint: the element is touched only once it is actionable (touchState), read the
//      same before and after two animation frames, so that the browser shows what the page reports;
//   3. the platform's finger: W3C touch actions through safaridriver on iOS, DevTools'
//      Input.dispatchTouchEvent on Android, both the browser's own touch path;
//   4. tapEndsInClick: the tap counts once the page got the click on the element; when it did
//      not, the failure says what arrived, how long the finger was down and what the page
//      revealed during the tap.
// The checks are Playwright's for a click (https://playwright.dev/docs/actionability: attached,
// visible, stable for two animation frames, enabled, receives events, scrolled into view), plus
// what a phone's browser adds:
// - Mobile Safari turns a tap into a click only if no control appears between touchstart and its
//   synthetic mouse move ("if the contents of the page changes on the mousemove event, no
//   subsequent events in the sequence are sent", Apple's Safari Web Content Guide, "Handling
//   Events"). WebKit's ContentChangeObserver watches every style change from touchstart to that
//   mouse move (and 32 ms more for an element that is not a form control): an element that takes
//   clicks and goes from hidden (no box, visibility hidden, opacity 0 on it or on one of its four
//   nearest ancestors) to visible inside the layout viewport makes the tap a hover
//   (WebPage::handleSyntheticClick, ContentChangeObserver::isConsideredActionableContent); so do
//   opacity and left transitions that end with one shown. So the page must reveal nothing while
//   it takes a tap: no such transition runs, and the controls in sight are the same in both
//   readings. What a page reveals on its own clock, a spec waits out by its state (phone.ts watching).
// - WebKit's automation refuses a touch outside the area Safari shows ("move target out of
//   bounds", WebDriver's error for a pointer moved outside the viewport), and Safari learns a new
//   page's area from its first frame only: hence the two frames.
// - Mobile Safari makes the click at once ("fast tap") only at the initial scale of a
//   `width=device-width` page (https://webkit.org/blog/5610/more-responsive-tapping-on-ios/);
//   zoomed, it waits to see whether a second tap follows. iOS taps need zoom 1.
// - The page in the orientation the phone was turned to: a turn the page has not answered yet
//   moves everything after the point was read.
import { expect } from '../e2e/fixtures.js';
import type { Phone } from './phone.js';

/** Where a finger touches an element, in visual-viewport CSS pixels; see touchState(). */
export interface TouchPoint {
  x: number;
  y: number;
  /** From the middle of the element's part inside the layout viewport (W3C's "in-view center point"). */
  dx: number;
  dy: number;
  /** In layout-viewport CSS pixels (getBoundingClientRect's), W3C's "viewport" origin. */
  clientX: number;
  clientY: number;
}

/** What a tap needs the page to show (touchState's second argument). */
export interface TouchWanted {
  /** The orientation the phone was turned to (Phone.orientation). */
  landscape: boolean;
  /** iOS: the page at zoom 1, where Safari clicks at once (no wait for a double tap). */
  initialScale: boolean;
}

/** What must not change between two readings of touchState: where to touch, the visible part of the page, the controls in sight. */
export interface TouchScene {
  point: TouchPoint;
  viewport: string;
  controls: string[];
}

export type TouchState = { why: string } | { why: null; scene: TouchScene };

/**
 * Whether a finger can tap `el` now, and where (runs in the page; self-contained, so WebDriver can
 * send its source): `why` names the first check that fails. The point is the middle of the part of
 * the element the viewer sees, inside the visual viewport, which the on-screen keyboard shrinks
 * (the join page's Watch button is half under Gboard while the nickname is typed on a Pixel 7).
 * The controls are the visible elements in the layout viewport that take clicks, as WebKit's
 * content-change observer counts them; its rule asks for click listeners, which a page cannot
 * read, so the elements that take clicks by what they are stand for them.
 */
export function touchState(el: Element, wanted: TouchWanted): TouchState {
  const CONTROLS = 'a[href],button,input,select,textarea,summary,label,[role=button],[role=link],[role=menuitem],[role=menuitemradio],[role=checkbox],[role=switch],[tabindex]:not([tabindex="-1"])';
  const name = (e: Element) => e.id || e.getAttribute('data-testid') || e.tagName.toLowerCase();
  // WebKit's hidden (ContentChangeObserver::isVisuallyHidden): no box, visibility or opacity, or a
  // transparent ancestor among the four nearest; and 1 px or less is not visible either.
  const hidden = (e: Element): boolean => {
    if (!e.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return true;
    let up = e.parentElement;
    for (let i = 0; up && i < 4; up = up.parentElement, i++) if (getComputedStyle(up).opacity === '0') return true;
    const r = e.getBoundingClientRect();
    return r.width <= 1 || r.height <= 1;
  };
  const inLayoutViewport = (e: Element) => {
    const r = e.getBoundingClientRect();
    return r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
  };
  if (!el.isConnected) return { why: 'not in the page (detached)' };
  if (document.visibilityState !== 'visible') return { why: `the page is ${document.visibilityState}` };
  const landscape = matchMedia('(orientation: landscape)').matches;
  if (landscape !== wanted.landscape) return { why: `the page is ${landscape ? 'landscape' : 'portrait'}, the phone was turned ${wanted.landscape ? 'landscape' : 'portrait'} (the turn has not reached the page)` };
  const vv = window.visualViewport!;
  if (wanted.initialScale && vv.scale !== 1) return { why: `zoomed to ${vv.scale}: off its initial scale Safari waits for a double tap` };
  if ((el as HTMLButtonElement).disabled || el.closest('[inert], [aria-disabled="true"], fieldset[disabled]')) return { why: 'disabled' };
  if (hidden(el)) return { why: 'not visible' };
  // Playwright's "stable" also means not animating: a box that moves or fades under the finger.
  for (const a of document.getAnimations()) {
    if (a.playState !== 'running') continue;
    const target = (a.effect as KeyframeEffect | null)?.target ?? null;
    const what = a instanceof CSSTransition ? `the ${a.transitionProperty} transition` : a instanceof CSSAnimation ? `the animation ${a.animationName}` : 'an animation';
    if (target && (target === el || target.contains(el)) && a.effect?.getComputedTiming().iterations !== Infinity) return { why: `${what} runs on ${name(target)}` };
    // An opacity or left transition anywhere may end with a control shown: WebKit watches both.
    if (a instanceof CSSTransition && (a.transitionProperty === 'opacity' || a.transitionProperty === 'left')) return { why: `${what} runs on ${target ? name(target) : '?'}` };
  }
  const r = el.getBoundingClientRect();
  const left = Math.max(r.left, vv.offsetLeft);
  const right = Math.min(r.right, vv.offsetLeft + vv.width);
  const top = Math.max(r.top, vv.offsetTop);
  const bottom = Math.min(r.bottom, vv.offsetTop + vv.height);
  if (right - left < 4 || bottom - top < 4) return { why: 'out of sight (less than 4 px of it in the visible part of the page)' };
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const hit = document.elementFromPoint(cx, cy);
  if (!hit || !(hit === el || el.contains(hit))) return { why: `covered at (${Math.round(cx)}, ${Math.round(cy)}) by ${hit ? name(hit) : 'nothing'}` };
  const inViewX = (Math.max(r.left, 0) + Math.min(r.right, innerWidth)) / 2;
  const inViewY = (Math.max(r.top, 0) + Math.min(r.bottom, innerHeight)) / 2;
  const controls = [...document.querySelectorAll(CONTROLS)].filter((e) => !hidden(e) && inLayoutViewport(e)).map(name);
  const point = { x: (cx - vv.offsetLeft) * vv.scale, y: (cy - vv.offsetTop) * vv.scale, dx: cx - inViewX, dy: cy - inViewY, clientX: cx, clientY: cy };
  const viewport = `${innerWidth}x${innerHeight}, visible ${vv.width}x${vv.height} at (${vv.offsetLeft}, ${vv.offsetTop}), zoom ${vv.scale}, ${landscape ? 'landscape' : 'portrait'}`;
  return { why: null, scene: { point, viewport, controls } };
}

/** Resolves in the page once it has run two animation frames (runs in the page; self-contained). */
function twoFrames(): Promise<null> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))));
}

/** What differs between two scenes, for a failure message; '' when they are alike. */
function sceneChange(a: TouchScene, b: TouchScene): string {
  const changes: string[] = [];
  const p = a.point;
  const q = b.point;
  if (p.x !== q.x || p.y !== q.y || p.clientX !== q.clientX || p.clientY !== q.clientY) changes.push(`moved from (${p.clientX}, ${p.clientY}) to (${q.clientX}, ${q.clientY})`);
  if (a.viewport !== b.viewport) changes.push(`the page went from ${a.viewport} to ${b.viewport}`);
  const shown = b.controls.filter((c) => !a.controls.includes(c));
  const gone = a.controls.filter((c) => !b.controls.includes(c));
  if (shown.length > 0 || gone.length > 0) changes.push(`controls shown: ${shown.join(', ') || 'none'}; gone: ${gone.join(', ') || 'none'}`);
  return changes.join('; ');
}

/**
 * Where to tap the element, once it is actionable (touchState, read by `read`) and the browser
 * shows the page as the page reports it: the same scene (point, visible part of the page, controls
 * in sight) before and after two animation frames, Playwright's "stable". A finger lands where the
 * screen shows the page, and the browser follows the page a frame later. On iOS Safari takes the
 * touch: WebKit's automation checks the point against the area Safari shows
 * (WebAutomationSession::simulateTouchInteraction, WebPageProxy::unobscuredContentRect), which a
 * navigation to a new web process (the viewer pages send Cross-Origin-Opener-Policy) resets until
 * the new page's first frame (release-rehearsal run 42508591582: "move target out of bounds" 147 ms
 * after the load event), and Safari hit-tests in its own copy of the page's layers (after a
 * scrollIntoView the tap reached what the screen still showed). WebKit runs a page's next frame
 * only once Safari has taken the previous one (RemoteLayerTreeDrawingArea waits for
 * DisplayDidRefresh), so when the second frame runs Safari has the first, drawn after the first
 * reading. While waiting, the polled value says why the element cannot be tapped yet.
 */
export async function actionablePoint(phone: Phone, selector: string, read: () => Promise<TouchState>): Promise<TouchPoint> {
  let point: TouchPoint | null = null;
  const actionable = async () => {
    const before = await read();
    if (before.why !== null) return `not yet: ${before.why}`;
    await phone.evaluate(twoFrames);
    const after = await read();
    if (after.why !== null) return `not yet: ${after.why} (after two frames)`;
    const change = sceneChange(before.scene, after.scene);
    if (change) return `not yet: in two frames ${change}`;
    point = after.scene.point;
    return 'actionable';
  };
  await expect.poll(actionable, { message: `${selector} can be tapped: in the page, visible, enabled, in sight, not covered, nothing animating or appearing, the same before and after two frames` }).toBe('actionable');
  return point!;
}

/**
 * Starts the page's record of a tap on `el` (runs in the page; self-contained): each trusted
 * touchstart, touchend, mouseover, mousedown and click, with the element it reached when that is
 * not `el`, its time stamp and when the page handled it; and `shown>element` for a control that
 * becomes visible (touchState's rule), checked on every change of the document and every frame
 * for 10 s. Kept in sessionStorage, which outlives a navigation the tap causes. Passive listeners:
 * a touch listener that may call preventDefault makes the browser wait for the page before it
 * decides the tap.
 */
export function armTap(el: Element): void {
  const CONTROLS = 'a[href],button,input,select,textarea,summary,label,[role=button],[role=link],[role=menuitem],[role=menuitemradio],[role=checkbox],[role=switch],[tabindex]:not([tabindex="-1"])';
  const w = window as unknown as { __tapStop?: () => void };
  w.__tapStop?.();
  sessionStorage.setItem('__tap', '');
  const name = (t: EventTarget | null) => (t instanceof Element ? (t.id || t.getAttribute('data-testid') || t.tagName.toLowerCase()).replace(/[\s@>:]/g, '_') : '?');
  const now = () => Math.round(performance.timeOrigin + performance.now());
  const add = (entry: string) => sessionStorage.setItem('__tap', `${sessionStorage.getItem('__tap') ?? ''}${entry} `);
  const note = (e: Event) => {
    if (e.isTrusted) add(`${e.type}${e.target === el || el.contains(e.target as Node) ? '' : `>${name(e.target)}`}@${Math.round(performance.timeOrigin + e.timeStamp)}:${now()}`);
  };
  // touchState's hidden, and outside the layout viewport counts as hidden (WebKit drops those).
  const hidden = (e: Element): boolean => {
    if (!e.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return true;
    let up = e.parentElement;
    for (let i = 0; up && i < 4; up = up.parentElement, i++) if (getComputedStyle(up).opacity === '0') return true;
    const r = e.getBoundingClientRect();
    return r.width <= 1 || r.height <= 1 || r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight;
  };
  const visible = () => new Set([...document.querySelectorAll(CONTROLS)].filter((e) => !hidden(e)));
  let seen = visible();
  const check = () => {
    const shown = visible();
    for (const e of shown) if (!seen.has(e)) add(`shown>${name(e)}@${now()}:${now()}`);
    seen = shown;
  };
  const types = ['touchstart', 'touchend', 'mouseover', 'mousedown', 'click'];
  for (const type of types) window.addEventListener(type, note, { capture: true, passive: true });
  const changes = new MutationObserver(check);
  changes.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
  let frame = 0;
  const everyFrame = () => {
    check();
    frame = requestAnimationFrame(everyFrame);
  };
  frame = requestAnimationFrame(everyFrame);
  const stop = () => {
    changes.disconnect();
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    for (const type of types) window.removeEventListener(type, note, true);
  };
  const timer = setTimeout(stop, 10_000);
  w.__tapStop = stop;
}

/** The entries armTap records. */
const TAP_TYPES = ['touchstart', 'touchend', 'mouseover', 'mousedown', 'click', 'shown'] as const;

/**
 * One entry of a tap's record: its type, the element it reached when that was not the tapped one
 * (for `shown`, the element revealed), its time stamp and when the page handled it (epoch ms).
 */
export interface TapEvent {
  type: (typeof TAP_TYPES)[number] | '?';
  elsewhere?: string;
  stamp: number;
  handled: number;
}

/**
 * The page's record (`type[>element]@stamp:handled ...`). It comes from the page, so the type is
 * taken from TAP_TYPES and the times are numbers; only an element's name is the page's own text,
 * and describeTap leaves it out of what is written to taps.log.
 */
export function parseTapEvents(record: string): TapEvent[] {
  return record
    .split(' ')
    .filter(Boolean)
    .map((entry) => {
      const [what = '', times = ''] = entry.split('@');
      const [raw = '', elsewhere] = what.split('>');
      const [stamp = NaN, handled = NaN] = times.split(':').map(Number);
      return { type: TAP_TYPES.find((t) => t === raw) ?? '?', ...(elsewhere === undefined ? {} : { elsewhere }), stamp, handled };
    });
}

/**
 * What a tap delivered and when, for the log and a failure message: the events in order, the
 * finger's time down (touchstart to touchend, by the events' time stamps and by when the page
 * handled them) and the click's delay after touchend. "click" appears only when one arrived on the
 * element; one elsewhere is "click>element" ("click>elsewhere" without `names`, for the file). A
 * touch that ended in no click names the controls the page revealed from touchstart on, and
 * whether WebKit took the tap for a hover (moved the mouse, pressed nothing).
 */
export function describeTap(events: readonly TapEvent[], started: number, performed: number, names = true): string {
  const own = (type: string) => events.find((e) => e.type === type && e.elsewhere === undefined);
  const down = own('touchstart');
  const up = own('touchend');
  const click = own('click');
  const label = (e: TapEvent) => (e.elsewhere === undefined ? e.type : `${e.type}>${names ? e.elsewhere : e.type === 'shown' ? 'element' : 'elsewhere'}`);
  // What the page revealed before the touch is not the tap's business: actionablePoint waited it out.
  const during = events.filter((e) => e.type !== 'shown' || (down !== undefined && e.handled >= down.handled));
  const parts = [`events: ${during.map(label).join(', ') || '(none)'}`, `actions performed in ${performed - started} ms`];
  if (down) parts.push(`touchstart ${down.handled - started} ms after the actions began`);
  if (down && up) parts.push(`finger down ${up.stamp - down.stamp} ms by time stamps, ${up.handled - down.handled} ms as handled`);
  if (up && click) parts.push(`then the click ${click.handled - up.handled} ms after touchend`);
  if (down && !click) {
    const over = own('mouseover');
    const shown = during.filter((e) => e.type === 'shown').map((e) => (names ? e.elsewhere : 'an element'));
    const revealed = shown.length > 0 ? `the page revealed ${shown.join(', ')} during the tap` : '';
    if (over && !own('mousedown')) parts.push(`taken for a hover (mouse moved, no press)${revealed ? `: ${revealed}` : ''}`);
    else if (revealed) parts.push(revealed);
  }
  return parts.join('; ');
}

/**
 * Waits until the tap armed by armTap and performed between `started` and `performed` (epoch ms)
 * ended in a click on the element, as a finger's tap does. Its description goes to `log` either
 * way, with how long the element took to become actionable (`waitedMs`); a tap that ends in no
 * click fails here with what arrived and its timing, plus `onFailure`'s words (iOS: where the
 * simulator's log of the tap is).
 */
export async function tapEndsInClick(phone: Phone, selector: string, started: number, performed: number, o: { waitedMs: number; log(line: string): void; onFailure?(): Promise<string> }): Promise<void> {
  let events: TapEvent[] = [];
  const record = async () => describeTap((events = parseTapEvents((await phone.evaluate(() => sessionStorage.getItem('__tap'))) ?? '')), started, performed);
  try {
    // A click on the element itself (one elsewhere is listed as "click>element").
    await expect.poll(record, { message: `the tap on ${selector} ended in a click on it` }).toMatch(/^events: (\S+, )*click[,;]/);
  } catch (e) {
    if (o.onFailure) (e as Error).message += `\n(${await o.onFailure()})`;
    throw e;
  } finally {
    o.log(`${selector}: actionable after ${o.waitedMs} ms; ${describeTap(events, started, performed, false)}`);
  }
}
