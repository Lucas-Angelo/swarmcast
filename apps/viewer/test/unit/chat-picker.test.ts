// @vitest-environment happy-dom
// The emoji and emote picker (chat/picker.ts) and the emoji data it lazy-loads (built by
// scripts/emoji-data.mjs). Each picker keeps its tone and recent picks in a prefs store of its own
// (memory only), so no test sees another's choices.
import { describe, expect, it } from 'vitest';
import { emojiData, PINNED_UNICODE } from '../../scripts/emoji-data.mjs';
import { createPicker, type EmojiData } from '../../src/chat/picker.js';
import { createPrefsStore } from '../../src/chat/prefs.js';
import type { Emote } from '../../src/chat/emotes.js';

/** The built emoji data per language: computed once, only read. */
const en = emojiData('en');
const pt = emojiData('pt-BR');
const rowsOf = (d: typeof en) => d.groups.flatMap(([, rows]) => rows);
const rowOf = (d: typeof en, ch: string) => rowsOf(d).find(([c]) => c === ch)!;
/** A lazy chunk stays small: the most JSON per language it may hold. */
const MAX_CHUNK_CHARS = 260_000;

const fakeData: EmojiData = {
  v: 1,
  unicode: '17.0',
  groups: [
    [0, [['😀', 'grinning face', 'grinning face smile happy'], ['❤️', 'red heart', 'red heart love']]],
    [1, [['👋', 'waving hand', 'waving hand hello bye', ['👋🏻', '👋🏼', '👋🏽', '👋🏾', '👋🏿']]]],
  ],
};
const emotes: Emote[] = [
  { code: 'gg', url: '/assets/gg.webp', url2x: '/assets/gg@2x.webp', w: 56, h: 56 },
  { code: 'hi', url: '/assets/hi.webp', url2x: '/assets/hi@2x.webp', w: 56, h: 56 },
];

/**
 * A picker on its button, with a fresh prefs store. `load` defaults to the fake data and counts
 * its calls (`loads()`); `picked` is what the picker inserted; `type` searches.
 */
function setup(o: { emojiAllowed?: boolean; load?: () => Promise<EmojiData> } = {}) {
  document.body.replaceChildren();
  const button = document.createElement('button');
  const picked: string[] = [];
  const prefs = createPrefsStore(() => null);
  let loads = 0;
  const picker = createPicker(button, {
    emotes: () => emotes,
    emojiAllowed: () => o.emojiAllowed ?? true,
    load:
      o.load ??
      (() => {
        loads++;
        return Promise.resolve(fakeData);
      }),
    onPick: (t) => picked.push(t),
    prefs,
  });
  document.body.append(button, picker.panel);
  const search = picker.panel.querySelector<HTMLInputElement>('input[type=search]')!;
  const type = (q: string): void => {
    search.value = q;
    search.dispatchEvent(new Event('input'));
  };
  const pickButtons = (): HTMLButtonElement[] => [...picker.panel.querySelectorAll<HTMLButtonElement>('button.pick')];
  return { button, picker, picked, prefs, type, pickButtons, loads: () => loads };
}

/** setup(), opened, with its emoji data in. */
async function opened(o: Parameters<typeof setup>[0] = {}) {
  const s = setup(o);
  s.button.click();
  await s.picker.ready();
  return s;
}

describe('emoji data (build time, scripts/emoji-data.mjs)', () => {
  it('is pinned to the Unicode version of the chat tables', () => {
    // Act
    const version = en.unicode;

    // Assert
    expect(version).toBe(PINNED_UNICODE);
  });

  it('refuses another Unicode version', () => {
    // Act
    const build = () => emojiData('en', { unicode: '16.0' });

    // Assert
    expect(build).toThrow(/pins 17\.0/);
  });

  it('keeps only RGI emoji (and RGI tone variants)', () => {
    // Arrange
    const rgi = new RegExp('^\\p{RGI_Emoji}$', 'v');

    // Act
    const rows = rowsOf(en);

    // Assert
    expect(rows.length).toBeGreaterThan(1800);
    for (const [ch, , , tones] of rows) {
      expect(rgi.test(ch), ch).toBe(true);
      for (const t of tones ?? []) expect(rgi.test(t), t).toBe(true);
    }
  });

  it('leaves out the component group, lone regional indicators and lone tone modifiers, keeps flags', () => {
    // Act
    const chars = rowsOf(en).map(([ch]) => ch);

    // Assert
    expect(en.groups.map(([g]) => g)).not.toContain(2);
    expect(chars).not.toContain('🇦');
    expect(chars).not.toContain('🏻');
    expect(chars).toContain('🇧🇷');
  });

  it('has five one-tone variants where the emoji takes skin tones, none where it does not', () => {
    // Act
    const wave = rowOf(en, '👋');
    const grin = rowOf(en, '😀');

    // Assert
    expect(wave[3]).toEqual(['👋🏻', '👋🏼', '👋🏽', '👋🏾', '👋🏿']);
    expect(grin[3]).toBeUndefined();
  });

  it('labels and keywords in the viewer language', () => {
    // Act
    const wavePt = rowOf(pt, '👋');
    const waveEn = rowOf(en, '👋');

    // Assert
    expect(wavePt[1]).toBe('mão acenando');
    expect(wavePt[2]).toContain('tchau');
    expect(waveEn[2]).toContain('hello');
  });

  it.each([
    ['en', en],
    ['pt-BR', pt],
  ])(`%s stays small enough for a lazy chunk (< ${MAX_CHUNK_CHARS} characters of JSON)`, (_lang, data) => {
    // Act
    const size = JSON.stringify(data).length;

    // Assert
    expect(size).toBeLessThan(MAX_CHUNK_CHARS);
  });
});

describe('picker', () => {
  it('loads nothing before it is opened', () => {
    // Act
    const { loads } = setup();

    // Assert
    expect(loads()).toBe(0);
  });

  it('shows the emotes at once, while the emoji data loads', () => {
    // Arrange
    const { button, picker } = setup();

    // Act
    button.click();

    // Assert
    expect(picker.popover.isOpen).toBe(true);
    expect(picker.panel.querySelector('[data-group="emotes"]')!.querySelectorAll('button.pick')).toHaveLength(2);
    expect(picker.panel.querySelector('[data-group="0"]')).toBeNull();
  });

  it('loads the emoji data the first time it opens and shows the emotes, then the emoji', async () => {
    // Act
    const { loads, pickButtons } = await opened();

    // Assert
    expect(loads()).toBe(1);
    expect(pickButtons().map((b) => b.textContent)).toEqual(['', '', '😀', '❤️', '👋']);
  });

  it('opening it again does not load the data again', async () => {
    // Arrange
    const { button, loads } = await opened();
    button.click();

    // Act
    button.click();

    // Assert
    expect(loads()).toBe(1);
  });

  it('search matches emoji keywords', async () => {
    // Arrange
    const { type, pickButtons } = await opened();

    // Act
    type('heart');

    // Assert
    expect(pickButtons().map((b) => b.getAttribute('aria-label'))).toEqual(['red heart']);
  });

  it('search matches emote codes, colons included', async () => {
    // Arrange
    const { type, pickButtons } = await opened();

    // Act
    type(':gg');

    // Assert
    expect(pickButtons().map((b) => b.getAttribute('aria-label'))).toEqual([':gg:']);
  });

  it('a search without results says so', async () => {
    // Arrange
    const { type, picker } = await opened();

    // Act
    type('zzzz');

    // Assert
    expect(picker.panel.textContent).toContain('Nothing found.');
  });

  it('a pick inserts its text and becomes the most recent pick', async () => {
    // Arrange
    const { type, pickButtons, picked, prefs } = await opened();

    // Act
    type('heart');
    pickButtons()[0]!.click();
    type(':gg');
    pickButtons()[0]!.click();

    // Assert
    expect(picked).toEqual(['❤️', ':gg: ']);
    expect(prefs.load().recent).toEqual([':gg:', '❤️']);
  });

  it('a skin tone applies to the emoji that have tones and is remembered', async () => {
    // Arrange
    const { picker, pickButtons, prefs } = await opened();
    const tones = [...picker.panel.querySelectorAll<HTMLButtonElement>('button.tone')];

    // Act
    tones[3]!.click();

    // Assert
    expect(tones).toHaveLength(6);
    expect(prefs.load().tone).toBe(3);
    expect(pickButtons().map((b) => b.textContent)).toContain('👋🏽');
    expect(pickButtons().map((b) => b.textContent)).toContain('😀');
  });

  it('emoji not allowed (emotes off): no emoji, no load, no tones', async () => {
    // Act
    const { picker, pickButtons, loads } = await opened({ emojiAllowed: false });

    // Assert
    expect(loads()).toBe(0);
    expect(pickButtons()).toHaveLength(2);
    expect(picker.panel.querySelector<HTMLElement>('.tones')!.hidden).toBe(true);
  });

  it('a failed load says so', async () => {
    // Act
    const { picker } = await opened({ load: () => Promise.reject(new Error('offline')) });

    // Assert
    expect(picker.panel.querySelector('.picker-note.retry')!.textContent).toBe('The emoji could not be loaded. Try again.');
  });

  it('after a failed load, the note loads the data again', async () => {
    // Arrange
    let fail = true;
    const { picker } = await opened({ load: () => (fail ? Promise.reject(new Error('offline')) : Promise.resolve(fakeData)) });
    fail = false;

    // Act
    picker.panel.querySelector<HTMLElement>('.picker-note.retry')!.click();
    await picker.ready();

    // Assert
    expect(picker.panel.querySelector('[data-group="0"]')).not.toBeNull();
  });

  it('Escape closes it and gives focus back to its button', () => {
    // Arrange
    const { button, picker } = setup();
    button.click();

    // Act
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    // Assert
    expect(picker.popover.isOpen).toBe(false);
    expect(picker.panel.hidden).toBe(true);
    expect(document.activeElement).toBe(button);
  });
});
