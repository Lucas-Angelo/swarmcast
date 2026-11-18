import net from 'node:net';

// The few W3C WebDriver commands the iOS tests use (https://www.w3.org/TR/webdriver2/), over
// fetch: safaridriver speaks W3C WebDriver, and these commands are small enough not to need a
// client library. Every failed command throws with WebDriver's error code and message.

/** The key a W3C element reference is sent and received under. */
export const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

export type ElementRef = { [ELEMENT_KEY]: string };

export class WebDriverError extends Error {
  override name = 'WebDriverError';
  constructor(
    /** W3C error code ("no such element", "session not created"...), or "http <status>" for a non-WebDriver answer. */
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export interface Capabilities {
  [name: string]: unknown;
}

/**
 * A W3C touch tap at `x`, `y` CSS pixels of the viewport (the page's client coordinates): one
 * pointer input source of type "touch", moved there, put down and lifted (WebDriver 2, "Actions":
 * pointerMove with the "viewport" origin, pointerDown, pointerUp).
 *
 * On iOS 26 the pointerUp lifts nothing: Release Actions does (Session.perform's `DELETE
 * /actions`, Automation.cancelInteractionSequence). safaridriver sends pointerUp, and every state
 * after it, with the button still pressed (mouseInteraction "Up", pressedButton "Left"), and
 * WebKit's automation before 317834@main (WebKit bug 319610, July 2026) lifts a touch only when
 * the button goes from pressed to not. In every tap of release rehearsal 44243243561 the
 * touchend's time stamp was the moment safaridriver sent cancelInteractionSequence (0 to 9 ms);
 * sent as a second request once the first was answered, it came 2.3 s after the touchstart on
 * the loaded Mac (the sequence answered in 1.27 s, the test process sent the DELETE 0.5 s later,
 * Safari answered safaridriver's check before it 0.55 s later): a long press, no click. Nothing
 * else lifts it sooner (Devices runs 44249240892, 44316576336, 6 to 13 taps each): a pause of 0
 * or 50 ms, a move to the same point, with the "pointer" origin or 1 px away, a second pointerUp
 * or a second pointer source after the pointerUp all went with the button pressed and were lifted
 * by Release Actions; pointerCancel is "not currently supported"; Element Click left the finger
 * down. A real finger cannot stand in: an XCUITest tap at the element's frame reached Safari's
 * page with no event at all, 15 of 15, while safaridriver drove it (Devices run 44320302733). So
 * Session.perform sends Release Actions on the same connection right behind Perform Actions
 * (lifted 1 to 6 ms after the answer, Devices run 44323844014), the time down is Safari's
 * handling of the touch and of safaridriver's commands, and the tap record checks it
 * (tap-record.ts, actionability.ts tapEndsInClick). A WebKit with the fix lifts the finger at the
 * pointerUp, which the same record will show.
 */
export function tapActions(x: number, y: number): unknown {
  return {
    actions: [
      {
        type: 'pointer',
        id: 'finger',
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, origin: 'viewport', x: Math.round(x), y: Math.round(y) },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ],
  };
}

async function command<T>(base: URL, method: 'GET' | 'POST' | 'DELETE', pathname: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
  const res = await fetch(new URL(pathname, base), {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return answerValue<T>(res.status, await res.text());
}

/** The W3C `value` of an answer with HTTP status `status` and body `text`; throws WebDriverError for an error or a body that is not JSON. */
function answerValue<T>(status: number, text: string): T {
  let parsed: { value?: unknown } | null;
  try {
    parsed = JSON.parse(text) as { value?: unknown } | null;
  } catch {
    throw new WebDriverError(`http ${status}`, text.slice(0, 500) || '(empty answer)');
  }
  const value = parsed?.value as { error?: unknown; message?: unknown } | undefined;
  if (status < 200 || status > 299 || (value && typeof value === 'object' && typeof value.error === 'string')) {
    throw new WebDriverError(typeof value?.error === 'string' ? value.error : `http ${status}`, typeof value?.message === 'string' ? value.message : text.slice(0, 500));
  }
  return parsed?.value as T;
}

/** One HTTP/1.1 answer read off a connection: its status and body. */
interface RawAnswer {
  status: number;
  body: string;
}

/**
 * The body of a chunked answer that starts at `start` of `buf`, and where it ends; null while it
 * is not complete (RFC 9112 7.1: hex size lines, the data, a last chunk of size 0, no trailers).
 */
function chunkedBody(buf: Buffer, start: number): { body: Buffer; end: number } | null {
  const parts: Buffer[] = [];
  let at = start;
  for (;;) {
    const line = buf.indexOf('\r\n', at);
    if (line < 0) return null;
    const size = parseInt(buf.subarray(at, line).toString('latin1').split(';')[0]!, 16);
    if (Number.isNaN(size)) throw new WebDriverError('http chunked', 'a chunk size that is not a number');
    if (size === 0) return buf.length < line + 4 ? null : { body: Buffer.concat(parts), end: line + 4 };
    if (buf.length < line + 2 + size + 2) return null;
    parts.push(buf.subarray(line + 2, line + 2 + size));
    at = line + 2 + size + 2;
  }
}

/**
 * Splits the complete HTTP/1.1 answers at the start of `buf` (with a Content-Length, as
 * safaridriver sends them, or chunked): the answers and the bytes after them.
 */
export function splitAnswers(buf: Buffer): { answers: RawAnswer[]; rest: Buffer } {
  const answers: RawAnswer[] = [];
  let rest = buf;
  for (;;) {
    const end = rest.indexOf('\r\n\r\n');
    if (end < 0) break;
    const head = rest.subarray(0, end).toString('latin1');
    const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? NaN);
    if (/^transfer-encoding:\s*chunked/im.test(head)) {
      const chunked = chunkedBody(rest, end + 4);
      if (!chunked) break;
      answers.push({ status, body: chunked.body.toString('utf8') });
      rest = rest.subarray(chunked.end);
      continue;
    }
    const length = Number(/^content-length:\s*(\d+)/im.exec(head)?.[1] ?? 0);
    if (rest.length < end + 4 + length) break;
    answers.push({ status, body: rest.subarray(end + 4, end + 4 + length).toString('utf8') });
    rest = rest.subarray(end + 4 + length);
  }
  return { answers, rest };
}

/** Whether the WebDriver server at `base` answers /status with ready: true. */
export async function ready(base: URL): Promise<boolean> {
  try {
    return (await command<{ ready?: boolean }>(base, 'GET', '/status', undefined, 2_000)).ready === true;
  } catch {
    return false;
  }
}

export class Session {
  private constructor(
    private readonly base: URL,
    readonly id: string,
    readonly capabilities: Capabilities,
  ) {}

  /** New Session with `alwaysMatch` capabilities; `timeoutMs` covers the browser's start. */
  static async create(base: URL, alwaysMatch: Capabilities, timeoutMs = 300_000): Promise<Session> {
    const v = await command<{ sessionId: string; capabilities: Capabilities }>(base, 'POST', '/session', { capabilities: { alwaysMatch } }, timeoutMs);
    return new Session(base, v.sessionId, v.capabilities);
  }

  private cmd<T>(method: 'GET' | 'POST' | 'DELETE', pathname: string, body?: unknown): Promise<T> {
    return command<T>(this.base, method, `/session/${this.id}${pathname}`, body);
  }

  async navigate(url: string): Promise<void> {
    await this.cmd('POST', '/url', { url });
  }

  url(): Promise<string> {
    return this.cmd<string>('GET', '/url');
  }

  /** Execute Script: `script` is a function body; `args` arrive as `arguments`. */
  execute<T>(script: string, args: unknown[] = []): Promise<T> {
    return this.cmd<T>('POST', '/execute/sync', { script, args });
  }

  async find(selector: string): Promise<ElementRef> {
    return this.cmd<ElementRef>('POST', '/element', { using: 'css selector', value: selector });
  }

  async click(element: ElementRef): Promise<void> {
    await this.cmd('POST', `/element/${element[ELEMENT_KEY]}/click`, {});
  }

  async sendKeys(element: ElementRef, text: string): Promise<void> {
    await this.cmd('POST', `/element/${element[ELEMENT_KEY]}/value`, { text });
  }

  /**
   * Perform Actions, then Release Actions (which lifts whatever is still pressed), written back to
   * back on one connection: safaridriver reads a connection's requests one after the other, so it
   * starts Release Actions as soon as it has answered Perform Actions, with no turn of this
   * process in between (on iOS 26 only Release Actions lifts a finger: tapActions). Two separate
   * requests left the finger down while this process read the answer and sent the next one (0.5 s
   * of the 2.3 s long press of release rehearsal 44243243561), and two connections at once let
   * Release Actions run first (Devices run 44316576336). Returns when Perform Actions was answered
   * (epoch ms, as this process read it): what the actions did happened before it.
   */
  perform(actions: unknown, timeoutMs = 60_000): Promise<number> {
    const body = Buffer.from(JSON.stringify(actions), 'utf8');
    const path = `/session/${this.id}/actions`;
    const host = `Host: ${this.base.host}\r\n`;
    const request = Buffer.concat([
      Buffer.from(`POST ${path} HTTP/1.1\r\n${host}Content-Type: application/json; charset=utf-8\r\nContent-Length: ${body.length}\r\n\r\n`, 'latin1'),
      body,
      Buffer.from(`DELETE ${path} HTTP/1.1\r\n${host}Content-Length: 0\r\nConnection: close\r\n\r\n`, 'latin1'),
    ]);
    return new Promise<number>((resolve, reject) => {
      const socket = net.connect(Number(this.base.port), this.base.hostname);
      let received = Buffer.alloc(0);
      let answered = 0;
      let settled = false;
      const finish = (error: Error | null) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error);
        else resolve(answered);
      };
      socket.setTimeout(timeoutMs, () => finish(new WebDriverError('timeout', `no answer to Perform and Release Actions within ${timeoutMs} ms`)));
      socket.on('connect', () => socket.write(request));
      socket.on('data', (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        try {
          const { answers } = splitAnswers(received);
          if (answers.length >= 1 && !answered) answered = Date.now();
          if (answers.length < 2) return;
          for (const a of answers.slice(0, 2)) answerValue(a.status, a.body);
          finish(null);
        } catch (e) {
          finish(e as Error);
        }
      });
      socket.on('error', (e) => finish(e));
      socket.on('close', () => finish(new WebDriverError('http closed', `the connection closed before both answers came (${received.length} bytes read)`)));
    });
  }

  /** The handles of the session's windows (tabs). */
  windowHandles(): Promise<string[]> {
    return this.cmd<string[]>('GET', '/window/handles');
  }

  /** The text of the user prompt (alert, confirm) the page shows; null when there is none ("no such alert"). */
  async alertText(): Promise<string | null> {
    try {
      return await this.cmd<string>('GET', '/alert/text');
    } catch (e) {
      if (e instanceof WebDriverError && e.code === 'no such alert') return null;
      throw e;
    }
  }

  /** The browser's viewport as a PNG. */
  async screenshot(): Promise<Buffer> {
    return Buffer.from(await this.cmd<string>('GET', '/screenshot'), 'base64');
  }

  async delete(): Promise<void> {
    await this.cmd('DELETE', '');
  }
}
