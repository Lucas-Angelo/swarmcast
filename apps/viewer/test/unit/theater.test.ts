// @vitest-environment happy-dom
// Theater mode (theater.ts): off at first, the button says whether it is on (aria-pressed), the
// body gets the class the styles widen the player with, and the choice is remembered in this
// browser (and still works for the page when storage is blocked).
import { beforeEach, describe, expect, it } from 'vitest';
import { createTheater, loadTheater, saveTheater, THEATER_PREF_KEY } from '../../src/theater.js';
import type { PrefStorage } from '../../src/shortcuts.js';

class MemoryStorage implements PrefStorage {
  readonly map = new Map<string, string>();
  constructor(private readonly blocked = false) {}
  getItem(k: string): string | null {
    if (this.blocked) throw new Error('SecurityError');
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    if (this.blocked) throw new Error('SecurityError');
    this.map.set(k, v);
  }
}

function page(storage: PrefStorage | undefined) {
  document.body.className = 'watch';
  document.body.innerHTML = '<button id="theater" type="button" hidden aria-pressed="false">Theater mode</button>';
  const button = document.getElementById('theater') as HTMLButtonElement;
  return { button, theater: createTheater({ body: document.body, button, storage }) };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('theater mode', () => {
  it('starts off on a first visit; the button shows, not pressed', () => {
    // Arrange / Act
    const { button, theater } = page(new MemoryStorage());
    // Assert
    expect(theater.on).toBe(false);
    expect(button.hidden).toBe(false);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(document.body.classList.contains('theater')).toBe(false);
  });

  it('a click turns it on and off, with the class and aria-pressed following', () => {
    // Arrange
    const { button, theater } = page(new MemoryStorage());
    // Act
    button.click();
    // Assert
    expect(theater.on).toBe(true);
    expect(document.body.classList.contains('theater')).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    // Act
    button.click();
    // Assert
    expect(theater.on).toBe(false);
    expect(document.body.classList.contains('theater')).toBe(false);
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('is remembered: the next visit opens in theater mode until it is turned off', () => {
    // Arrange
    const storage = new MemoryStorage();
    page(storage).theater.toggle();
    expect(storage.map.get(THEATER_PREF_KEY)).toBe('on');
    // Act: a reload
    const again = page(storage);
    // Assert
    expect(again.theater.on).toBe(true);
    expect(document.body.classList.contains('theater')).toBe(true);
    expect(again.button.getAttribute('aria-pressed')).toBe('true');
    // Act
    again.theater.set(false);
    // Assert
    expect(storage.map.get(THEATER_PREF_KEY)).toBe('off');
    expect(page(storage).theater.on).toBe(false);
  });

  it('with storage blocked it starts off and still toggles for this page', () => {
    // Arrange
    const storage = new MemoryStorage(true);
    const { theater } = page(storage);
    // Act
    theater.toggle();
    // Assert
    expect(theater.on).toBe(true);
    expect(document.body.classList.contains('theater')).toBe(true);
    expect(loadTheater(storage)).toBe(false);
    expect(() => saveTheater(storage, true)).not.toThrow();
    expect(loadTheater(undefined)).toBe(false);
  });

  it('keeps the classes the chat and the branding put on the body', () => {
    // Arrange
    const { theater } = page(new MemoryStorage());
    document.body.classList.add('has-chat', 'chat-hidden');
    // Act
    theater.toggle();
    theater.toggle();
    theater.toggle();
    // Assert
    expect([...document.body.classList].sort()).toEqual(['chat-hidden', 'has-chat', 'theater', 'watch']);
  });
});
