// The only branding code in the pages' main bundles: it loads the branding chunk (brand.ts) and
// passes it the page's events. If the chunk fails, the stock SwarmCast page stays.
import type { PublicBranding } from '@swarmcast/shared/branding';
import type { BrandController, BrandPage } from './brand.js';

/** brand.ts startBrand, which the join page loads with the branding chunk. */
export type StartBrand = (typeof import('./brand.js'))['startBrand'];

/** How long the join page waits for its branding before it shows the stock page. */
export const JOIN_BRAND_WAIT_MS = 1500;

/** The CSS animation with which style.css shows the join page by itself (its fallback, 3 s of CSS time). */
export const JOIN_CSS_FALLBACK_ANIMATION = 'sc-brand-known';

/**
 * Whether style.css already shows the join page by itself: its fallback ran before the branding
 * was known, as on a slow phone that runs the page's script seconds after its styles. Read from
 * the page's own state (the card visible or taking taps), not from a timer of this script, which
 * starts later than the styles' clock.
 */
export function joinShownByCss(doc: Document = document): boolean {
  const card = doc.querySelector('main');
  if (!card) return false;
  const style = getComputedStyle(card);
  return style.pointerEvents !== 'none' || style.opacity !== '0';
}

/**
 * Join page: the streamer's header, title and tagline come from /api/brand after the page loads
 * (100-300 ms) and are taller than the stock ones. Shown before them, the form moved down under a
 * press in progress, and a press on "Watch" released after the move landed on the card: no join.
 * So the page stays invisible and untouchable (style.css) until this marks its branding known
 * (body.brand-known): once it is in, or failed, or after `waitMs`. Branding that comes later
 * changes the tab title and icon only, never the layout. Resolves once the page shows.
 *
 * style.css shows the page by itself after 3 s of CSS time, whether or not this has run. A page
 * shown that way is shown: it already takes taps, so the layout is final, as after `waitMs`, and
 * the page is marked known at once (join.ts enables "Watch" then). Besides the press that would
 * land elsewhere, iOS turns a tap into a hover, with no click, when the page changes under it
 * (WebKit's content-change observer, WebPage::handleSyntheticClick).
 * `shownByCss` is joinShownByCss (tests replace it).
 */
export function startJoinBranding(o: { loadStartBrand?: () => Promise<StartBrand>; waitMs?: number; shownByCss?: () => boolean; debug?: (msg: string) => void } = {}): Promise<void> {
  // Only startBrand is taken from the chunk: a whole module namespace passed around would make the
  // bundler build it with its runtime helper, which it put in the watch entry chunk, so the join
  // page loaded and ran the watch page's script along with its branding.
  const loadStartBrand = o.loadStartBrand ?? (() => import('./brand.js').then((m) => m.startBrand));
  const shownByCss = o.shownByCss ?? (() => joinShownByCss());
  let shown = false;
  let markShown: () => void = () => {};
  const showing = new Promise<void>((resolve) => {
    markShown = () => {
      if (shown) return;
      shown = true;
      document.removeEventListener('animationend', onFallback);
      document.body.classList.add('brand-known');
      resolve();
    };
  });
  // The fallback runs while this waits (its animation ends at once: zero duration, 3 s delay).
  function onFallback(e: AnimationEvent): void {
    if (e.animationName === JOIN_CSS_FALLBACK_ANIMATION) markShown();
  }
  document.addEventListener('animationend', onFallback);
  // Or it ran before this script did.
  if (shownByCss()) markShown();
  const timer = setTimeout(markShown, o.waitMs ?? JOIN_BRAND_WAIT_MS);
  loadStartBrand()
    // Asked again when the branding is applied: the fallback may have shown the page a moment
    // before, its animationend not dispatched yet.
    .then((startBrand) => startBrand('join', { canChangeLayout: () => !shown && !shownByCss() }).refresh())
    // The text in its web fonts too (a font swap after the page shows would reflow it as well): a
    // layout first, so the fonts the streamer's text needs have started loading, then wait for them.
    .then(() => {
      void document.body.getBoundingClientRect();
      return document.fonts?.ready;
    })
    .catch((err: unknown) => o.debug?.(`branding: ${String(err)}`))
    .finally(() => {
      clearTimeout(timer);
      markShown();
    });
  return showing;
}

export interface BrandRouter {
  /** hello.brandRev, or a {t:'branding', rev} message. */
  rev(rev: number | undefined): void;
  firstFrame(): void;
  ended(): void;
}

/**
 * The watch page's branding chunk. `onData` gets the streamer's page each time it is applied
 * (null without one): the lock-screen title and picture (media-session.ts) and the share title.
 */
export function createBrandRouter(page: BrandPage, debug?: (msg: string) => void, onData?: (data: PublicBranding | null) => void): BrandRouter {
  let ctl: BrandController | null = null;
  const queue: Array<(c: BrandController) => void> = [];
  const run = (fn: (c: BrandController) => void): void => {
    if (ctl) fn(ctl);
    else if (queue.length < 20) queue.push(fn);
  };
  import('./brand.js')
    .then(async (m) => {
      const c = m.startBrand(page, onData ? { onData } : {});
      await c.refresh();
      ctl = c;
      for (const fn of queue.splice(0)) fn(c);
    })
    .catch((err: unknown) => debug?.(`branding: ${String(err)}`));
  return {
    rev: (rev) => run((c) => void c.refresh(rev)),
    firstFrame: () => run((c) => c.firstFrame()),
    ended: () => run((c) => c.ended()),
  };
}
