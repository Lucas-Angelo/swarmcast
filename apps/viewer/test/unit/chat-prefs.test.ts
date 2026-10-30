// The viewer's chat choices (chat/prefs.ts): kept in the page's storage for the next visit, read
// defensively (it is the viewer's own browser storage, anything can be in it), and kept for the
// page alone when storage is blocked.
import { describe, expect, it } from 'vitest';
import { createPrefsStore, RECENT_MAX } from '../../src/chat/prefs.js';

const KEY = 'swarmcast.chat';
const DEFAULTS = { hidden: false, times: false, large: false, tone: 0, recent: [], gifs: false, animate: null };

/** An in-memory stand-in for localStorage. */
function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v), items };
}

/** Storage the browser refuses (privacy settings): touching it throws, as Safari and Firefox do. */
const blocked = () => {
  throw new DOMException('The operation is insecure.', 'SecurityError');
};

describe('chat prefs store', () => {
  it('starts from the defaults on a first visit', () => {
    // Arrange
    const store = createPrefsStore(() => memoryStorage());

    // Act
    const prefs = store.load();

    // Assert
    expect(prefs).toEqual(DEFAULTS);
  });

  it('a choice saved on one page is there on the next one', () => {
    // Arrange
    const storage = memoryStorage();
    createPrefsStore(() => storage).save({ hidden: true, tone: 2, recent: ['😀'] });

    // Act
    const next = createPrefsStore(() => storage).load();

    // Assert
    expect(next).toEqual({ ...DEFAULTS, hidden: true, tone: 2, recent: ['😀'] });
  });

  it('keeps only valid values from what is stored', () => {
    // Arrange
    const stored = { hidden: 'yes', tone: 9, recent: ['😀', 7, 'x'.repeat(41), ...Array.from({ length: 30 }, (_, i) => `:e${i}:`)], gifs: true, animate: 'no' };
    const store = createPrefsStore(() => memoryStorage({ [KEY]: JSON.stringify(stored) }));

    // Act
    const prefs = store.load();

    // Assert
    expect(prefs).toMatchObject({ hidden: false, tone: 0, gifs: true, animate: null });
    expect(prefs.recent).toHaveLength(RECENT_MAX);
    expect(prefs.recent[0]).toBe('😀');
    expect(prefs.recent).not.toContain(7);
  });

  it('bad JSON in storage gives the defaults', () => {
    // Arrange
    const store = createPrefsStore(() => memoryStorage({ [KEY]: '{not json' }));

    // Act
    const prefs = store.load();

    // Assert
    expect(prefs).toEqual(DEFAULTS);
  });

  it('blocked storage: the defaults, and a choice lasts for this page only', () => {
    // Arrange
    const store = createPrefsStore(blocked);

    // Act
    const saved = store.save({ times: true });

    // Assert
    expect(saved).toEqual({ ...DEFAULTS, times: true });
    expect(store.load()).toEqual({ ...DEFAULTS, times: true });
  });
});
