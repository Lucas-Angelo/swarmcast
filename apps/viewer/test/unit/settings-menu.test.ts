// @vitest-environment happy-dom
// The watch page's Settings menu (settings-menu.ts): a disclosure under the gear of the info row
// that opens and closes with its button, closes with Esc (the focus back on the button when it was
// in the menu), a press outside, its × and the buttons that open something it would cover, and
// stays open for a dialog opened from it.
import { beforeEach, describe, expect, it } from 'vitest';
import { createSettingsMenu, type SettingsMenu } from '../../src/settings-menu.js';

const MARKUP = `
  <button id="outside" type="button">Share</button>
  <button id="settings-open" type="button" aria-controls="settings-menu">Settings</button>
  <div id="settings-menu" hidden>
    <button id="settings-close" type="button">×</button>
    <input id="p2p" type="checkbox" />
    <button id="keys-open" type="button">Keyboard shortcuts</button>
    <button id="stats-open" type="button">Stats for nerds</button>
  </div>
  <dialog id="keys-help"><button id="keys-close" type="button">×</button></dialog>
`;
const $ = (id: string): HTMLElement => document.getElementById(id)!;

function press(target: Element, key = 'Escape'): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}
function pointerDown(target: Element): void {
  target.dispatchEvent(new Event('pointerdown', { bubbles: true }));
}

describe('the Settings menu', () => {
  let menu: SettingsMenu;
  beforeEach(() => {
    document.body.innerHTML = MARKUP;
    menu = createSettingsMenu({
      doc: document,
      button: $('settings-open') as HTMLButtonElement,
      menu: $('settings-menu'),
      closeButton: $('settings-close'),
      closers: [$('stats-open')],
    });
  });

  it('starts closed; its button opens and closes it and says so', () => {
    // Assert
    expect($('settings-menu').hidden).toBe(true);
    expect($('settings-open').getAttribute('aria-expanded')).toBe('false');
    // Act
    $('settings-open').click();
    // Assert
    expect(menu.isOpen).toBe(true);
    expect($('settings-menu').hidden).toBe(false);
    expect($('settings-open').getAttribute('aria-expanded')).toBe('true');
    // Act
    $('settings-open').click();
    // Assert
    expect(menu.isOpen).toBe(false);
    expect($('settings-menu').hidden).toBe(true);
    expect($('settings-open').getAttribute('aria-expanded')).toBe('false');
  });

  it('Esc with the focus in the menu closes it and gives the focus back to the button', () => {
    // Arrange
    menu.open();
    $('p2p').focus();
    // Act
    const e = press($('p2p'));
    // Assert
    expect(menu.isOpen).toBe(false);
    expect(document.activeElement).toBe($('settings-open'));
    expect(e.defaultPrevented).toBe(true);
  });

  it('Esc with the focus elsewhere closes it and leaves the focus where it is', () => {
    // Arrange
    menu.open();
    $('outside').focus();
    // Act
    const e = press($('outside'));
    // Assert
    expect(menu.isOpen).toBe(false);
    expect(document.activeElement).toBe($('outside'));
    expect(e.defaultPrevented).toBe(false);
  });

  it('an Esc someone else took, or one in a dialog opened from it, leaves it open', () => {
    // Arrange
    menu.open();
    const taken = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    taken.preventDefault();
    $('keys-help').setAttribute('open', '');
    // Act
    $('p2p').dispatchEvent(taken);
    press($('keys-close'));
    // Assert
    expect(menu.isOpen).toBe(true);
  });

  it('other keys do nothing', () => {
    // Arrange
    menu.open();
    // Act
    press($('p2p'), 'Enter');
    press($('p2p'), 'Tab');
    // Assert
    expect(menu.isOpen).toBe(true);
  });

  it('a press outside closes it; a press in it, on its button or in an open dialog does not', () => {
    // Arrange
    menu.open();
    $('keys-help').setAttribute('open', '');
    // Act
    pointerDown($('p2p'));
    pointerDown($('keys-close'));
    // Assert
    expect(menu.isOpen).toBe(true);
    // Act
    pointerDown($('outside'));
    // Assert
    expect(menu.isOpen).toBe(false);
  });

  it('its × closes it and gives the focus back to the button', () => {
    // Arrange
    menu.open();
    // Act
    $('settings-close').click();
    // Assert
    expect(menu.isOpen).toBe(false);
    expect(document.activeElement).toBe($('settings-open'));
  });

  it('"Stats for nerds" closes it (the panel opens over the video, where the menu is)', () => {
    // Arrange
    menu.open();
    // Act
    $('stats-open').click();
    // Assert
    expect(menu.isOpen).toBe(false);
  });

  it('closed, it listens to nothing: Esc and presses outside change nothing', () => {
    // Arrange
    menu.open();
    menu.close();
    $('outside').focus();
    // Act
    const e = press($('outside'));
    pointerDown($('outside'));
    // Assert
    expect(menu.isOpen).toBe(false);
    expect(e.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe($('outside'));
  });
});
