// Waiting helpers shared by the test suites: the Vitest integration tests and the scripts/test
// harnesses (plain Node, no build step: this is JavaScript with types in wait.d.mts).
//
// The rules they implement:
// - never sleep to let something happen: wait for the signal that it happened;
// - every wait has an owner process: when a process the wait depends on exits, the wait fails at
//   once, with that process's last output lines;
// - every timeout message says what was awaited and carries the state at that moment.

/** A wait that timed out or whose owner process exited. */
export class WaitError extends Error {
  name = 'WaitError';
}

function describe(detail) {
  if (!detail) return '';
  try {
    const d = detail();
    return d ? ` (${d})` : '';
  } catch (err) {
    return ` (detail failed: ${err.message})`;
  }
}

/** "code 1", "SIGKILL" or "error: spawn ENOENT". */
export function formatExit(x) {
  if (!x) return 'still running';
  if (x.error) return `error: ${x.error}`;
  return x.signal ?? `code ${x.code}`;
}

/**
 * Resolves once `pred()` is true. `pred` is checked at once, again on every event listed in
 * `on`, and on a slow poll as a safety net (`pollMs`, default 250 ms). A `pred` that throws
 * fails the wait at once with that error.
 *
 * Rejects with a WaitError:
 * - after `timeoutMs`: "timed out waiting for <what> after N ms (<detail()>)";
 * - as soon as a process in `abortOn` exits (or had already exited): "<what>: <name> exited
 *   (<code or signal>)", followed by that process's last output lines.
 */
export function until(pred, o) {
  const { timeoutMs, what, detail, abortOn = [], on = [], pollMs = 250 } = o;
  return new Promise((resolve, reject) => {
    let done = false;
    let checking = false;
    let again = false;
    const cleanups = [];
    const finish = (err) => {
      if (done) return;
      done = true;
      for (const c of cleanups) c();
      if (err) reject(err);
      else resolve();
    };
    const check = async () => {
      if (done) return;
      if (checking) {
        again = true;
        return;
      }
      checking = true;
      try {
        do {
          again = false;
          if (await pred()) return finish();
        } while (again && !done);
      } catch (err) {
        finish(err);
      } finally {
        checking = false;
      }
    };
    const started = Date.now();
    const timer = setTimeout(() => finish(new WaitError(`timed out waiting for ${what} after ${Date.now() - started} ms${describe(detail)}`)), timeoutMs);
    cleanups.push(() => clearTimeout(timer));
    const poll = setInterval(() => void check(), pollMs);
    cleanups.push(() => clearInterval(poll));
    for (const [emitter, event] of on) {
      const h = () => void check();
      emitter.on(event, h);
      cleanups.push(() => emitter.off(event, h));
    }
    for (const p of abortOn) {
      void p.exited.then((x) => {
        if (done) return;
        // The owner's last event may be the one that made pred true: one final check first.
        void Promise.resolve(pred())
          .catch(() => false)
          .then((ok) => {
            if (ok) return finish();
            const tail = p.tail();
            finish(new WaitError(`${what}: ${p.name} exited (${formatExit(x)}) after ${Date.now() - started} ms of waiting${describe(detail)}${tail ? `\n--- last output of ${p.name}:\n${tail}` : ''}`));
          });
      });
    }
    void check();
  });
}

/**
 * Polls `fn` every `everyMs` (default 500) until it returns something truthy, and resolves with
 * that value. Unlike `until`, an error thrown by `fn` only means "not yet" (an API that does not
 * answer while the app starts): the last one is in the timeout message. A WaitError thrown by
 * `fn` is a definite failure (the live start failed): it ends the wait at once. `abortOn` and
 * `detail` as in `until`.
 */
export async function poll(fn, o) {
  let value;
  let lastError;
  await until(
    async () => {
      try {
        value = await fn();
        lastError = undefined;
        return !!value;
      } catch (err) {
        if (err instanceof WaitError) throw err;
        lastError = err;
        return false;
      }
    },
    {
      timeoutMs: o.timeoutMs,
      what: o.what,
      abortOn: o.abortOn,
      pollMs: o.everyMs ?? 500,
      detail: () => [o.detail?.(), lastError && `last error: ${lastError.message ?? lastError}`].filter(Boolean).join('; '),
    },
  );
  return value;
}

/**
 * Resolves with what `promise` resolves to, or with `fallback` once `ms` passed (a deadline on an
 * event, such as a process exit; the timer is cleared either way).
 */
export function orTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([promise, new Promise((resolve) => (timer = setTimeout(() => resolve(fallback), ms)))]).finally(() => clearTimeout(timer));
}

/**
 * Resolves with the first output line of `proc` (a tracked process, see proc.mjs) that matches
 * `re`, counting from line index `from` (default: every line so far). Fails at once when `proc`
 * exits without such a line.
 */
export async function waitForLine(proc, re, o) {
  let match = null;
  const from = o.from ?? 0;
  await until(
    () => {
      for (let i = from; i < proc.lines.length && !match; i++) match = re.exec(proc.lines[i]);
      return !!match;
    },
    { timeoutMs: o.timeoutMs, what: o.what, detail: o.detail ?? (() => `last output: ${proc.tail(5) || '(none)'}`), on: [[proc, 'line']], abortOn: [proc, ...(o.abortOn ?? [])] },
  );
  return match;
}
