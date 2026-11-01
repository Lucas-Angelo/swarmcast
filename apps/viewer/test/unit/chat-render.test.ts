// @vitest-environment happy-dom
// The chat list's render rules (chat/render.ts): text through text nodes only, emotes as images,
// unsafe text hidden, readable name colours, and the frame and DOM budgets. Frames are injected
// (`raf`): `flush` runs the ones the list asked for, so rendering happens exactly when a test says.
import fc from 'fast-check';
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

/** A list in an empty page, painting names for `bg` (`hlBg` on highlighted rows); `visible` says whether the page is shown. */
function setup(o: { visible?: boolean; bg?: string; hlBg?: string } = {}) {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  const frames: Array<() => void> = [];
  let visible = o.visible ?? true;
  const emotes = new Map<string, Emote>([['hi', { code: 'hi', url: '/assets/hi.webp', url2x: '/assets/hi@2x.webp', w: 56, h: 56 }]]);
  const list = new ChatList(root, {
    emotes: () => emotes,
    nickColor: (c, highlighted) => adjustNameColor(c, (highlighted ? o.hlBg : undefined) ?? o.bg ?? CHAT_BG_LIGHT),
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

  it('a system line whose code this page does not know (a newer server) shows a neutral line, and the rest of the batch still shows', () => {
    // Arrange
    const { list, show } = setup();
    const future = { kind: 'sys', s: 2, at: 1, code: 'chat.sys.pollStarted', params: { question: 'x' } } as unknown as ChatEntry;

    // Act
    show([m(1, 'before'), future, { kind: 'sys', s: 3, at: 1, code: 'chat.sys.protect' }, m(4, 'after')]);

    // Assert
    const r = rows(list);
    expect(r.map((li) => li.dataset.seq)).toEqual(['1', '2', '3', '4']);
    expect(r[1]!.textContent).toBe('Something changed in the chat that this page cannot show. Reload the page to see it.');
    expect(r[2]!.textContent).toBe('The chat is protected right now.');
    expect(r[3]!.querySelector('.text')!.textContent).toBe('after');
  });

  it('an entry that cannot be built is shown as "Message hidden"; the others in its batch are drawn', () => {
    // Arrange
    const { list, show } = setup();
    const broken = { kind: 'msg', s: 2, at: 1, author: null, text: 'x' } as unknown as ChatEntry;

    // Act
    show([m(1, 'before'), broken, m(3, 'after')]);

    // Assert
    const r = rows(list);
    expect(r.map((li) => li.dataset.seq)).toEqual(['1', '2', '3']);
    expect(r[1]!.textContent).toBe('Message hidden');
    expect(r[2]!.querySelector('.text')!.textContent).toBe('after');
    expect(list.stats.failed).toBe(1);
  });

  it('fuzz: whatever the entries, one flush draws one row per entry and never throws', () => {
    // Arrange
    const { list, show } = setup();
    const entry = fc.oneof(
      fc.record({ kind: fc.constant('msg'), s: fc.integer({ min: 1 }), at: fc.integer(), author: fc.oneof(fc.constant(ana), fc.constant(lucas), fc.jsonValue()), text: fc.oneof(fc.string(), fc.jsonValue()) }),
      fc.record({ kind: fc.constant('sys'), s: fc.integer({ min: 1 }), at: fc.integer(), code: fc.oneof(fc.string(), fc.constantFrom('chat.sys.muted', 'toString', 'chat.viewer.skipped')), params: fc.jsonValue() }),
      fc.record({ kind: fc.constant('msg'), s: fc.integer({ min: 1 }), at: fc.integer(), author: fc.constant(ana), gif: fc.jsonValue() }),
    ) as fc.Arbitrary<unknown> as fc.Arbitrary<ChatEntry>;
    const property = fc.property(fc.uniqueArray(entry, { maxLength: 20, selector: (e) => (e as { s: number }).s }), (entries) => {
      list.reset([]);
      show(entries);
      return rows(list).filter((li) => !li.classList.contains('empty')).length === entries.length;
    });
    // Act
    const run = () => fc.assert(property, { numRuns: 300, seed: 11 });

    // Assert
    expect(run).not.toThrow();
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

describe('ChatList: highlighted messages and the pinned bar', () => {
  /** --sc-accent-soft of Forest & Cream, light theme (assets/brand/tokens.css): the highlighted row's background. */
  const HL_BG = '#e2eae4';
  const pinOf = (s: number, text: string | undefined, author: ChatAuthor = ana, at = 5000) => ({ s, at, author, ...(text !== undefined ? { text } : {}) });
  function pinSetup() {
    // Names on a highlighted row are painted for its background, the others for the chat's.
    const env = setup({ hlBg: HL_BG });
    env.root.before(env.list.pinned);
    return env;
  }

  it('a highlighted entry is drawn highlighted, says so to screen readers first, and its name stays readable on its background', () => {
    // Arrange
    const { list, show } = pinSetup();

    // Act
    show([{ ...m(1, 'olha isso'), highlighted: true } as ChatEntry, m(2, 'normal')]);

    // Assert
    const [hl, plain] = rows(list);
    expect(hl!.classList.contains('highlighted')).toBe(true);
    expect(plain!.classList.contains('highlighted')).toBe(false);
    expect(hl!.firstElementChild!.classList.contains('hl-note')).toBe(true);
    expect(hl!.querySelector('.hl-note')!.textContent).toBe('Highlighted by the streamer: ');
    const nick = hl!.querySelector<HTMLElement>('.nick')!.style.getPropertyValue('--nick');
    expect(contrastRatio(nick, HL_BG)).toBeGreaterThanOrEqual(4.5);
  });

  it('highlight() marks a row on screen and one still waiting for a frame, and takes the mark off again', () => {
    // Arrange
    const { list, show, flush } = pinSetup();
    show([m(1, 'a')]);
    list.append([m(2, 'b')]);

    // Act
    list.highlight(1, true);
    list.highlight(2, true);
    flush();
    list.highlight(1, false);

    // Assert
    const [one, two] = rows(list);
    expect(one!.classList.contains('highlighted')).toBe(false);
    expect(one!.querySelector('.hl-note')).toBeNull();
    expect(two!.classList.contains('highlighted')).toBe(true);
  });

  it('highlight() never marks a hidden message or a system line', () => {
    // Arrange
    const { list, show } = pinSetup();
    show([m(1, 'bad \u{202E} text'), { kind: 'sys', s: 2, at: 1, code: 'chat.sys.cleared' }]);

    // Act
    list.highlight(1, true);
    list.highlight(2, true);

    // Assert
    expect(list.list.querySelectorAll('.highlighted').length).toBe(0);
  });

  it('the pinned bar shows the pin with the same text-node rules: markup stays text, the label is UI chrome', () => {
    // Arrange
    const { list } = pinSetup();

    // Act
    list.setPin(pinOf(7, HOSTILE));

    // Assert
    expect(list.pinned.hidden).toBe(false);
    expect(list.pinned.getAttribute('aria-label')).toBe('Pinned message');
    expect(list.pinned.querySelector('.pinned-label')!.textContent).toBe('Pinned by the streamer');
    const body = list.pinned.querySelector('.pinned-msg')!;
    expect(body.querySelector('bdi.text')!.textContent).toBe(HOSTILE);
    expect(body.querySelector('bdi.nick')!.textContent).toBe('Ana');
    expect(body.querySelectorAll('img, script, a').length).toBe(0);
    expect(list.list.querySelectorAll('li.msg').length).toBe(0);
  });

  it('a pin from the streamer carries the badge from the role; an unsafe pinned text is hidden', () => {
    // Arrange
    const { list } = pinSetup();

    // Act
    list.setPin(pinOf(1, 'bem-vindos', lucas));
    const streamer = list.pinned.querySelector('.badge')?.textContent;
    list.setPin(pinOf(2, 'bad \u{202E} text', ana, 6000));

    // Assert
    expect(streamer).toBe('Streamer');
    expect(list.pinned.querySelector('.pinned-msg')!.classList.contains('hidden-msg')).toBe(true);
    expect(list.pinned.textContent).toContain('Message hidden');
  });

  it('a new pin is announced politely and replaces the old one; null hides the bar', () => {
    // Arrange
    const { list } = pinSetup();
    const seen: Array<[number | null, boolean]> = [];
    list.onPin = (p, fresh) => seen.push([p?.s ?? null, fresh]);

    // Act
    list.setPin(pinOf(1, 'um'));
    const announced = list.live.textContent;
    list.setPin(pinOf(1, 'um'));
    list.setPin(pinOf(2, 'dois', ana, 6000));
    const text = list.pinned.querySelector('.pinned-msg .text')!.textContent;
    list.setPin(null);

    // Assert
    expect(announced).toBe('The streamer pinned a message.');
    expect(text).toBe('dois');
    expect(seen).toEqual([
      [1, true],
      [1, false],
      [2, true],
      [null, false],
    ]);
    expect(list.pinned.hidden).toBe(true);
  });

  it('"hide" hides this pin on this device only; the next pin shows again', () => {
    // Arrange
    const { list } = pinSetup();
    list.setPin(pinOf(1, 'um'));

    // Act
    list.pinned.querySelector<HTMLButtonElement>('.pinned-hide')!.click();
    const hiddenAfterClick = list.pinned.hidden;
    list.setPin(pinOf(1, 'um'));
    const hiddenSamePin = list.pinned.hidden;
    list.setPin(pinOf(1, 'um', ana, 7000));

    // Assert
    expect(hiddenAfterClick).toBe(true);
    expect(hiddenSamePin).toBe(true);
    expect(list.pinned.hidden).toBe(false);
    expect(document.activeElement).toBe(list.list);
  });

  it('with the chat off the bar is hidden, and comes back when the chat is on again', () => {
    // Arrange
    const { list } = pinSetup();
    list.setPin(pinOf(1, 'um'));

    // Act
    list.setPinAllowed(false);
    const off = list.pinned.hidden;
    list.setPinAllowed(true);

    // Assert
    expect(off).toBe(true);
    expect(list.pinned.hidden).toBe(false);
  });

  it('the pinned text starts folded; "Show more" unfolds it and says so', () => {
    // Arrange
    const { list } = pinSetup();
    list.setPin(pinOf(1, 'x '.repeat(150)));
    const box = list.pinned.querySelector<HTMLElement>('.pinned-msg')!;
    const more = list.pinned.querySelector<HTMLButtonElement>('.pinned-more')!;
    // happy-dom has no layout: make the text taller than its box, as a real browser would.
    Object.defineProperty(box, 'scrollHeight', { configurable: true, value: 120 });
    Object.defineProperty(box, 'clientHeight', { configurable: true, value: 40 });
    list.resume();

    // Act
    const folded = { clamped: box.classList.contains('clamped'), shown: !more.hidden, label: more.textContent, expanded: more.getAttribute('aria-expanded') };
    more.click();

    // Assert
    expect(folded).toEqual({ clamped: true, shown: true, label: 'Show more', expanded: 'false' });
    expect(box.classList.contains('clamped')).toBe(false);
    expect(more.textContent).toBe('Show less');
    expect(more.getAttribute('aria-expanded')).toBe('true');
  });

  it('a roster change re-colours the pinned name too', () => {
    // Arrange
    const { list } = pinSetup();
    list.setPin(pinOf(1, 'um'));

    // Act
    list.recolor({ ...ana, c: '#0090ff', n: 'Ana B' });

    // Assert
    const nick = list.pinned.querySelector<HTMLElement>('.nick')!;
    expect(nick.textContent).toBe('Ana B');
    expect(nick.dataset.c).toBe('#0090ff');
  });
});
