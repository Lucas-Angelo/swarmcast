// A cookie jar for fetch-based "browsers": the integration tests' viewers (helpers.ts `Jar`), the
// chat bench's bots and the unit tests of the public server. Importing it starts and reads nothing.
//
// Like a browser, it keeps every cookie an answer sets, sends them back with each request and
// drops one whose Max-Age is 0 or less or whose Expires has passed (Max-Age wins when both are
// there, RFC 6265 section 5.3). It never follows a redirect: the test reads each 303 itself. Unlike
// a browser, it keeps cookies by name only, for every address (no domain, port or path), Secure
// ones over plain HTTP too: one jar is one browser of one site, wherever the site's port moves (a
// new live on another port).

/** The cookie of one Set-Cookie line: { name, value, expired }, or null for a line without "=". */
export function parseSetCookie(line, now = Date.now()) {
  const [pair, ...rest] = line.split(';');
  const eq = pair.indexOf('=');
  if (eq < 0) return null;
  const attrs = new Map(
    rest.map((a) => {
      const i = a.indexOf('=');
      return i < 0 ? [a.trim().toLowerCase(), ''] : [a.slice(0, i).trim().toLowerCase(), a.slice(i + 1).trim()];
    }),
  );
  // An attribute with a value that is not a number or a date is ignored (RFC 6265 5.2.1, 5.2.2).
  const maxAge = /^-?\d+$/.test(attrs.get('max-age') ?? '') ? Number(attrs.get('max-age')) : undefined;
  const expires = Date.parse(attrs.get('expires') ?? '');
  const expired = maxAge !== undefined ? maxAge <= 0 : !Number.isNaN(expires) && expires <= now;
  return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), expired };
}

export class CookieJar {
  /** Every Set-Cookie line received, oldest first (for tests that read the attributes). */
  setCookies = [];
  /** name → value of the cookies this browser holds. */
  #cookies = new Map();
  #base;
  #headers;

  /**
   * @param {string} [base] the origin that relative addresses resolve against
   * @param {{ headers?: Record<string, string> }} [options] headers sent with every request (a
   *   bot's `cf-connecting-ip`); a request's own headers win
   */
  constructor(base, { headers = {} } = {}) {
    this.#base = base;
    this.#headers = headers;
  }

  /** The Cookie header of the next request: "a=1; b=2" ('' with none). */
  header() {
    return [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /** Keeps what `res` sets, drops what it expires. */
  store(res) {
    for (const line of res.headers.getSetCookie()) {
      this.setCookies.push(line);
      const c = parseSetCookie(line);
      if (!c) continue;
      if (c.expired) this.#cookies.delete(c.name);
      else this.#cookies.set(c.name, c.value);
    }
  }

  /** fetch with this browser's cookies; never follows a redirect. `url` may be relative to the base. */
  async fetch(url, init = {}) {
    const res = await fetch(this.#base === undefined ? url : new URL(url, this.#base), {
      ...init,
      redirect: 'manual',
      headers: { ...this.#headers, ...init.headers, cookie: this.header() },
    });
    this.store(res);
    return res;
  }

  has(name) {
    return this.#cookies.has(name);
  }

  get(name) {
    return this.#cookies.get(name);
  }

  /** Puts a cookie in by hand (one browser handing another its cookie, a tampered value). */
  set(name, value) {
    this.#cookies.set(name, value);
  }
}
