import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, onTestFinished } from 'vitest';
import { ELEMENT_KEY, ready, Session, splitAnswers, tapActions, WebDriverError } from '../devices/webdriver.js';

// The W3C WebDriver client of the device suite (apps/server/test/devices/webdriver.ts) against a
// fake WebDriver server on 127.0.0.1, port 0: the requests it sends (method, path, JSON body) and
// how it reads the answers (the W3C `value`, W3C errors, answers that are not JSON). The iOS
// device tests run it against safaridriver on macOS 26 only (devices.yml); this runs everywhere.

interface Request {
  method: string;
  path: string;
  body: unknown;
}

type Answer = { status?: number; value: unknown } | { status: number; raw: string };

/** A fake WebDriver server: answers each request with `answer(request)`, records every request. */
async function fakeDriver(answer: (req: Request) => Answer): Promise<{ base: URL; requests: Request[] }> {
  const requests: Request[] = [];
  const server = http.createServer((req, res) => {
    let text = '';
    req.on('data', (c: Buffer) => (text += c.toString()));
    req.on('end', () => {
      const request = { method: req.method ?? '', path: req.url ?? '', body: text ? (JSON.parse(text) as unknown) : undefined };
      requests.push(request);
      const a = answer(request);
      if ('raw' in a) res.writeHead(a.status, { 'content-type': 'text/plain' }).end(a.raw);
      else res.writeHead(a.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify({ value: a.value }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { base: new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`), requests };
}

const NEW_SESSION = { value: { sessionId: 's1', capabilities: { browserName: 'Safari', platformName: 'iOS' } } };

describe('the device suite WebDriver client', () => {
  it('asks for a session with the capabilities under alwaysMatch and keeps its id and capabilities', async () => {
    // Arrange
    const driver = await fakeDriver(() => NEW_SESSION);
    // Act
    const session = await Session.create(driver.base, { browserName: 'Safari', 'safari:useSimulator': true });
    // Assert
    expect(driver.requests).toEqual([{ method: 'POST', path: '/session', body: { capabilities: { alwaysMatch: { browserName: 'Safari', 'safari:useSimulator': true } } } }]);
    expect(session.id).toBe('s1');
    expect(session.capabilities).toEqual({ browserName: 'Safari', platformName: 'iOS' });
  });

  it('sends each command to its W3C endpoint of the session', async () => {
    // Arrange
    const element = { [ELEMENT_KEY]: 'e7' };
    const driver = await fakeDriver((r) => (r.path === '/session' ? NEW_SESSION : r.path.endsWith('/element') ? { value: element } : r.path.endsWith('/url') && r.method === 'GET' ? { value: 'http://127.0.0.1:1/watch' } : { value: null }));
    const session = await Session.create(driver.base, {});
    // Act
    await session.navigate('http://127.0.0.1:1/join');
    const url = await session.url();
    const found = await session.find('#join');
    await session.click(found);
    await session.sendKeys(found, 'Bia');
    await session.execute('return arguments[0];', [found]);
    await session.delete();
    // Assert
    expect(url).toBe('http://127.0.0.1:1/watch');
    expect(found).toEqual(element);
    expect(driver.requests.slice(1)).toEqual([
      { method: 'POST', path: '/session/s1/url', body: { url: 'http://127.0.0.1:1/join' } },
      { method: 'GET', path: '/session/s1/url', body: undefined },
      { method: 'POST', path: '/session/s1/element', body: { using: 'css selector', value: '#join' } },
      { method: 'POST', path: '/session/s1/element/e7/click', body: {} },
      { method: 'POST', path: '/session/s1/element/e7/value', body: { text: 'Bia' } },
      { method: 'POST', path: '/session/s1/execute/sync', body: { script: 'return arguments[0];', args: [element] } },
      { method: 'DELETE', path: '/session/s1', body: undefined },
    ]);
  });

  it('taps with one touch pointer at a point of the viewport, rounded to whole pixels, then releases the input state, saying when the actions were answered', async () => {
    // Arrange
    const driver = await fakeDriver((r) => (r.path === '/session' ? NEW_SESSION : { value: null }));
    const session = await Session.create(driver.base, {});
    const before = Date.now();
    // Act
    const answered = await session.perform(tapActions(139.15, 356.92));
    // Assert
    expect(answered).toBeGreaterThanOrEqual(before);
    expect(answered).toBeLessThanOrEqual(Date.now());
    expect(driver.requests.slice(1)).toEqual([
      {
        method: 'POST',
        path: '/session/s1/actions',
        body: {
          actions: [
            {
              type: 'pointer',
              id: 'finger',
              parameters: { pointerType: 'touch' },
              actions: [{ type: 'pointerMove', duration: 0, origin: 'viewport', x: 139, y: 357 }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }],
            },
          ],
        },
      },
      { method: 'DELETE', path: '/session/s1/actions', body: undefined },
    ]);
  });

  it('sends Release Actions on the same connection before Perform Actions is answered', async () => {
    // Arrange
    const raw = new Map<object, string>();
    const sockets = new Set<object>();
    let releaseBeforeAnswer = false;
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const answer = (value: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
        if (req.url === '/session') return answer(NEW_SESSION);
        sockets.add(req.socket);
        if (req.method !== 'POST') return answer({ value: null });
        // Perform Actions is answered once the connection has also brought Release Actions (or after 2 s).
        const check = setInterval(() => {
          if (!(raw.get(req.socket) ?? '').includes('DELETE /session/s1/actions HTTP/1.1')) return;
          clearInterval(check);
          clearTimeout(giveUp);
          releaseBeforeAnswer = true;
          answer({ value: null });
        }, 5);
        const giveUp = setTimeout(() => {
          clearInterval(check);
          answer({ value: null });
        }, 2_000);
      });
    });
    server.on('connection', (socket) => socket.on('data', (d: Buffer) => raw.set(socket, (raw.get(socket) ?? '') + d.toString())));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const session = await Session.create(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`), {});
    // Act
    await session.perform(tapActions(10, 20));
    // Assert
    expect(releaseBeforeAnswer).toBe(true);
    expect(sockets.size).toBe(1);
  });

  it('fails a tap with the W3C error of Perform Actions, once Release Actions is answered too', async () => {
    // Arrange
    const driver = await fakeDriver((r) => (r.path === '/session' ? NEW_SESSION : r.method === 'POST' ? { status: 400, value: { error: 'invalid argument', message: 'bad action' } } : { value: null }));
    const session = await Session.create(driver.base, {});
    // Act
    const failure = session.perform(tapActions(10, 20));
    // Assert
    await expect(failure).rejects.toMatchObject({ code: 'invalid argument', message: 'invalid argument: bad action' });
    expect(driver.requests.slice(1).map((r) => r.method)).toEqual(['POST', 'DELETE']);
  });

  it('splits answers read off a connection by their Content-Length or their chunks, and keeps a partial one for later', () => {
    // Arrange
    const buf = Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 14\r\n\r\n{"value":null}HTTP/1.1 404 Not Found\r\nTransfer-Encoding: chunked\r\n\r\n1\r\n{\r\n1\r\n}\r\n0\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n{"va');
    // Act
    const { answers, rest } = splitAnswers(buf);
    // Assert
    expect(answers).toEqual([
      { status: 200, body: '{"value":null}' },
      { status: 404, body: '{}' },
    ]);
    expect(rest.toString()).toBe('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n{"va');
  });

  it('turns a W3C error answer into a WebDriverError with its code and message', async () => {
    // Arrange
    const driver = await fakeDriver(() => ({ status: 500, value: { error: 'session not created', message: 'Could not find any session hosts that match the requested capabilities.', stacktrace: '' } }));
    // Act
    const failure = Session.create(driver.base, { platformName: 'iOS' });
    // Assert
    await expect(failure).rejects.toThrow(WebDriverError);
    await expect(failure).rejects.toMatchObject({ code: 'session not created', message: 'session not created: Could not find any session hosts that match the requested capabilities.' });
  });

  it('turns an answer that is not JSON into a WebDriverError with the HTTP status', async () => {
    // Arrange
    const driver = await fakeDriver(() => ({ status: 502, raw: 'Bad Gateway' }));
    // Act
    const failure = Session.create(driver.base, {});
    // Assert
    await expect(failure).rejects.toMatchObject({ code: 'http 502', message: 'http 502: Bad Gateway' });
  });

  it('decodes the base64 PNG of a screenshot', async () => {
    // Arrange
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const driver = await fakeDriver((r) => (r.path === '/session' ? NEW_SESSION : { value: png.toString('base64') }));
    const session = await Session.create(driver.base, {});
    // Act
    const shot = await session.screenshot();
    // Assert
    expect(shot.equals(png)).toBe(true);
    expect(driver.requests[1]).toEqual({ method: 'GET', path: '/session/s1/screenshot', body: undefined });
  });

  it.each([
    { status: { ready: true, message: '' }, expected: true },
    { status: { ready: false, message: 'busy' }, expected: false },
  ])('ready() is $expected when /status says ready: $status.ready', async ({ status, expected }) => {
    // Arrange
    const driver = await fakeDriver(() => ({ value: status }));
    // Act
    const answer = await ready(driver.base);
    // Assert
    expect(answer).toBe(expected);
    expect(driver.requests).toEqual([{ method: 'GET', path: '/status', body: undefined }]);
  });

  it('ready() is false when nothing listens', async () => {
    // Arrange
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const closed = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Act
    const answer = await ready(closed);
    // Assert
    expect(answer).toBe(false);
  });
});
