// An installed SwarmCast started by its real start script, for the system harnesses
// (scripts/test/windows, scripts/test/preflight): the bare-OS environment it runs with, the
// panel it prints, the live link it makes.
import { poll, WaitError } from './wait.mjs';

const win = process.platform === 'win32';
const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';

/** PATH of a fresh OS install: no Git, Node, Homebrew, Chocolatey or other CI tooling. */
export function barePath() {
  if (win) return [`${systemRoot}\\System32`, systemRoot, `${systemRoot}\\System32\\Wbem`, `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\`].join(';');
  return '/usr/bin:/bin:/usr/sbin:/sbin';
}

/**
 * Environment for the start script and the app: the bare PATH, none of this machine's
 * SwarmCast, Node or npm variables, no pause and no browser at the end, and only the SwarmCast
 * variables asked for (`extra` last).
 */
export function bareEnv({ home, releaseUrl, extra = {} } = {}) {
  const drop = /^(path|swarmcast_.*|node_options|npm_.*)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !drop.test(k)));
  env[win ? 'Path' : 'PATH'] = barePath();
  env.SWARMCAST_NO_PAUSE = '1';
  env.SWARMCAST_NO_OPEN = '1';
  if (home) env.SWARMCAST_HOME = home;
  if (releaseUrl) env.SWARMCAST_RELEASE_URL = releaseUrl;
  return { ...env, ...extra };
}

/**
 * The panel of an app whose start script printed "Panel: http://127.0.0.1:<port>/auth/<token>"
 * in `text()`: logs in and returns { base, port, loginUrl, cookie, api, state }. `api(path)` GETs,
 * `api(path, body)` POSTs (`method` for PUT), and the JSON answer carries its HTTP status in a
 * hidden `__status`. Fails at once when a process in `abortOn` exits first.
 */
export async function loginFromOutput(text, { timeoutMs = 300_000, abortOn = [] } = {}) {
  const m = await poll(() => /Panel: (http:\/\/127\.0\.0\.1:(\d+))\/auth\/(\S+)/.exec(text()), { timeoutMs, abortOn, what: 'the panel URL in the start script output' });
  const base = m[1];
  const loginUrl = `${base}/auth/${m[3]}`;
  const res = await fetch(loginUrl, { redirect: 'manual' });
  const cookie = res.headers.getSetCookie()[0].split(';')[0];
  const api = async (p, body, method) => {
    const init = body === undefined && !method ? { headers: { cookie } } : { method: method ?? 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) };
    const r = await fetch(base + p, init);
    const raw = await r.text();
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      json = { raw };
    }
    if (json && typeof json === 'object' && !Array.isArray(json)) Object.defineProperty(json, '__status', { value: r.status });
    return json;
  };
  return { base, port: Number(m[2]), loginUrl, cookie, api, state: () => api('/api/state') };
}

/**
 * The state once the live link exists and the app waits for OBS (or is live). A start that
 * failed (phase off with a step in error) fails the wait at once, with the steps.
 */
export function waitLiveLink(app, timeoutMs = 120_000, abortOn = []) {
  return poll(
    async () => {
      const s = await app.state();
      if (s.phase === 'off' && s.steps?.some((x) => x.status === 'error')) throw new WaitError(`start failed: ${JSON.stringify(s.steps)}`);
      return s.liveLink && (s.phase === 'waiting-obs' || s.phase === 'live') ? s : null;
    },
    { timeoutMs, abortOn, what: 'the live link' },
  );
}
