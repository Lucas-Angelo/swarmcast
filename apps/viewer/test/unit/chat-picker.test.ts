// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { emojiData, PINNED_UNICODE } from '../../scripts/emoji-data.mjs';
import { createPicker, type EmojiData } from '../../src/chat/picker.js';
import { loadPrefs, resetPrefsCache } from '../../src/chat/prefs.js';
import type { Emote } from '../../src/chat/emotes.js';

describe('emoji data (build time, scripts/emoji-data.mjs)', () => {
  const en = emojiData('en');
  const pt = emojiData('pt-BR');
  const all = (d: typeof en) => d.groups.flatMap(([, rows]) => rows);

  it('is pinned to the Unicode version of the chat tables and refuses another', () => {
    expect(en.unicode).toBe(PINNED_UNICODE);
    expect(() => emojiData('en', { unicode: '16.0' })).toThrow(/pins 17\.0/);
  });

  it('keeps only RGI emoji, without the component group and lone regional indicators', () => {
    const rgi = new RegExp('^\\p{RGI_Emoji}$', 'v');
    const rows = all(en);
    expect(rows.length).toBeGreaterThan(1800);
    for (const [ch, , , tones] of rows) {
      expect(rgi.test(ch), ch).toBe(true);
      for (const t of tones ?? []) expect(rgi.test(t), t).toBe(true);
    }
    expect(en.groups.map(([g]) => g)).not.toContain(2);
    expect(rows.some(([ch]) => ch === '🇦')).toBe(false);
    expect(rows.some(([ch]) => ch === '🏻')).toBe(false);
    expect(rows.some(([ch]) => ch === '🇧🇷')).toBe(true);
  });

  it('has five one-tone variants where the emoji takes skin tones', () => {
    const wave = all(en).find(([ch]) => ch === '👋')!;
    expect(wave[3]).toEqual(['👋🏻', '👋🏼', '👋🏽', '👋🏾', '👋🏿']);
    expect(all(en).find(([ch]) => ch === '😀')![3]).toBeUndefined();
  });

  it('labels and keywords in the viewer language', () => {
    const wavePt = all(pt).find(([ch]) => ch === '👋')!;
    expect(wavePt[1]).toBe('mão acenando');
    expect(wavePt[2]).toContain('tchau');
    expect(all(en).find(([ch]) => ch === '👋')![2]).toContain('hello');
  });

  it('stays small enough for a lazy chunk (< 260 KB of JSON per language)', () => {
    expect(JSON.stringify(en).length).toBeLessThan(260_000);
    expect(JSON.stringify(pt).length).toBeLessThan(260_000);
  });
});

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

function setup(o: { emojiAllowed?: boolean; load?: () => Promise<EmojiData> } = {}) {
  document.body.replaceChildren();
  const button = document.createElement('button');
  const picked: string[] = [];
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
  });
  document.body.append(button, picker.panel);
  const search = picker.panel.querySelector<HTMLInputElement>('input[type=search]')!;
  const pickButtons = (): HTMLButtonElement[] => [...picker.panel.querySelectorAll<HTMLButtonElement>('button.pick')];
  return { button, picker, picked, search, pickButtons, loads: () => loads };
}

describe('picker', () => {
  beforeEach(() => {
    localStorage.clear();
    resetPrefsCache();
  });

  it('shows emotes at once and loads the emoji only when first opened', async () => {
    const { button, picker, pickButtons, loads } = setup();
    expect(loads()).toBe(0);
    button.click();
    expect(picker.popover.isOpen).toBe(true);
    expect(picker.panel.querySelector('[data-group="emotes"]')!.querySelectorAll('button.pick')).toHaveLength(2);
    await picker.ready();
    await Promise.resolve();
    expect(loads()).toBe(1);
    expect(pickButtons().map((b) => b.textContent)).toEqual(['', '', '😀', '❤️', '👋']);
    button.click();
    button.click();
    await picker.ready();
    expect(loads()).toBe(1);
  });

  it('search matches keywords and emote codes; picks insert and become recent', async () => {
    const { button, picker, picked, search, pickButtons } = setup();
    button.click();
    await picker.ready();
    search.value = 'heart';
    search.dispatchEvent(new Event('input'));
    expect(pickButtons().map((b) => b.getAttribute('aria-label'))).toEqual(['red heart']);
    pickButtons()[0]!.click();
    search.value = ':gg';
    search.dispatchEvent(new Event('input'));
    pickButtons()[0]!.click();
    expect(picked).toEqual(['❤️', ':gg: ']);
    expect(loadPrefs().recent).toEqual([':gg:', '❤️']);
    search.value = 'zzzz';
    search.dispatchEvent(new Event('input'));
    expect(picker.panel.textContent).toContain('Nothing found.');
  });

  it('skin tone applies to emoji that have tones and is remembered', async () => {
    const { button, picker, pickButtons } = setup();
    button.click();
    await picker.ready();
    await Promise.resolve();
    const tones = [...picker.panel.querySelectorAll<HTMLButtonElement>('button.tone')];
    expect(tones).toHaveLength(6);
    tones[3]!.click();
    expect(loadPrefs().tone).toBe(3);
    expect(pickButtons().map((b) => b.textContent)).toContain('👋🏽');
    expect(pickButtons().map((b) => b.textContent)).toContain('😀');
  });

  it('emoji not allowed (emotes off): no emoji, no load, no tones', async () => {
    const { button, picker, pickButtons, loads } = setup({ emojiAllowed: false });
    button.click();
    await picker.ready();
    expect(loads()).toBe(0);
    expect(pickButtons()).toHaveLength(2);
    expect(picker.panel.querySelector<HTMLElement>('.tones')!.hidden).toBe(true);
  });

  it('a failed load says so and can be retried', async () => {
    let fail = true;
    const { button, picker } = setup({ load: () => (fail ? Promise.reject(new Error('offline')) : Promise.resolve(fakeData)) });
    button.click();
    await picker.ready().catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    const retry = picker.panel.querySelector<HTMLElement>('.picker-note.retry')!;
    expect(retry.textContent).toBe('The emoji could not be loaded. Try again.');
    fail = false;
    retry.click();
    await picker.ready();
    await new Promise((r) => setTimeout(r, 0));
    expect(picker.panel.querySelector('[data-group="0"]')).not.toBeNull();
  });

  it('Escape closes it and gives focus back to its button', () => {
    const { button, picker } = setup();
    button.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(picker.popover.isOpen).toBe(false);
    expect(picker.panel.hidden).toBe(true);
    expect(document.activeElement).toBe(button);
  });
});
