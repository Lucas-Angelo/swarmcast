// @vitest-environment happy-dom
// The startup guard: the one inline script of join.html and watch.html. When one of the page's own
// scripts fails to load (a dropped connection), the browser never runs it and never asks for it
// again: the join page then looked ready with "Watch" disabled for good (soak run 41194466705,
// windows-app job 15: one script of the join page failed with net::ERR_NO_BUFFER_SPACE and the
// harness waited 30 s for Watch). The guard reloads the page instead, a few times in a row at
// most, so a server that is gone does not reload it forever.
//
// The guard runs here as the page has it, with the window's addEventListener, sessionStorage and
// location replaced by doubles (it uses them as globals, so they come in as same-named parameters).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const page = (name: string): string => readFileSync(path.join(import.meta.dirname, '..', '..', name), 'utf8');

/** The page's inline scripts (those without src), as written. */
function inlineScripts(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return Array.from(doc.querySelectorAll('script:not([src])'), (s) => s.textContent ?? '');
}

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

/** Runs the page's guard against doubles; `fire(type, target)` delivers a window event to it. */
function startGuard(html: string, store = storage()) {
  const [guard] = inlineScripts(html);
  if (guard === undefined) throw new Error('the page has no inline startup guard');
  const listeners: Array<{ type: string; fn: Listener }> = [];
  const addEventListener = (type: string, fn: Listener) => listeners.push({ type, fn });
  const location = { reload: vi.fn() };
  new Function('addEventListener', 'sessionStorage', 'location', guard)(addEventListener, store, location);
  const fire = (type: string, target: unknown = window): void => {
    for (const l of listeners.filter((x) => x.type === type)) l.fn({ target });
  };
  return { reload: location.reload, fire, store };
}

const script = (type: string): HTMLScriptElement => Object.assign(document.createElement('script'), { type, src: '/assets/page.js' });

describe.each(['join.html', 'watch.html'])('startup guard of %s', (name) => {
  const html = page(name);

  it('reloads the page when one of its scripts fails to load', () => {
    // Arrange
    const g = startGuard(html);
    // Act
    g.fire('error', script('module'));
    // Assert
    expect(g.reload).toHaveBeenCalledTimes(1);
  });

  it('leaves other failures alone: an image, a stylesheet, a classic script', () => {
    // Arrange
    const g = startGuard(html);
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
    const g = startGuard(html);
    g.fire('DOMContentLoaded');
    // Act
    g.fire('error', script('module'));
    // Assert
    expect(g.reload).not.toHaveBeenCalled();
  });

  it('reloads once for a page whose scripts fail together', () => {
    // Arrange
    const g = startGuard(html);
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
      const g = startGuard(html, store);
      g.fire('error', script('module'));
      reloads.push(g.reload.mock.calls.length);
    }
    // Assert
    expect(reloads).toEqual([1, 1, 1, 0]);
  });

  it('counts again from zero once the page loads with its scripts', () => {
    // Arrange
    const store = storage();
    for (let load = 0; load < 3; load++) startGuard(html, store).fire('error', script('module'));
    // Act
    startGuard(html, store).fire('DOMContentLoaded');
    const g = startGuard(html, store);
    g.fire('error', script('module'));
    // Assert
    expect(g.reload).toHaveBeenCalledTimes(1);
  });

  it('never reloads where it cannot count (site data blocked)', () => {
    // Arrange
    const g = startGuard(html, storage(true));
    // Act
    g.fire('error', script('module'));
    g.fire('DOMContentLoaded');
    // Assert
    expect(g.reload).not.toHaveBeenCalled();
  });
});

describe('startup guard', () => {
  it('is the same on the join and watch pages, and their only inline script', () => {
    // Act
    const join = inlineScripts(page('join.html'));
    const watch = inlineScripts(page('watch.html'));
    // Assert
    expect(join).toHaveLength(1);
    expect(watch).toEqual(join);
  });
});
