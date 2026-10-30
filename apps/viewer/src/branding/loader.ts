// The only branding code in the pages' main bundles: it loads the branding chunk (brand.ts) and
// passes it the page's events. If the chunk fails, the stock SwarmCast page stays.
import type { BrandController, BrandPage } from './brand.js';

/** brand.ts startBrand, which the join page loads with the branding chunk. */
export type StartBrand = (typeof import('./brand.js'))['startBrand'];

/** How long the join page waits for its branding before it shows the stock page. */
export const JOIN_BRAND_WAIT_MS = 1500;

/**
 * Join page: the streamer's header, title and tagline come from /api/brand after the page loads
 * (100-300 ms) and are taller than the stock ones. Shown before them, the form moved down under a
 * press in progress, and a press on "Watch" released after the move landed on the card: no join.
 * So the page stays invisible and untouchable (style.css) until this marks its branding known
 * (body.brand-known): once it is in, or failed, or after `waitMs`. Branding that comes later
 * changes the tab title and icon only, never the layout. Resolves once the page shows.
 */
export function startJoinBranding(o: { loadStartBrand?: () => Promise<StartBrand>; waitMs?: number; debug?: (msg: string) => void } = {}): Promise<void> {
  // Only startBrand is taken from the chunk: a whole module namespace passed around would make the
  // bundler build it with its runtime helper, which it put in the watch entry chunk, so the join
  // page loaded and ran the watch page's script along with its branding.
  const loadStartBrand = o.loadStartBrand ?? (() => import('./brand.js').then((m) => m.startBrand));
  let shown = false;
  let markShown: () => void = () => {};
  const showing = new Promise<void>((resolve) => {
    markShown = () => {
      if (shown) return;
      shown = true;
      document.body.classList.add('brand-known');
      resolve();
    };
  });
  const timer = setTimeout(markShown, o.waitMs ?? JOIN_BRAND_WAIT_MS);
  loadStartBrand()
    .then((startBrand) => startBrand('join', { canChangeLayout: () => !shown }).refresh())
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

export function createBrandRouter(page: BrandPage, debug?: (msg: string) => void): BrandRouter {
  let ctl: BrandController | null = null;
  const queue: Array<(c: BrandController) => void> = [];
  const run = (fn: (c: BrandController) => void): void => {
    if (ctl) fn(ctl);
    else if (queue.length < 20) queue.push(fn);
  };
  import('./brand.js')
    .then(async (m) => {
      const c = m.startBrand(page);
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
