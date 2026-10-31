// @vitest-environment happy-dom
// The chat list's render rules (chat/render.ts): text through text nodes only, emotes as images,
// unsafe text hidden, readable name colours, and the frame and DOM budgets. Frames are injected
// (`raf`): `flush` runs the ones the list asked for, so rendering happens exactly when a test says.
import { describe, expect, it } from 'vitest';
import { contrastRatio, adjustNameColor, CHAT_BG_DARK, CHAT_BG_LIGHT, type ChatAuthor } from '@swarmcast/shared/chat';
import { ChatList, DOM_MAX, RENDER_PER_FRAME } from '../../src/chat/render.js';
import type { ChatEntry } from '../../src/chat/session.js';
import type { Emote } from '../../src/chat/emotes.js';

const ana: ChatAuthor = { a: 'k1', n: 'Ana', c: '#ffee88', r: 'viewer' };
const lucas: ChatAuthor = { a: 'k0', n: 'Lucas', c: '#000000', r: 'streamer' };
const m = (s: number, text: string, author: ChatAuthor = ana): ChatEntry => ({ kind: 'msg', s, at: 1_700_000_000_000 + s, author, text });
/** `count` messages from seq `from` on. */
const many = (count: number, from = 1, text = (s: number) => `m${s}`): ChatEntry[] => Array.from({ length: count }, (_, i) => m(from + i, text(from + i)));
const HOSTILE = '<img src=x onerror=alert(1)><script>x</script> javascript:alert(1) https://evil.example/a.png';

/** A list in an empty page, painting names for `bg`; `visible` says whether the page is shown. */
function setup(o: { visible?: boolean; bg?: string } = {}) {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  const frames: Array<() => void> = [];
  let visible = o.visible ?? true;
  const emotes = new Map<string, Emote>([['hi', { code: 'hi', url: '/assets/hi.webp', url2x: '/assets/hi@2x.webp', w: 56, h: 56 }]]);
  const list = new ChatList(root, {
    emotes: () => emotes,
    nickColor: (c) => adjustNameColor(c, o.bg ?? CHAT_BG_LIGHT),
    showTimes: () => false,
    visible: () => visible,
    raf: (cb) => frames.push(cb),
  });
  const flush = (): void => {
    while (frames.length) frames.shift()!();
  };
  /** append + the frames it asked for. */
  const show = (entries: ChatEntry[]): void => {
    list.append(entries);
    flush();
  };
  return { list, root, flush, show, setVisible: (v: boolean) => (visible = v) };
}

const rows = (list: ChatList): HTMLLIElement[] => [...list.list.querySelectorAll<HTMLLIElement>('li')];

describe('ChatList render rules', () => {
  it('builds text with text nodes only: markup stays text, never elements', () => {
    // Arrange
    const { list, show } = setup();

    // Act
    show([m(1, HOSTILE)]);

    // Assert
    const li = list.list.querySelector('li.msg')!;
    expect(li.querySelector('.text')!.textContent).toBe(HOSTILE);
    expect(li.querySelectorAll('img, script, a').length).toBe(0);
    expect(li.querySelector('bdi.nick')!.textContent).toBe('Ana');
    expect(li.querySelector('bdi.text')!.getAttribute('dir')).toBe('auto');
    expect(li.getAttribute('data-seq')).toBe('1');
  });

  it('known :codes: become emote images, unknown ones stay text', () => {
    // Arrange
    const { list, show } = setup();

    // Act
    show([m(1, 'oi :hi: :nope: :HI:')]);

    // Assert
    const text = list.list.querySelector('li.msg .text')!;
    const imgs = text.querySelectorAll('img.emote');
    expect(imgs.length).toBe(1);
    expect(imgs[0]!.getAttribute('alt')).toBe(':hi:');
    expect(imgs[0]!.getAttribute('src')).toBe('/assets/hi.webp');
    expect(text.textContent).toBe('oi  :nope: :HI:');
  });

  it('hides a text or nickname that breaks the safety invariants (a server bug never reaches the DOM)', () => {
    // Arrange
    const { list, show } = setup();

    // Act
    show([m(1, 'abc‮fdp.exe'), m(2, 'e' + '́̂̃̄̅'), m(3, 'ok', { ...ana, n: 'Mark‮kram' }), m(4, 'a\nb'), m(5, 'fine 😀')]);

    // Assert
    const r = rows(list);
    expect(r.filter((li) => li.classList.contains('hidden-msg')).length).toBe(4);
    expect(r[0]!.textContent).toBe('Message hidden');
    expect(r[0]!.textContent).not.toContain('fdp');
    expect(r[4]!.querySelector('.text')!.textContent).toBe('fine 😀');
    expect(list.stats.hidden).toBe(4);
  });

  it('an empty streamer name shows the translated default', () => {
    // Arrange
    const { list, show } = setup();

    // Act
    show([m(1, 'oi', { ...lucas, n: '' })]);

    // Assert
    expect(list.list.querySelector('li.from-streamer .nick')!.textContent).toBe('Streamer');
    expect(list.list.querySelectorAll('li.hidden-msg')).toHaveLength(0);
  });

  it('the streamer gets a badge from the role and a theme colour, never a user colour', () => {
    // Arrange
    const { list, show } = setup();

    // Act
    show([m(1, 'oi', lucas)]);

    // Assert
    const li = list.list.querySelector('li.msg')!;
    expect(li.classList.contains('from-streamer')).toBe(true);
    expect(li.querySelector('.badge')!.textContent).toBe('Streamer');
    expect((li.querySelector('.nick') as HTMLElement).style.getPropertyValue('--nick')).toBe('');
  });

  it.each([CHAT_BG_LIGHT, CHAT_BG_DARK])('names are painted with ≥ 4.5:1 on %s through the CSSOM', (bg) => {
    // Arrange
    const { list, show } = setup({ bg });
    const authors = ['#ffee88', '#101010', '#0090ff', 'not-a-colour'].map((c, i): ChatAuthor => ({ a: `k${i}`, n: `N${i}`, c, r: 'viewer' }));

    // Act
    show(authors.map((a, i) => m(i + 1, 'x', a)));

    // Assert
    for (const nick of list.list.querySelectorAll<HTMLElement>('.nick')) {
      const c = nick.style.getPropertyValue('--nick');
      expect(c).toMatch(/^#[0-9a-f]{6}$/);
      expect(contrastRatio(c, bg)).toBeGreaterThanOrEqual(4.5);
      expect(nick.getAttribute('style') ?? '').not.toContain('color:');
    }
  });

  it(`renders at most ${RENDER_PER_FRAME} per frame: older ones become one "skipped" line`, () => {
    // Arrange
    const { list, show } = setup();

    // Act
    show(many(120));

    // Assert
    const r = rows(list);
    expect(r.length).toBe(RENDER_PER_FRAME);
    expect(r[0]!.classList.contains('skipped')).toBe(true);
    expect(r[0]!.textContent).toBe('71 messages skipped');
    expect(r.at(-1)!.dataset.seq).toBe('120');
  });

  it(`keeps at most ${DOM_MAX} rows`, () => {
    // Arrange
    const { list, show } = setup();

    // Act
    for (let b = 0; b < 8; b++) show(many(40, b * 40 + 1, () => 'x'));

    // Assert
    expect(rows(list).length).toBe(DOM_MAX);
    expect(rows(list).at(-1)!.dataset.seq).toBe('320');
  });

  it('renders nothing while hidden', () => {
    // Arrange
    const { list, show } = setup({ visible: false });

    // Act
    show(many(30));

    // Assert
    expect(list.list.querySelectorAll('li.msg').length).toBe(0);
  });

  it('on return shows what waited', () => {
    // Arrange
    const { list, show, flush, setVisible } = setup({ visible: false });
    show(many(30));

    // Act
    setVisible(true);
    list.resume();
    flush();

    // Assert
    expect(list.list.querySelectorAll('li.msg').length).toBe(30);
  });

  it('own message: "sending…" at once', () => {
    // Arrange
    const { list } = setup();

    // Act
    list.addPending(11, 'oi', ana);

    // Assert
    expect(list.list.querySelector('li.pending .state')!.textContent).toBe('sending…');
  });

  it('own message: the server copy replaces the "sending…" row', () => {
    // Arrange
    const { list, show } = setup();
    list.addPending(11, 'oi', ana);

    // Act
    list.ack(11, 5);
    show([m(5, 'oi')]);

    // Assert
    expect(list.list.querySelectorAll('li.pending').length).toBe(0);
    expect(list.list.querySelectorAll('li.msg').length).toBe(1);
  });

  it('own message: a reject marks it "not sent" and keeps its text', () => {
    // Arrange
    const { list } = setup();
    list.addPending(12, 'feio', ana);

    // Act
    list.reject(12);

    // Assert
    expect(list.list.querySelector('li.failed .state')!.textContent).toBe('not sent');
    expect(list.list.querySelector('li.failed .text')!.textContent).toBe('feio');
  });

  it('removes deleted messages', () => {
    // Arrange
    const { list, show } = setup();
    show([m(1, 'a'), m(2, 'b'), m(3, 'c')]);

    // Act
    list.remove([2]);

    // Assert
    expect(rows(list).map((r) => r.dataset.seq)).toEqual(['1', '3']);
  });

  it('clears up to a seq', () => {
    // Arrange
    const { list, show } = setup();
    show([m(1, 'a'), m(2, 'b'), m(3, 'c')]);

    // Act
    list.clearUpTo(3);

    // Assert
    expect(list.list.querySelectorAll('li.msg').length).toBe(0);
  });

  it('a roster change re-colours that author only', () => {
    // Arrange
    const { list, show } = setup();
    show([m(1, 'a'), m(2, 'b', { a: 'k9', n: 'Rafa', c: '#46a758', r: 'viewer' })]);

    // Act
    list.recolor({ ...ana, c: '#0090ff' });

    // Assert
    const nicks = [...list.list.querySelectorAll<HTMLElement>('.nick')];
    expect(nicks[0]!.dataset.c).toBe('#0090ff');
    expect(nicks[1]!.dataset.c).toBe('#46a758');
  });

  it('the list is a log region with a separate polite status for summaries', () => {
    // Act
    const { list } = setup();

    // Assert
    expect(list.list.getAttribute('role')).toBe('log');
    expect(list.list.getAttribute('aria-live')).toBe('off');
    expect(list.live.getAttribute('aria-live')).toBe('polite');
  });
});
