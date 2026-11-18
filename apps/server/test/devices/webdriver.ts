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
 * /actions`, Automation.cancelInteractionSequence), so the finger's time down is the host's round
 * trip between the two requests, which no action here can bound. safaridriver sends pointerUp,
 * and every state after it, with the button still pressed (mouseInteraction "Up", pressedButton
 * "Left"), and WebKit's automation before 317834@main (WebKit bug 319610, July 2026) lifts a touch
 * only when the button goes from pressed to not. In every tap of release rehearsal 44243243561 the
 * touchend's time stamp was the moment safaridriver sent cancelInteractionSequence (0 to 9 ms);
 * with the Mac 0.3 % idle that came 2.3 s after the touchstart (the sequence answered in 1.27 s,
 * the test process sent the DELETE 0.5 s later, Safari answered safaridriver's check before it
 * 0.55 s later): a long press, no click. A move to the same point after the pointerUp did not lift
 * either (Devices run 44249240892: safaridriver sent it with pressedButton "Left" too, and all 13
 * taps were lifted by Release Actions). So the tap record says when the finger was lifted against
 * the answer to Perform Actions, and a finger held for a long press fails as the harness's
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

  /**
   * Perform Actions, then Release Actions (which lifts whatever is still pressed). Returns when
   * Perform Actions was answered (epoch ms): everything the actions did happened before it, and
   * whatever only Release Actions did, after it (tapActions, actionability.ts describeTap).
   */
  async perform(actions: unknown): Promise<number> {
    await this.cmd('POST', '/actions', actions);
    const answered = Date.now();
    await this.cmd('DELETE', '/actions');
    return answered;
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
