// The only branding code in the pages' main bundles: it loads the branding chunk (brand.ts) and
// passes it the page's events. If the chunk fails, the stock SwarmCast page stays.
import type { BrandController, BrandPage } from './brand.js';

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
