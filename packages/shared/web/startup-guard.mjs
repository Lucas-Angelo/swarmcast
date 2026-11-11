// The viewer pages' startup guard: the one inline script of join.html and watch.html.
//
// When one of the scripts a page starts with fails to load (a dropped connection), the browser
// never runs it and never asks for it again: the page stayed on screen looking ready, with nothing
// working ("Watch" disabled for good; soak run 41194466705, windows-app job 15). The guard reloads
// the page instead, at most three times in a row (counted in this tab, from zero again once the
// page starts with its scripts), so a server that is gone does not reload it forever. It only
// looks at module scripts that fail before DOMContentLoaded (the pages' own), and never reloads
// where it cannot count (site data blocked).
//
// It reloads once the page has finished loading without that script (its `load` event), never at
// the script's error itself. Firefox also fails a script it cancels: a page still loading when the
// viewer leaves it (a link, Back, a typed address) or stops it (Esc) gets an error for each of its
// scripts in flight, after `beforeunload` and before the next page arrives. A reload then took the
// viewer back to the page they had just left (the e2e chat spec's goto failed with
// NS_BINDING_ABORTED, main run 42925388330), or reloaded a page they had stopped. A page left or
// stopped never fires `load` (Firefox, Chromium and WebKit alike); one whose script really failed
// does, at once.
//
// Inline on purpose: a guard in a file of its own could fail to load just the same. One source
// for both sides, so nothing ever parses HTML to find it: the viewer build writes this text into
// the pages (startupGuard, a Vite plugin), and the public server allows exactly this text by its
// SHA-256 in the viewer CSP (apps/server/src/public/security.ts), never 'unsafe-inline'.

/** The guard's source, as the pages carry it. Plain ES5 and line feeds only (hashed as is). */
export const STARTUP_GUARD = `(function () {
  var KEY = 'swarmcast.startupReloads';
  var failed = false;
  var started = false;
  addEventListener(
    'error',
    function (e) {
      var s = e.target;
      if (started || !(s instanceof HTMLScriptElement) || s.type !== 'module') return;
      failed = true;
    },
    true
  );
  addEventListener('DOMContentLoaded', function () {
    started = true;
    if (failed) return;
    try {
      sessionStorage.removeItem(KEY);
    } catch (_) {}
  });
  addEventListener('load', function () {
    if (!failed) return;
    try {
      var n = Number(sessionStorage.getItem(KEY)) || 0;
      if (n >= 3) return;
      sessionStorage.setItem(KEY, String(n + 1));
    } catch (_) {
      return;
    }
    location.reload();
  });
})();`;

/** The viewer pages that carry the guard (the "link not valid" page has nothing to recover). */
export const STARTUP_GUARD_PAGES = ['join.html', 'watch.html'];

/**
 * Vite plugin: writes the guard at the end of the head of STARTUP_GUARD_PAGES (build and dev
 * server), after the charset. Where it sits does not matter for what it catches: a page's module
 * scripts report a failed load only once the whole page is parsed.
 */
export function startupGuard() {
  return {
    name: 'swarmcast-startup-guard',
    transformIndexHtml(_html, ctx) {
      const page = ctx.path.split('/').pop();
      if (!STARTUP_GUARD_PAGES.includes(page)) return undefined;
      return [{ tag: 'script', children: STARTUP_GUARD, injectTo: 'head' }];
    },
  };
}
