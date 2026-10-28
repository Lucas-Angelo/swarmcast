/** The base of an http URL on 127.0.0.1 / localhost / ::1 with a numeric port, rebuilt from those parts; anything else throws. */
export function loopbackBase(raw: string): URL;

/** The panel's base and login URL from a test control port's `{ adminUrl, adminLoginPath }` (loopback base, `/auth/<token>` path). */
export function panelLogin(env: { adminUrl: string; adminLoginPath: string }): { base: URL; loginUrl: URL };
