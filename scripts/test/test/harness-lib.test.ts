// The shared helpers of the system harnesses (scripts/test/lib): the release server, the waits
// that return a value or end at a deadline, the port probe, and the JUnit view of a harness's
// results. Servers listen on 127.0.0.1 port 0 (no collision, no firewall prompt) and every
// folder and server a test makes is removed by onTestFinished, servers before their folder.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { junitXml } from '../lib/junit.mjs';
import { isListening } from '../lib/ports.mjs';
import { serveDir } from '../lib/release-server.mjs';
import { orTimeout, poll, WaitError } from '../lib/wait.mjs';

/** A fresh folder holding `files`, removed after the test. */
function releaseFolder(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-harness-lib-'));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  return root;
}

/** serveDir(root, o), closed after the test (before its folder goes: onTestFinished runs in reverse). */
async function served(root: string, o?: Parameters<typeof serveDir>[1]) {
  const server = await serveDir(root, o);
  onTestFinished(() => server.close());
  return server;
}

/** A process that waits can depend on (wait.mjs Owner), which exits when `exit()` is called. */
function owner() {
  let exit!: () => void;
  const exited = new Promise<{ code: number; signal: null }>((resolve) => (exit = () => resolve({ code: 3, signal: null })));
  return { exit, proc: { name: 'fake app', exited, tail: () => 'last line of the fake app' } };
}

describe('serveDir', () => {
  it('serves the files of its folder on 127.0.0.1', async () => {
    // Arrange
    const server = await served(releaseFolder({ 'SHA256SUMS.txt': 'abc  pkg.tar.gz\n' }));

    // Act
    const res = await fetch(`${server.url}/SHA256SUMS.txt`);

    // Assert
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('abc  pkg.tar.gz\n');
  });

  it('answers 404 for a missing file, a folder and a path out of its folder', async () => {
    // Arrange
    const root = releaseFolder({ 'sub/inside.txt': 'x' });
    fs.writeFileSync(path.join(path.dirname(root), `${path.basename(root)}-outside.txt`), 'secret');
    onTestFinished(() => fs.rmSync(path.join(path.dirname(root), `${path.basename(root)}-outside.txt`), { force: true }));
    const server = await served(root);

    // Act
    const statuses = await Promise.all(['/missing.txt', '/sub', `/..%2F${path.basename(root)}-outside.txt`].map(async (p) => (await fetch(server.url + p)).status));

    // Assert
    expect(statuses).toEqual([404, 404, 404]);
  });

  it('reports every request, and answers a name with the file `resolve` gives', async () => {
    // Arrange
    const seen: Array<{ method: string; path: string; status: number }> = [];
    const server = await served(releaseFolder({ 'latest.json': '{"version":"9.9.9"}' }), { resolve: (n) => (n === '/beta.json' ? 'latest.json' : n), onRequest: (r) => seen.push(r) });

    // Act
    const beta = await fetch(`${server.url}/beta.json`);
    const head = await fetch(`${server.url}/latest.json`, { method: 'HEAD' });
    const missing = await fetch(`${server.url}/stable.json`);

    // Assert
    expect(await beta.json()).toEqual({ version: '9.9.9' });
    expect([head.status, head.headers.get('content-length'), missing.status]).toEqual([200, '19', 404]);
    expect(seen).toEqual([
      { method: 'GET', path: '/beta.json', status: 200 },
      { method: 'HEAD', path: '/latest.json', status: 200 },
      { method: 'GET', path: '/stable.json', status: 404 },
    ]);
  });
});

describe('poll', () => {
  it('resolves with the first truthy value, a throw meaning "not yet"', async () => {
    // Arrange
    let calls = 0;
    const fn = () => {
      calls++;
      if (calls < 3) throw new Error('not listening yet');
      return { phase: 'live' };
    };

    // Act
    const value = await poll(fn, { timeoutMs: 5000, everyMs: 1, what: 'the live' });

    // Assert
    expect(value).toEqual({ phase: 'live' });
    expect(calls).toBe(3);
  });

  it('fails at once on a WaitError: a definite failure is not waited out', async () => {
    // Arrange
    const fn = () => {
      throw new WaitError('start failed: rtmp port in use');
    };

    // Act
    const err = await poll(fn, { timeoutMs: 60_000, what: 'the live link' }).catch((e: Error) => e);

    // Assert
    expect(err).toBeInstanceOf(WaitError);
    expect((err as Error).message).toBe('start failed: rtmp port in use');
  });

  it('fails at once when a process it depends on exits, with its last output', async () => {
    // Arrange
    const { exit, proc } = owner();
    const waiting = poll(() => null, { timeoutMs: 60_000, what: 'the panel URL', abortOn: [proc] });

    // Act
    exit();
    const err = await waiting.catch((e: Error) => e);

    // Assert
    expect((err as Error).message).toMatch(/^the panel URL: fake app exited \(code 3\)/);
    expect((err as Error).message).toContain('last line of the fake app');
  });

  it('names what it waited for and the last error when the deadline passes', async () => {
    // Act
    const err = await poll(
      () => {
        throw new Error('ECONNREFUSED');
      },
      { timeoutMs: 50, everyMs: 10, what: 'phase live', detail: () => 'phase waiting-obs' },
    ).catch((e: Error) => e);

    // Assert
    expect((err as Error).message).toMatch(/^timed out waiting for phase live after \d+ ms \(phase waiting-obs; last error: ECONNREFUSED\)$/);
  });
});

describe('orTimeout', () => {
  it('is the value of an event that comes in time', async () => {
    // Act
    const code = await orTimeout(Promise.resolve(0), 60_000, 'timeout');

    // Assert
    expect(code).toBe(0);
  });

  it('is the fallback once the time passed', async () => {
    // Arrange
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const never = new Promise<number>(() => {});
    const result = orTimeout(never, 45_000, 'timeout');

    // Act
    await vi.advanceTimersByTimeAsync(45_000);

    // Assert
    await expect(result).resolves.toBe('timeout');
  });
});

describe('isListening', () => {
  it('is true while a server listens on the port and false once it closed', async () => {
    // Arrange
    const server = net.createServer((s) => s.destroy());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;

    // Act
    const open = await isListening(port);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const closed = await isListening(port);

    // Assert
    expect([open, closed]).toEqual([true, false]);
  });
});

describe('junitXml', () => {
  it('makes a failure of a failed check and a skipped case of a skip, and escapes text', () => {
    // Arrange
    const cases = [
      { group: '1. local mode', name: 'viewer plays in <Firefox>', status: 'fail', detail: 'page.waitForURL: Timeout 60000ms exceeded.\nmore' },
      { group: '3. tunnel', name: 'uninstaller', status: 'skip', detail: 'not in this release' },
      { group: '3. tunnel', name: 'cloudflared gone', status: 'pass' },
    ] as const;

    // Act
    const out = junitXml('app on windows-2025', cases);

    // Assert
    expect(out).toContain('<testsuite name="app on windows-2025" tests="3" failures="1" skipped="1">');
    expect(out).toContain('<testcase classname="1. local mode" name="viewer plays in &lt;Firefox&gt;" time="0.000">');
    expect(out).toContain('<failure message="page.waitForURL: Timeout 60000ms exceeded.">page.waitForURL: Timeout 60000ms exceeded.\nmore</failure>');
    expect(out).toContain('<skipped message="not in this release"/>');
    expect(out).toContain('<testcase classname="3. tunnel" name="cloudflared gone" time="0.000"/>');
  });

  it('refuses a verdict other than pass, fail or skip', () => {
    // Arrange
    const cases = [{ name: 'tray helper', status: 'warn' }] as unknown as Parameters<typeof junitXml>[1];

    // Act
    const write = () => junitXml('s', cases);

    // Assert
    expect(write).toThrow('junitXml: "tray helper" has status "warn" (pass, fail or skip)');
  });

  it('drops the control characters XML 1.0 cannot hold', () => {
    // Act
    const out = junitXml('s', [{ name: 'ffmpeg said \u001b[31mred\u0007', status: 'pass' }]);

    // Assert
    expect(out).toContain('name="ffmpeg said [31mred"');
  });
});
