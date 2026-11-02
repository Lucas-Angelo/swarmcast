// @vitest-environment happy-dom
// The quality menu as a WAI-ARIA menu button (quality-menu.ts): no <select> anywhere (WebKit's
// own parts of a <select> break the viewer CSP), the button says the quality in use, opens a menu
// of menuitemradio entries with the one in use focused; arrow keys, Home / End move, Esc closes and
// gives the focus back, Tab and a click outside close it; picking an entry switches the level.
// What it lists (levels, Auto, Audio only) is in audio-only.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQualityMenu } from '../../src/quality-menu.js';

const EVENTS = { MANIFEST_PARSED: 'hlsManifestParsed', LEVEL_SWITCHED: 'hlsLevelSwitched' } as const;

function setup() {
  const hls = {
    levels: [{ height: 720 }, { height: 480 }, { height: 360 }],
    currentLevel: 0,
    loadLevel: -1,
    nextLevel: -1,
    autoLevelEnabled: true,
    on: vi.fn(),
    off: vi.fn(),
  };
  const container = document.createElement('div');
  const outside = document.createElement('button');
  document.body.append(container, outside);
  const onOpenChange = vi.fn();
  const menu = createQualityMenu(hls as never, container, EVENTS, { auto: 'Auto', autoWith: (l) => `Auto (${l})`, title: 'Video quality', audioOnly: 'Audio only', hint: 'What it means.' }, undefined, { onOpenChange });
  const items = (): HTMLElement[] => [...menu.menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  const key = (target: Element, k: string): KeyboardEvent => {
    const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    target.dispatchEvent(e);
    return e;
  };
  return { hls, menu, items, key, outside, onOpenChange, container };
}

afterEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('the quality menu button', () => {
  it('is no <select>: a button that says the quality in use, and a closed menu of radio entries', () => {
    // Act
    const { menu, items, container } = setup();
    // Assert
    expect(container.querySelector('select')).toBeNull();
    expect(menu.button.getAttribute('aria-haspopup')).toBe('menu');
    expect(menu.button.getAttribute('aria-expanded')).toBe('false');
    expect(menu.button.getAttribute('aria-controls')).toBe(menu.menu.id);
    expect(menu.button.getAttribute('aria-label')).toBe('Video quality: Auto (720p)');
    expect(menu.menu.getAttribute('role')).toBe('menu');
    expect(menu.menu.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(menu.menu.getAttribute('aria-describedby')!)?.textContent).toBe('What it means.');
    expect(items().map((i) => [i.textContent, i.getAttribute('aria-checked'), i.tabIndex])).toEqual([
      ['Auto (720p)', 'true', -1],
      ['720p', 'false', -1],
      ['480p', 'false', -1],
      ['360p', 'false', -1],
    ]);
    expect(menu.open).toBe(false);
  });

  it('a click opens it with the entry in use focused; picking 480p switches at the next segment and closes it', () => {
    // Arrange
    const { menu, items, hls, onOpenChange } = setup();
    // Act
    menu.button.click();
    // Assert
    expect(menu.open).toBe(true);
    expect(menu.button.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(items()[0]);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    // Act
    items()[2]!.click();
    // Assert
    expect(hls.nextLevel).toBe(1);
    expect(menu.open).toBe(false);
    expect(document.activeElement).toBe(menu.button);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(localStorage.getItem('sc.quality-height')).toBe('480');
  });

  it('keyboard: ArrowDown on the button opens on the first entry, ArrowUp on the last; arrows wrap, Home / End jump', () => {
    // Arrange
    const { menu, items, key } = setup();
    // Act / Assert
    expect(key(menu.button, 'ArrowUp').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(items()[3]);
    key(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).toBe(items()[0]);
    key(document.activeElement!, 'ArrowUp');
    expect(document.activeElement).toBe(items()[3]);
    key(document.activeElement!, 'Home');
    expect(document.activeElement).toBe(items()[0]);
    key(document.activeElement!, 'End');
    expect(document.activeElement).toBe(items()[3]);
    menu.close(false);
    key(menu.button, 'ArrowDown');
    expect(document.activeElement).toBe(items()[0]);
  });

  it('Esc closes it and gives the focus back to the button, without reaching anything around it', () => {
    // Arrange
    const { menu, items, key } = setup();
    const around = vi.fn();
    document.addEventListener('keydown', around);
    menu.button.click();
    // Act
    const e = key(items()[1]!, 'Escape');
    // Assert
    expect(e.defaultPrevented).toBe(true);
    expect(menu.open).toBe(false);
    expect(document.activeElement).toBe(menu.button);
    expect(around).not.toHaveBeenCalled();
    document.removeEventListener('keydown', around);
  });

  it('Tab and a press outside close it', () => {
    // Arrange
    const { menu, items, key, outside } = setup();
    menu.button.click();
    // Act
    key(items()[0]!, 'Tab');
    // Assert
    expect(menu.open).toBe(false);
    // Act
    menu.button.click();
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    // Assert
    expect(menu.open).toBe(false);
  });

  it('picking the entry already in use changes nothing', () => {
    // Arrange
    const { menu, items, hls } = setup();
    menu.button.click();
    // Act
    items()[0]!.click();
    // Assert
    expect(hls.loadLevel).toBe(-1);
    expect(hls.nextLevel).toBe(-1);
    expect(menu.open).toBe(false);
  });
});
