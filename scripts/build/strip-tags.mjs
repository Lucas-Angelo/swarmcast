/**
 * Removes every `<…>` span (an HTML tag, an e-mail address in "Name <a@b>"), like
 * `s.replace(/<[^>]*>/g, '')` but in one pass over the text with no regex: a `<` with no `>`
 * after it is kept as it is.
 * @param {string} s
 * @returns {string}
 */
export function stripTags(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    const gt = lt < 0 ? -1 : s.indexOf('>', lt + 1);
    if (gt < 0) return out + s.slice(i);
    out += s.slice(i, lt);
    i = gt + 1;
  }
  return out;
}
