// @vitest-environment happy-dom
// The startup guard (packages/shared/web/startup-guard.mjs): the one inline script of join.html and
// watch.html. When one of the page's own scripts fails to load (a dropped connection), the browser
// never runs it and never asks for it again: the join page then looked ready with "Watch" disabled
// for good (soak run 41194466705, windows-app job 15: one script of the join page failed with
// net::ERR_NO_BUFFER_SPACE and the harness waited 30 s for Watch). The guard reloads the page
// instead, a few times in a row at most, so a server that is gone does not reload it forever.
//
// The guard runs here as the pages carry it, with the window's addEventListener, sessionStorage
// and location replaced by doubles (it uses them as globals, so they come in as same-named
// parameters). The viewer build writes it into the pages with its Vite plugin (startupGuard).
import { describe, expect, it, vi } from 'vitest';
import { STARTUP_GUARD, startupGuard } from '@swarmcast/shared/web/startup-guard';

type Listener = (e: { target: unknown }) => void;

/** sessionStorage double; `blocked` throws like a browser with site data blocked. */
function storage(blocked = false) {
  const items = new Map<string, string>();
  const guard = <T>(fn: () => T): T => {
    if (blocked) throw new DOMException('blocked', 'SecurityError');
    return fn();
  };
  return {
    items,
    getItem: (k: string) => guard(() => items.get(k) ?? null),
    setItem: (k: string, v: string) => guard(() => void items.set(k, String(v))),
    removeItem: (k: string) => guard(() => void items.delete(k)),
  };
}

/** Runs the guard against doubles; `fire(type, target)` delivers a window event to it. */
function startGuard(store = storage()) {
  const listeners: Array<{ type: string; fn: Listener }> = [];
  const addEventListener = (type: string, fn: Listener) => listeners.push({ type, fn });
  const location = { reload: vi.fn() };
  new Function('addEventListener', 'sessionStorage', 'location', STARTUP_GUARD)(addEventListener, store, location);
  const fire = (type: string, target: unknown = window): void => {
    for (const l of listeners.filter((x) => x.type === type)) l.fn({ target });
  };
  return { reload: location.reload, fire, store };
}

const script = (type: string): HTMLScriptElement => Object.assign(document.createElement('script'), { type, src: '/assets/page.js' });

describe('startup guard', () => {
  it('reloads the page when one of its scripts fails to load', () => {
    // Arrange
    const g = startGuard();
    // Act
    g.fire('error', script('module'));
    // Assert
    expect(g.reload).toHaveBeenCalledTimes(1);
  });

  it('leaves other failures alone: an image, a stylesheet, a classic script', () => {
    // Arrange
    const g = startGuard();
    const sheet = Object.assign(document.createElement('link'), { rel: 'stylesheet' });
    // Act
    g.fire('error', document.createElement('img'));
    g.fire('error', sheet);
    g.fire('error', script('text/javascript'));
    g.fire('error', window);
    // Assert
    expect(g.reload).not.toHaveBeenCalled();
  });

  it('leaves a script that fails after the page started alone', () => {
    // Arrange
    const g = startGuard();
    g.fire('DOMContentLoaded');
    // Act
    g.fire('error', script('module'));
    // Assert
    expect(g.reload).not.toHaveBeenCalled();
  });

  it('reloads once for a page whose scripts fail together', () => {
    // Arrange
    const g = startGuard();
    // Act
    g.fire('error', script('module'));
    g.fire('error', script('module'));
    // Assert
    expect(g.reload).toHaveBeenCalledTimes(1);
  });

  it('stops after three failed loads in a row (a server that is gone)', () => {
    // Arrange
    const store = storage();
    const reloads = [];
    // Act
    for (let load = 0; load < 4; load++) {
      const g = startGuard(store);
      g.fire('error', script('module'));
      reloads.push(g.reload.mock.calls.length);
    }
    // Assert
    expect(reloads).toEqual([1, 1, 1, 0]);
  });

  it('counts again from zero once the page loads with its scripts', () => {
    // Arrange
    const store = storage();
    for (let load = 0; load < 3; load++) startGuard(store).fire('error', script('module'));
    // Act
    startGuard(store).fire('DOMContentLoaded');
    const g = startGuard(store);
    g.fire('error', script('module'));
    // Assert
    expect(g.reload).toHaveBeenCalledTimes(1);
  });

  it('never reloads where it cannot count (site data blocked)', () => {
    // Arrange
    const g = startGuard(storage(true));
    // Act
    g.fire('error', script('module'));
    g.fire('DOMContentLoaded');
    // Assert
    expect(g.reload).not.toHaveBeenCalled();
  });
});

describe('startup guard in the viewer build', () => {
  it.each(['/join.html', '/watch.html'])('is written in the head of %s, as it is', (path) => {
    // Act
    const tags = startupGuard().transformIndexHtml('<html></html>', { path });
    // Assert
    expect(tags).toEqual([{ tag: 'script', children: STARTUP_GUARD, injectTo: 'head' }]);
  });

  it('is left out of the "link not valid" page', () => {
    // Act
    const tags = startupGuard().transformIndexHtml('<html></html>', { path: '/invalid.html' });
    // Assert
    expect(tags).toBeUndefined();
  });

  it('has only line feeds, so the page carries exactly the text the server hashes', () => {
    // Assert
    expect(STARTUP_GUARD).not.toMatch(/\r/);
  });
});
