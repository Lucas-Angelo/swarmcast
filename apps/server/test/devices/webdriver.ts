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

/** A W3C touch tap (pointer down and up) at `dx`, `dy` CSS pixels from the middle of the element's part in view. */
export function tapActions(element: ElementRef, dx = 0, dy = 0): unknown {
  return {
    actions: [
      {
        type: 'pointer',
        id: 'finger',
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, origin: element, x: Math.round(dx), y: Math.round(dy) },
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
  const text = await res.text();
  let parsed: { value?: unknown } | null;
  try {
    parsed = JSON.parse(text) as { value?: unknown } | null;
  } catch {
    throw new WebDriverError(`http ${res.status}`, text.slice(0, 500) || '(empty answer)');
  }
  const value = parsed?.value as { error?: unknown; message?: unknown } | undefined;
  if (!res.ok || (value && typeof value === 'object' && typeof value.error === 'string')) {
    throw new WebDriverError(typeof value?.error === 'string' ? value.error : `http ${res.status}`, typeof value?.message === 'string' ? value.message : text.slice(0, 500));
  }
  return parsed?.value as T;
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

  async perform(actions: unknown): Promise<void> {
    await this.cmd('POST', '/actions', actions);
    await this.cmd('DELETE', '/actions');
  }

  /** The browser's viewport as a PNG. */
  async screenshot(): Promise<Buffer> {
    return Buffer.from(await this.cmd<string>('GET', '/screenshot'), 'base64');
  }

  async delete(): Promise<void> {
    await this.cmd('DELETE', '');
  }
}
