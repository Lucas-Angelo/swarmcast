// @vitest-environment happy-dom
// The watch page's Share button (share.ts): shown only once the server allows it and the link is
// in hand, the share sheet where the browser has one, else the clipboard with a visible "Link
// copied", else the link selected in a read-only field; and gone the moment the server says no
// (the streamer's switch, or "Generate new link" for people who joined with the old link).
// navigator and GET /api/share are fakes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShareControl, fetchShareLink, type ShareNavigator } from '../../src/share.js';

const LINK = 'https://abc.trycloudflare.com/join/AbCdEf0123456789_-xyz';

/** The markup of watch.html's share parts. */
function elements() {
  document.body.innerHTML = `
    <span id="share-status" role="status"></span>
    <button id="share" type="button" hidden>Share</button>
    <div id="share-fallback" hidden><label>Copy this link: <input id="share-field" type="text" readonly></label></div>`;
  const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  return { button: $<HTMLButtonElement>('share'), status: $<HTMLSpanElement>('share-status'), fallback: $<HTMLDivElement>('share-fallback'), field: $<HTMLInputElement>('share-field') };
}

/** Lets the click handler's promises settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function setup(o: { nav?: ShareNavigator; fetchLink?: () => Promise<string | null> } = {}) {
  const el = elements();
  const fetchLink = vi.fn(o.fetchLink ?? (async () => LINK));
  const nav = o.nav ?? {};
  const control = createShareControl({ ...el, nav, fetchLink, title: () => 'Ana Plays · live', labels: { copied: 'Link copied' }, copiedMs: 4000 });
  return { control, el, fetchLink, nav };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('share button', () => {
  it('is hidden until the server allows sharing', () => {
    // Arrange
    const { el, fetchLink } = setup();
    // Assert
    expect(el.button.hidden).toBe(true);
    expect(fetchLink).not.toHaveBeenCalled();
  });

  it('shows once allowed, with the link fetched ahead of the click', async () => {
    // Arrange
    const { control, el, fetchLink } = setup();
    // Act
    await control.setAllowed(true);
    // Assert
    expect(fetchLink).toHaveBeenCalledTimes(1);
    expect(el.button.hidden).toBe(false);
    expect(control.link).toBe(LINK);
  });

  it('stays hidden when the server refuses the link', async () => {
    // Arrange
    const { control, el } = setup({ fetchLink: async () => null });
    // Act
    await control.setAllowed(true);
    // Assert
    expect(el.button.hidden).toBe(true);
    expect(control.link).toBeNull();
  });

  it('stays hidden when asking for the link fails (offline)', async () => {
    // Arrange
    const { control, el } = setup({ fetchLink: () => Promise.reject(new TypeError('offline')) });
    // Act
    await control.setAllowed(true);
    // Assert
    expect(el.button.hidden).toBe(true);
  });

  it('hides and forgets the link when the server says no (new link, or the switch turned off)', async () => {
    // Arrange
    const { control, el } = setup();
    await control.setAllowed(true);
    // Act
    await control.setAllowed(false);
    // Assert
    expect(el.button.hidden).toBe(true);
    expect(control.link).toBeNull();
  });

  it('does not show a link that arrives after the server already said no', async () => {
    // Arrange
    let answer: (v: string) => void = () => {};
    const { control, el } = setup({ fetchLink: () => new Promise((resolve) => (answer = resolve)) });
    const asking = control.setAllowed(true);
    // Act
    await control.setAllowed(false);
    answer(LINK);
    await asking;
    // Assert
    expect(el.button.hidden).toBe(true);
    expect(control.link).toBeNull();
  });

  it('asks for the link once while it is in hand (a reconnect says "allowed" again)', async () => {
    // Arrange
    const { control, fetchLink } = setup();
    await control.setAllowed(true);
    // Act
    await control.setAllowed(true);
    // Assert
    expect(fetchLink).toHaveBeenCalledTimes(1);
  });

  it('opens the share sheet with the link where the browser has one', async () => {
    // Arrange
    const share = vi.fn(async () => {});
    const writeText = vi.fn(async () => {});
    const { control, el } = setup({ nav: { share, canShare: () => true, clipboard: { writeText } } });
    await control.setAllowed(true);
    // Act
    el.button.click();
    await settle();
    // Assert
    expect(share).toHaveBeenCalledWith({ title: 'Ana Plays · live', url: LINK });
    expect(writeText).not.toHaveBeenCalled();
  });

  it('does nothing more when the viewer closes the share sheet', async () => {
    // Arrange
    const share = vi.fn(() => Promise.reject(new DOMException('closed', 'AbortError')));
    const writeText = vi.fn(async () => {});
    const { control, el } = setup({ nav: { share, clipboard: { writeText } } });
    await control.setAllowed(true);
    // Act
    el.button.click();
    await settle();
    // Assert
    expect(writeText).not.toHaveBeenCalled();
    expect(el.status.textContent).toBe('');
  });

  it('copies instead when the share sheet fails for another reason', async () => {
    // Arrange
    const share = vi.fn(() => Promise.reject(new DOMException('no target', 'NotAllowedError')));
    const writeText = vi.fn(async () => {});
    const { control, el } = setup({ nav: { share, clipboard: { writeText } } });
    await control.setAllowed(true);
    // Act
    el.button.click();
    await settle();
    // Assert
    expect(writeText).toHaveBeenCalledWith(LINK);
    expect(el.status.textContent).toBe('Link copied');
  });

  it.each([
    ['no share sheet at all', {}],
    ['a share sheet that cannot take this link', { share: async () => {}, canShare: () => false }],
  ])('copies the link and says "Link copied" with %s', async (_what, sheet) => {
    // Arrange
    const writeText = vi.fn(async () => {});
    const { control, el } = setup({ nav: { ...sheet, clipboard: { writeText } } });
    await control.setAllowed(true);
    // Act
    el.button.click();
    await settle();
    // Assert
    expect(writeText).toHaveBeenCalledWith(LINK);
    expect(el.status.textContent).toBe('Link copied');
    expect(el.fallback.hidden).toBe(true);
  });

  it('clears "Link copied" after a few seconds', async () => {
    // Arrange
    const { control, el } = setup({ nav: { clipboard: { writeText: async () => {} } } });
    await control.setAllowed(true);
    el.button.click();
    await settle();
    // Act
    vi.advanceTimersByTime(4000);
    // Assert
    expect(el.status.textContent).toBe('');
  });

  it.each([
    ['the clipboard refuses', { clipboard: { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) } }],
    ['there is no clipboard', {}],
  ])('shows the link selected in a read-only field when %s', async (_what, nav) => {
    // Arrange
    const { control, el } = setup({ nav });
    await control.setAllowed(true);
    // Act
    el.button.click();
    await settle();
    // Assert
    expect(el.fallback.hidden).toBe(false);
    expect(el.field.value).toBe(LINK);
    expect(document.activeElement).toBe(el.field);
    expect(el.status.textContent).toBe('');
  });
});

describe('fetchShareLink', () => {
  const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

  it('asks /api/share with the session cookie and returns the link', async () => {
    // Arrange
    const f = answer(200, { url: LINK });
    // Act
    const link = await fetchShareLink(f as unknown as typeof fetch);
    // Assert
    expect(f).toHaveBeenCalledWith('/api/share', { credentials: 'same-origin', cache: 'no-store' });
    expect(link).toBe(LINK);
  });

  it("accepts a link under a path (the streamer's own reverse proxy)", async () => {
    // Arrange
    const proxied = 'https://example.com/live/join/AbCdEf0123456789_-xyz';
    // Act
    const link = await fetchShareLink(answer(200, { url: proxied }) as unknown as typeof fetch);
    // Assert
    expect(link).toBe(proxied);
  });

  it.each([
    ['a refusal', 404, { error: 'Not found' }],
    ['a rate limit', 429, { error: 'Too many requests' }],
    ['an answer that is not a join link', 200, { url: 'https://evil.example/phish' }],
    ['a link of another scheme', 200, { url: 'javascript:alert(1)//join/abc' }],
    ['an answer without a link', 200, {}],
  ])('gives null for %s', async (_what, status, body) => {
    // Act
    const link = await fetchShareLink(answer(status, body) as unknown as typeof fetch);
    // Assert
    expect(link).toBeNull();
  });
});
