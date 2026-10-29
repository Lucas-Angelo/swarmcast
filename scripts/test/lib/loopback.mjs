// Requests a test tool sends to a SwarmCast it started on this machine (same rules as
// loopbackBase() in apps/server/test/e2e/fixtures.ts).

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The base of a URL on this machine (http, 127.0.0.1 / localhost / ::1, a numeric port),
 * rebuilt from those checked parts; anything else throws.
 * @param {string} raw
 * @returns {URL}
 */
export function loopbackBase(raw) {
  const u = new URL(raw);
  if (u.protocol !== 'http:' || !LOOPBACK.has(u.hostname) || !/^\d{1,5}$/.test(u.port)) throw new Error(`not a loopback http URL: ${raw}`);
  return new URL(`http://${u.hostname}:${Number(u.port)}/`);
}

/**
 * The panel's base and one-time login URL from what a test control port answers
 * (`{ adminUrl, adminLoginPath }`): the base must be loopback, the path `/auth/<token>`.
 * @param {{ adminUrl: string, adminLoginPath: string }} env
 * @returns {{ base: URL, loginUrl: URL }}
 */
export function panelLogin(env) {
  const base = loopbackBase(env.adminUrl);
  if (!/^\/auth\/[\w-]+$/.test(env.adminLoginPath)) throw new Error(`unexpected panel login path: ${env.adminLoginPath}`);
  return { base, loginUrl: new URL(env.adminLoginPath, base) };
}
