export interface SetCookie {
  name: string;
  value: string;
  /** Max-Age 0 or less, or an Expires before `now` (Max-Age wins when both are there). */
  expired: boolean;
}

/** The cookie of one Set-Cookie line, or null for a line without "=". */
export function parseSetCookie(line: string, now?: number): SetCookie | null;

/**
 * One fetch-based browser of one site: keeps the cookies answers set (by name, for every address,
 * Secure ones over plain HTTP too), sends them back, never follows a redirect.
 */
export class CookieJar {
  /**
   * @param base the origin that relative addresses resolve against
   * @param options.headers headers sent with every request; a request's own headers win
   */
  constructor(base?: string, options?: { headers?: Record<string, string> });
  /** Every Set-Cookie line received, oldest first. */
  readonly setCookies: string[];
  /** The Cookie header of the next request: "a=1; b=2" ('' with none). */
  header(): string;
  /** Keeps what `res` sets, drops what it expires. */
  store(res: Response): void;
  /** fetch with this browser's cookies; never follows a redirect. `url` may be relative to the base. */
  fetch(url: string | URL, init?: RequestInit): Promise<Response>;
  has(name: string): boolean;
  get(name: string): string | undefined;
  /** Puts a cookie in by hand (one browser handing another its cookie, a tampered value). */
  set(name: string, value: string): void;
}
