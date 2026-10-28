import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { loopbackBase, panelLogin } from '../../../../scripts/test/lib/loopback.mjs';
import { mdCell } from '../../../../scripts/test/lib/markdown.mjs';
import { isAlive, spawnTracked, stopTracked } from '../../../../scripts/test/lib/proc.mjs';
import { until, waitForLine, WaitError } from '../../../../scripts/test/lib/wait.mjs';

// The shared test harness (scripts/test/lib): waits that fail fast and name their cause, and
// child processes that never outlive their test.

afterEach(stopTracked);

const node = (code: string) => spawnTracked(process.execPath, ['-e', code], { name: 'node child' });

describe('until', () => {
  it('resolves on the event that makes the condition true, not on the next poll', async () => {
    const e = new EventEmitter();
    let ready = false;
    setTimeout(() => {
      ready = true;
      e.emit('changed');
    }, 20);
    const t0 = Date.now();
    await until(() => ready, { timeoutMs: 5000, what: 'ready', on: [[e, 'changed']], pollMs: 60_000 });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('times out with what it waited for and the state at that moment', async () => {
    await expect(until(() => false, { timeoutMs: 50, what: 'the moon', detail: () => 'phase new' })).rejects.toThrow(/^timed out waiting for the moon after \d+ ms \(phase new\)$/);
  });

  it('fails at once with the error of a condition that throws', async () => {
    await expect(
      until(
        () => {
          throw new Error('the load guard dropped a rendition');
        },
        { timeoutMs: 60_000, what: 'x' },
      ),
    ).rejects.toThrow('the load guard dropped a rendition');
  });

  it('fails at once when the process it depends on exits, with its last output lines', async () => {
    const p = node('console.error("cannot connect: secret-abc"); process.exit(3)');
    const t0 = Date.now();
    const err = await until(() => false, { timeoutMs: 60_000, what: 'the live', abortOn: [p] }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(WaitError);
    expect((err as Error).message).toMatch(/^the live: node child exited \(code 3\)/);
    expect((err as Error).message).toContain('cannot connect: secret-abc');
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('still succeeds when the condition became true just before the process exited', async () => {
    const p = node('console.log("done")');
    await until(() => p.lines.includes('done'), { timeoutMs: 10_000, what: 'done', abortOn: [p], pollMs: 60_000 });
  });
});

describe('spawnTracked', () => {
  it('masks secrets in tail()', async () => {
    const p = spawnTracked(process.execPath, ['-e', 'console.error("key sc_secret")'], { mask: (t) => t.replaceAll('sc_secret', '[key]') });
    await p.exited;
    expect(p.tail()).toBe('key [key]');
  });

  it('waitForLine returns the first matching line, and fails at once if the process exits without it', async () => {
    const p = node('console.log("port=1234"); setInterval(() => {}, 1000)');
    expect((await waitForLine(p, /port=(\d+)/, { timeoutMs: 10_000, what: 'port line' }))[1]).toBe('1234');
    const q = node('console.log("nothing")');
    await expect(waitForLine(q, /port=/, { timeoutMs: 60_000, what: 'port line' })).rejects.toThrow(/port line: node child exited \(code 0\)/);
  });

  it('stop() kills the whole tree, a grandchild in a process group of its own included, and confirms it', async () => {
    // The grandchild is started detached (like SwarmCast starts MediaMTX): on POSIX it leads its
    // own process group, so a signal to the child's group alone would miss it.
    const p = node(`
      const { spawn } = require('node:child_process');
      const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
      console.log('grandchild ' + g.pid);
      setInterval(() => {}, 1000);
    `);
    const grandchild = Number((await waitForLine(p, /^grandchild (\d+)$/, { timeoutMs: 10_000, what: 'grandchild pid' }))[1]);
    expect(isAlive(grandchild)).toBe(true);
    await p.stop();
    expect(isAlive(p.pid!)).toBe(false);
    expect(isAlive(grandchild)).toBe(false);
  });

  it('stop() after the process exited by itself is quick and harmless', async () => {
    const p = node('');
    await p.exited;
    const t0 = Date.now();
    await p.stop();
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('loopbackBase / panelLogin', () => {
  it('accepts only http on this machine with a numeric port, rebuilt from those parts', () => {
    expect(loopbackBase('http://127.0.0.1:38081/anything?x=1').href).toBe('http://127.0.0.1:38081/');
    expect(loopbackBase('http://localhost:8080').href).toBe('http://localhost:8080/');
    expect(loopbackBase('http://[::1]:9000/').href).toBe('http://[::1]:9000/');
    for (const bad of ['https://127.0.0.1:1/', 'http://127.0.0.1/', 'http://example.com:80/', 'http://127.0.0.1.example.com:1/', 'http://user@evil:1/', 'file:///etc/passwd']) {
      expect(() => loopbackBase(bad), bad).toThrow();
    }
  });

  it('builds the panel login URL only from a loopback base and an /auth/<token> path', () => {
    expect(panelLogin({ adminUrl: 'http://127.0.0.1:38081', adminLoginPath: '/auth/abc-DEF_123' }).loginUrl.href).toBe('http://127.0.0.1:38081/auth/abc-DEF_123');
    expect(() => panelLogin({ adminUrl: 'http://127.0.0.1:38081', adminLoginPath: '//evil.example/auth/x' })).toThrow(/login path/);
    expect(() => panelLogin({ adminUrl: 'http://127.0.0.1:38081', adminLoginPath: '/auth/x/../../api' })).toThrow(/login path/);
    expect(() => panelLogin({ adminUrl: 'http://evil.example:38081', adminLoginPath: '/auth/x' })).toThrow(/loopback/);
  });
});

describe('mdCell', () => {
  const bs = '\\';
  it('keeps any text inside its Markdown table cell', () => {
    expect(mdCell('a | b')).toBe(`a ${bs}| b`);
    // A trailing backslash is escaped, so it can no longer escape the cell's closing pipe.
    expect(mdCell(`C:${bs}dir${bs}`)).toBe(`C:${bs}${bs}dir${bs}${bs}`);
    expect(mdCell(`x${bs}|y`)).toBe(`x${bs}${bs}${bs}|y`);
    expect(mdCell('one\r\ntwo\nthree')).toBe('one two three');
  });
});
