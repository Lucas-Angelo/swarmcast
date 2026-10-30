import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, onTestFinished } from 'vitest';
import { ELEMENT_KEY, ready, Session, tapActions, WebDriverError } from '../devices/webdriver.js';

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

  it('taps with one touch pointer in the middle of the element, then releases the input state', async () => {
    // Arrange
    const element = { [ELEMENT_KEY]: 'e9' };
    const driver = await fakeDriver((r) => (r.path === '/session' ? NEW_SESSION : { value: null }));
    const session = await Session.create(driver.base, {});
    // Act
    await session.perform(tapActions(element));
    // Assert
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
              actions: [{ type: 'pointerMove', duration: 0, origin: element, x: 0, y: 0 }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }],
            },
          ],
        },
      },
      { method: 'DELETE', path: '/session/s1/actions', body: undefined },
    ]);
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
