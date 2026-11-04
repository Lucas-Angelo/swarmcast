// The shared helpers of the system harnesses (scripts/test/lib): the waits
// that return a value or end at a deadline, the port probe, the JUnit view of a harness's
// results, the cookie jar of the fetch-based browsers and the environment of a launched Firefox. Servers listen on 127.0.0.1 port 0 (no
// collision, no firewall prompt) and every folder and server a test makes is removed by
// onTestFinished, servers before their folder.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { TUNNEL_START_BUDGET_MS } from '../../../apps/server/src/tunnel/start-budget.js';
import { bareEnv, LIVE_LINK_WAIT_MS } from '../lib/app.mjs';
import { CookieJar, parseSetCookie } from '../lib/cookie-jar.mjs';
import { browserTempOnWorkDisk, userTempEnv } from '../lib/browser-temp.mjs';
import { firefoxEnv, firefoxPrefs } from '../lib/firefox.mjs';
import { junitXml } from '../lib/junit.mjs';
import { isListening } from '../lib/ports.mjs';
import { waitForTunnelName } from '../lib/viewer.mjs';
import { orTimeout, poll, WaitError } from '../lib/wait.mjs';

/** A process that waits can depend on (wait.mjs Owner), which exits when `exit()` is called. */
function owner() {
  let exit!: () => void;
  const exited = new Promise<{ code: number; signal: null }>((resolve) => (exit = () => resolve({ code: 3, signal: null })));
  return { exit, proc: { name: 'fake app', exited, tail: () => 'last line of the fake app' } };
}

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

/** A site on 127.0.0.1 port 0 that answers each request with `answer(url)`, and what it was sent. */
async function site(answer: (url: string) => { status?: number; headers?: http.OutgoingHttpHeaders }) {
  const seen: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    const a = answer(req.url ?? '');
    res.writeHead(a.status ?? 200, a.headers ?? {}).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { base: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, seen };
}

/** An answer that sets `lines`, one Set-Cookie header each. */
const setting = (...lines: string[]): Response => new Response(null, { headers: lines.map((l) => ['set-cookie', l] as [string, string]) });

describe('CookieJar', () => {
  it('sends back the cookies an answer set, on every address of the site', async () => {
    // Arrange
    const s = await site((url) => (url === '/login' ? { headers: { 'set-cookie': ['session=s1; Path=/; HttpOnly', 'device=d1; Max-Age=3600'] } } : {}));
    const jar = new CookieJar(s.base);

    // Act
    await jar.fetch('/login');
    await jar.fetch(`${s.base}/watch/live`);

    // Assert
    expect(s.seen.map((r) => [r.url, r.headers.cookie ?? ''])).toEqual([
      ['/login', ''],
      ['/watch/live', 'session=s1; device=d1'],
    ]);
    expect(jar.setCookies).toEqual(['session=s1; Path=/; HttpOnly', 'device=d1; Max-Age=3600']);
  });

  it('never follows a redirect, and sends its own headers with every request (a request\'s own win)', async () => {
    // Arrange
    const s = await site((url) => (url === '/join/abc' ? { status: 303, headers: { location: '/join', 'set-cookie': 'ticket=t1; Max-Age=300' } } : {}));
    const jar = new CookieJar(s.base, { headers: { 'cf-connecting-ip': '198.18.0.7', 'x-from': 'jar' } });

    // Act
    const opened = await jar.fetch('/join/abc');
    await jar.fetch('/api/join', { method: 'POST', headers: { 'x-from': 'request' } });

    // Assert
    expect(opened.status).toBe(303);
    expect(s.seen.map((r) => r.url)).toEqual(['/join/abc', '/api/join']);
    expect(s.seen[1]!.headers).toMatchObject({ 'cf-connecting-ip': '198.18.0.7', 'x-from': 'request', cookie: 'ticket=t1' });
  });

  it('drops a cookie the answer expires: Max-Age 0 or less, or an Expires that has passed', () => {
    // Arrange
    const jar = new CookieJar();
    jar.store(setting('a=1', 'b=2', 'c=3', 'd=4'));

    // Act
    jar.store(setting('a=; Max-Age=0', 'b=; Expires=Thu, 01 Jan 1970 00:00:00 GMT', 'c=3; Max-Age=-1', 'd=5; Expires=Fri, 01 Jan 2100 00:00:00 GMT'));

    // Assert
    expect(jar.header()).toBe('d=5');
    expect([jar.has('a'), jar.get('d')]).toEqual([false, '5']);
  });

  it('lets Max-Age win over Expires, and ignores an attribute that is not a number or a date', () => {
    // Arrange
    const now = Date.parse('2026-10-30T12:00:00Z');
    const lines = ['a=1; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT', 'b=2; Max-Age=0; Expires=Fri, 01 Jan 2100 00:00:00 GMT', 'c=3; Max-Age=soon', 'd=4; Expires=tomorrow', 'e', ' f = 6 ; Path=/'];

    // Act
    const parsed = lines.map((l) => parseSetCookie(l, now));

    // Assert
    expect(parsed).toEqual([
      { name: 'a', value: '1', expired: false },
      { name: 'b', value: '2', expired: true },
      { name: 'c', value: '3', expired: false },
      { name: 'd', value: '4', expired: false },
      null,
      { name: 'f', value: '6', expired: false },
    ]);
  });

  it('takes a cookie put in by hand, as one browser handing another its cookie', async () => {
    // Arrange
    const s = await site(() => ({}));
    const jar = new CookieJar(s.base);

    // Act
    jar.set('sc_verified', 'v1.1.x');
    await jar.fetch('/api/join/challenge');

    // Assert
    expect(s.seen[0]!.headers.cookie).toBe('sc_verified=v1.1.x');
  });
});

describe('firefoxEnv', () => {
  it('keeps the given variables and names a startup cache file that cannot be created', () => {
    // Act
    const env = firefoxEnv({ KEEP: 'me' });
    const again = firefoxEnv({});

    // Assert
    expect(env.KEEP).toBe('me');
    const file = env.MOZ_STARTUP_CACHE!;
    expect(path.isAbsolute(file)).toBe(true);
    expect(again.MOZ_STARTUP_CACHE).toBe(file);
    expect(fs.existsSync(path.dirname(path.dirname(file)))).toBe(true);
    expect(() => fs.openSync(file, 'w')).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });
});

describe('waitForTunnelName', () => {
  const LINK = 'https://brand-new-name.trycloudflare.com/join/token';

  it('asks this machine only once Cloudflare knows the name, so its resolver never remembers it as unknown', async () => {
    // Arrange
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    const calls: string[] = [];
    let known = false;
    const resolve4 = async (host: string): Promise<string[]> => {
      calls.push(`cloudflare ${host}`);
      if (!known) throw Object.assign(new Error(`queryA ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return ['104.16.0.1'];
    };
    const lookup = async (host: string): Promise<unknown> => {
      calls.push(`os ${host}`);
      return { address: '104.16.0.1', family: 4 };
    };
    const lines: string[] = [];

    // Act
    const waiting = waitForTunnelName(LINK, (l) => lines.push(l), { resolve4, lookup });
    known = true;
    await vi.advanceTimersByTimeAsync(5_000);
    await waiting;

    // Assert
    expect(calls).toEqual(['cloudflare brand-new-name.trycloudflare.com', 'cloudflare brand-new-name.trycloudflare.com', 'os brand-new-name.trycloudflare.com']);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^infra recovery: DNS: brand-new-name\.trycloudflare\.com known to 1\.1\.1\.1 after \d+ s \(1 lookups there said unknown/);
  });

  it('returns at once for a host that is not a quick tunnel', async () => {
    // Arrange
    const resolve4 = vi.fn(async () => ['127.0.0.1']);
    const lookup = vi.fn(async () => ({ address: '127.0.0.1', family: 4 }));

    // Act
    await waitForTunnelName('http://127.0.0.1:8080/join/token', () => {}, { resolve4, lookup });

    // Assert
    expect(resolve4).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('browserTempOnWorkDisk', () => {
  const USER = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp';
  const WORK = 'D:\\a\\_temp';

  it("on a Windows runner, puts the temporary folder, and with it Playwright's browser profiles, in RUNNER_TEMP on the local disk", () => {
    // Arrange
    const env: NodeJS.ProcessEnv = { RUNNER_TEMP: WORK, TEMP: USER, TMP: USER };

    // Act
    const dir = browserTempOnWorkDisk(env, 'win32');
    browserTempOnWorkDisk(env, 'win32');

    // Assert
    expect(dir).toBe(WORK);
    expect(env.TEMP).toBe(WORK);
    expect(env.TMP).toBe(WORK);
    expect(userTempEnv(env)).toEqual({ RUNNER_TEMP: WORK, TEMP: USER, TMP: USER });
  });

  it('changes nothing on a machine that is not a Windows CI runner', () => {
    // Arrange
    const local: NodeJS.ProcessEnv = { TEMP: 'C:\\Temp' };
    const linux: NodeJS.ProcessEnv = { RUNNER_TEMP: '/home/runner/work/_temp', TMPDIR: '/tmp' };

    // Act
    const onLocal = browserTempOnWorkDisk(local, 'win32');
    const onLinux = browserTempOnWorkDisk(linux, 'linux');

    // Assert
    expect(onLocal).toBeUndefined();
    expect(local).toEqual({ TEMP: 'C:\\Temp' });
    expect(userTempEnv(local)).toBe(local);
    expect(onLinux).toBeUndefined();
    expect(linux).toEqual({ RUNNER_TEMP: '/home/runner/work/_temp', TMPDIR: '/tmp' });
  });

  it("gives the app under test this machine's own temporary folder, not the one the harness moved for its browsers", () => {
    // Arrange
    const env: NodeJS.ProcessEnv = { RUNNER_TEMP: WORK, TEMP: USER, TMP: USER };
    browserTempOnWorkDisk(env, 'win32');
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    onTestFinished(() => void vi.unstubAllEnvs());

    // Act
    const app = bareEnv();

    // Assert
    expect(process.env.TEMP).toBe(WORK);
    expect(app.TEMP).toBe(USER);
    expect(app.TMP).toBe(USER);
    expect(Object.keys(app).filter((k) => k.startsWith('SC_USER_'))).toEqual([]);
  });
});

describe('firefoxPrefs', () => {
  it('turns form history off, so one test never finds the names another typed under a field', () => {
    // Act
    const prefs = firefoxPrefs();

    // Assert
    expect(prefs['browser.formfill.enable']).toBe(false);
  });

  it("adds the harness's own preferences", () => {
    // Act
    const prefs = firefoxPrefs({ 'media.autoplay.default': 0 });

    // Assert
    expect(prefs).toEqual({ 'browser.formfill.enable': false, 'media.autoplay.default': 0 });
  });
});

// The harnesses wait for the live link as long as the app's own tunnel step may take, plus a
// minute: never less (they failed while the app was still recovering by design, run 41283791976),
// and the app fails the step itself at its limit with its own error.
describe('how long the harnesses wait for the live link', () => {
  it("is the app's tunnel step limit plus a minute", () => {
    // Act
    const wait = LIVE_LINK_WAIT_MS;
    // Assert
    expect(wait).toBe(TUNNEL_START_BUDGET_MS + 60_000);
  });
});
