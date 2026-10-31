import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loopbackBase, panelLogin } from '../../../../scripts/test/lib/loopback.mjs';
import { mdCell } from '../../../../scripts/test/lib/markdown.mjs';
import { isAlive, spawnTracked, stopTracked } from '../../../../scripts/test/lib/proc.mjs';
import { until, waitForLine, WaitError } from '../../../../scripts/test/lib/wait.mjs';

// The shared test harness (scripts/test/lib): waits that fail fast and name their cause, and
// child processes that never outlive their test. Where time is the subject the clock is fake, so
// "at once" is checked against virtual time instead of a wall-clock budget. A child that exits at
// once tells "failed on its exit" from "failed on the timeout" by the error message: the timeout is
// shorter than the test's, so a wait that missed the exit fails with "timed out" instead.

afterEach(async () => {
  vi.useRealTimers();
  await stopTracked();
});

const node = (code: string) => spawnTracked(process.execPath, ['-e', code], { name: 'node child' });

/** A wait's timeout far beyond the moment its event comes, and its slow poll further still. */
const LONG_TIMEOUT_MS = 5000;
const SLOW_POLL_MS = 60_000;
/** When the awaited event comes, in virtual time. */
const EVENT_AT_MS = 20;
/** A timeout the waits below must never reach: a child that exits at once is gone long before. */
const EXIT_TIMEOUT_MS = 10_000;

describe('until', () => {
  it('resolves on the event that makes the condition true, not on the next poll', async () => {
    // Arrange
    vi.useFakeTimers();
    const e = new EventEmitter();
    let ready = false;
    setTimeout(() => {
      ready = true;
      e.emit('changed');
    }, EVENT_AT_MS);
    const t0 = Date.now();
    // Act
    const resolvedAfterMs = until(() => ready, { timeoutMs: LONG_TIMEOUT_MS, what: 'ready', on: [[e, 'changed']], pollMs: SLOW_POLL_MS }).then(() => Date.now() - t0);
    await vi.advanceTimersByTimeAsync(LONG_TIMEOUT_MS);
    // Assert
    expect(await resolvedAfterMs).toBe(EVENT_AT_MS);
  });

  it('times out with what it waited for and the state at that moment', async () => {
    // Arrange
    vi.useFakeTimers();
    const waiting = until(() => false, { timeoutMs: 50, what: 'the moon', detail: () => 'phase new' });
    const failed = expect(waiting).rejects.toThrow(/^timed out waiting for the moon after 50 ms \(phase new\)$/);
    // Act
    await vi.advanceTimersByTimeAsync(50);
    // Assert
    await failed;
  });

  it('fails at once with the error of a condition that throws', async () => {
    // Act
    const waiting = until(
      () => {
        throw new Error('the load guard dropped a rendition');
      },
      { timeoutMs: 60_000, what: 'x' },
    );
    // Assert
    await expect(waiting).rejects.toThrow('the load guard dropped a rendition');
  });

  it('fails when the process it depends on exits, before its timeout, with its last output lines', async () => {
    // Arrange
    const p = node('console.error("cannot connect: secret-abc"); process.exit(3)');
    // Act
    const err = await until(() => false, { timeoutMs: EXIT_TIMEOUT_MS, what: 'the live', abortOn: [p] }).catch((e: Error) => e);
    // Assert
    expect(err).toBeInstanceOf(WaitError);
    expect((err as Error).message).toMatch(/^the live: node child exited \(code 3\)/);
    expect((err as Error).message).toContain('cannot connect: secret-abc');
  });

  it('still succeeds when the condition became true just before the process exited', async () => {
    // Arrange
    const p = node('console.log("done")');
    // Act
    const waiting = until(() => p.lines.includes('done'), { timeoutMs: EXIT_TIMEOUT_MS, what: 'done', abortOn: [p], pollMs: SLOW_POLL_MS });
    // Assert
    await expect(waiting).resolves.toBeUndefined();
  });
});

describe('spawnTracked', () => {
  it('masks secrets in tail()', async () => {
    // Arrange
    const p = spawnTracked(process.execPath, ['-e', 'console.error("key sc_secret")'], { mask: (t) => t.replaceAll('sc_secret', '[key]') });
    // Act
    await p.exited;
    // Assert
    expect(p.tail()).toBe('key [key]');
  });

  it('waitForLine returns the first matching line', async () => {
    // Arrange
    const p = node('console.log("port=1234"); setInterval(() => {}, 1000)');
    // Act
    const match = await waitForLine(p, /port=(\d+)/, { timeoutMs: EXIT_TIMEOUT_MS, what: 'port line' });
    // Assert
    expect(match[1]).toBe('1234');
  });

  it('waitForLine fails as soon as the process exits without such a line', async () => {
    // Arrange
    const q = node('console.log("nothing")');
    // Act
    const waiting = waitForLine(q, /port=/, { timeoutMs: EXIT_TIMEOUT_MS, what: 'port line' });
    // Assert
    await expect(waiting).rejects.toThrow(/port line: node child exited \(code 0\)/);
  });

  it('stop() kills the whole tree, a grandchild in a process group of its own included, and confirms it', async () => {
    // Arrange
    const p = node(`
      const { spawn } = require('node:child_process');
      const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
      console.log('grandchild ' + g.pid);
      setInterval(() => {}, 1000);
    `);
    const grandchild = Number((await waitForLine(p, /^grandchild (\d+)$/, { timeoutMs: EXIT_TIMEOUT_MS, what: 'grandchild pid' }))[1]);
    const grandchildRan = isAlive(grandchild);
    // Act
    await p.stop();
    // Assert
    expect(grandchildRan).toBe(true);
    expect(isAlive(p.pid!)).toBe(false);
    expect(isAlive(grandchild)).toBe(false);
  });

  it('stop() after the process exited by itself needs no timer at all (no kill, no wait), and is harmless', async () => {
    // Arrange
    const p = node('');
    await p.exited;
    vi.useFakeTimers();
    const t0 = Date.now();
    // Act
    const stoppedAfterMs = p.stop().then(() => Date.now() - t0);
    await vi.advanceTimersByTimeAsync(EXIT_TIMEOUT_MS * 2);
    // Assert
    expect(await stoppedAfterMs).toBe(0);
  });
});

describe('loopbackBase / panelLogin', () => {
  it.each([
    ['http://127.0.0.1:11081/anything?x=1', 'http://127.0.0.1:11081/'],
    ['http://localhost:8080', 'http://localhost:8080/'],
    ['http://[::1]:9000/', 'http://[::1]:9000/'],
  ])('accepts http on this machine with a numeric port, rebuilt from those parts: %s', (url, base) => {
    // Act
    const rebuilt = loopbackBase(url).href;
    // Assert
    expect(rebuilt).toBe(base);
  });

  it.each(['https://127.0.0.1:1/', 'http://127.0.0.1/', 'http://example.com:80/', 'http://127.0.0.1.example.com:1/', 'http://user@evil:1/', 'file:///etc/passwd'])('refuses %s', (bad) => {
    // Act
    const parse = () => loopbackBase(bad);
    // Assert
    expect(parse).toThrow();
  });

  it('builds the panel login URL from a loopback base and an /auth/<token> path', () => {
    // Act
    const { loginUrl } = panelLogin({ adminUrl: 'http://127.0.0.1:11081', adminLoginPath: '/auth/abc-DEF_123' });
    // Assert
    expect(loginUrl.href).toBe('http://127.0.0.1:11081/auth/abc-DEF_123');
  });

  it.each([
    ['another host in the path', { adminUrl: 'http://127.0.0.1:11081', adminLoginPath: '//evil.example/auth/x' }, /login path/],
    ['a path that climbs out of /auth', { adminUrl: 'http://127.0.0.1:11081', adminLoginPath: '/auth/x/../../api' }, /login path/],
    ['a base that is not this machine', { adminUrl: 'http://evil.example:11081', adminLoginPath: '/auth/x' }, /loopback/],
  ])('refuses %s', (_what, o, error) => {
    // Act
    const build = () => panelLogin(o);
    // Assert
    expect(build).toThrow(error);
  });
});

describe('mdCell', () => {
  const bs = '\\';

  it.each([
    ['a pipe', 'a | b', `a ${bs}| b`],
    ['a trailing backslash (it can no longer escape the cell\'s closing pipe)', `C:${bs}dir${bs}`, `C:${bs}${bs}dir${bs}${bs}`],
    ['an escaped pipe', `x${bs}|y`, `x${bs}${bs}${bs}|y`],
    ['line breaks', 'one\r\ntwo\nthree', 'one two three'],
  ])('keeps any text inside its Markdown table cell: %s', (_what, text, cell) => {
    // Act
    const out = mdCell(text);
    // Assert
    expect(out).toBe(cell);
  });
});
