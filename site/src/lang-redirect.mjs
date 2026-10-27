// Inline <head> script: on the FIRST visit, a browser whose language is Portuguese is sent from
// an English page to the same page in pt-BR. After that the language the visitor last read is
// remembered (localStorage, no cookies), so the language switcher always wins. Navigation that
// comes from this site (e.g. the switcher) is never redirected, even when storage is blocked.
// Kept as a string because it must run before the page renders (no flash of English).
export const LANG_KEY = 'swarmcast:lang';

/** @param {string} base e.g. '/swarmcast' */
export function langRedirectScript(base) {
  return `(function () {
  var base = ${JSON.stringify(base)}, key = ${JSON.stringify(LANG_KEY)}, pt = base + '/pt-br';
  var p = location.pathname;
  var inPt = p === pt || p.indexOf(pt + '/') === 0;
  var saved = null;
  try { saved = localStorage.getItem(key); } catch (e) {}
  var internal = false;
  try { internal = !!document.referrer && new URL(document.referrer).origin === location.origin; } catch (e) {}
  if (!saved && !inPt && !internal && p.indexOf(base) === 0) {
    var langs = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language || ''];
    for (var i = 0; i < langs.length; i++) {
      if (/^pt(-|$)/i.test(String(langs[i]))) {
        try { localStorage.setItem(key, 'pt-br'); } catch (e) {}
        var rest = p.slice(base.length) || '/';
        location.replace(pt + rest + location.search + location.hash);
        return;
      }
    }
  }
  try { localStorage.setItem(key, inPt ? 'pt-br' : 'en'); } catch (e) {}
})();`;
}
