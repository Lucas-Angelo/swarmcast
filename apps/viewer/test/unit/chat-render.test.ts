// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { contrastRatio, adjustNameColor, CHAT_BG_DARK, CHAT_BG_LIGHT, type ChatAuthor } from '@swarmcast/shared/chat';
import { ChatList, DOM_MAX, RENDER_PER_FRAME } from '../../src/chat/render.js';
import type { ChatEntry } from '../../src/chat/session.js';
import type { Emote } from '../../src/chat/emotes.js';

const ana: ChatAuthor = { a: 'k1', n: 'Ana', c: '#ffee88', r: 'viewer' };
const lucas: ChatAuthor = { a: 'k0', n: 'Lucas', c: '#000000', r: 'streamer' };
const m = (s: number, text: string, author: ChatAuthor = ana): ChatEntry => ({ kind: 'msg', s, at: 1_700_000_000_000 + s, author, text });

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
  return { list, root, flush, setVisible: (v: boolean) => (visible = v) };
}

const rows = (list: ChatList): HTMLLIElement[] => [...list.list.querySelectorAll<HTMLLIElement>('li')];

describe('ChatList render rules', () => {
  beforeEach(() => document.body.replaceChildren());

  it('builds text with text nodes only: markup stays text, never elements', () => {
    const { list, flush } = setup();
    const hostile = '<img src=x onerror=alert(1)><script>x</script> javascript:alert(1) https://evil.example/a.png';
    list.append([m(1, hostile)]);
    flush();
    const li = list.list.querySelector('li.msg')!;
    expect(li.querySelector('.text')!.textContent).toBe(hostile);
    expect(li.querySelectorAll('img, script, a').length).toBe(0);
    expect(li.querySelector('bdi.nick')!.textContent).toBe('Ana');
    expect(li.querySelector('bdi.text')!.getAttribute('dir')).toBe('auto');
    expect(li.getAttribute('data-seq')).toBe('1');
  });

  it('known :codes: become emote images, unknown ones stay text', () => {
    const { list, flush } = setup();
    list.append([m(1, 'oi :hi: :nope: :HI:')]);
    flush();
    const text = list.list.querySelector('li.msg .text')!;
    const imgs = text.querySelectorAll('img.emote');
    expect(imgs.length).toBe(1);
    expect(imgs[0]!.getAttribute('alt')).toBe(':hi:');
    expect(imgs[0]!.getAttribute('src')).toBe('/assets/hi.webp');
    expect(text.textContent).toBe('oi  :nope: :HI:');
  });

  it('hides a text or nickname that breaks the safety invariants (a server bug never reaches the DOM)', () => {
    const { list, flush } = setup();
    list.append([
      m(1, 'abc‮fdp.exe'),
      m(2, 'e' + '́̂̃̄̅'),
      m(3, 'ok', { ...ana, n: 'Mark‮kram' }),
      m(4, 'a\nb'),
      m(5, 'fine 😀'),
    ]);
    flush();
    const r = rows(list);
    expect(r.filter((li) => li.classList.contains('hidden-msg')).length).toBe(4);
    expect(r[0]!.textContent).toBe('Message hidden');
    expect(r[0]!.textContent).not.toContain('fdp');
    expect(r[4]!.querySelector('.text')!.textContent).toBe('fine 😀');
    expect(list.stats.hidden).toBe(4);
  });

  it('an empty streamer name shows the translated default', () => {
    const { list, flush } = setup();
    list.append([m(1, 'oi', { ...lucas, n: '' })]);
    flush();
    expect(list.list.querySelector('li.from-streamer .nick')!.textContent).toBe('Streamer');
    expect(list.list.querySelectorAll('li.hidden-msg')).toHaveLength(0);
  });

  it('the streamer gets a badge from the role and a theme colour, never a user colour', () => {
    const { list, flush } = setup();
    list.append([m(1, 'oi', lucas)]);
    flush();
    const li = list.list.querySelector('li.msg')!;
    expect(li.classList.contains('from-streamer')).toBe(true);
    expect(li.querySelector('.badge')!.textContent).toBe('Streamer');
    expect((li.querySelector('.nick') as HTMLElement).style.getPropertyValue('--nick')).toBe('');
  });

  for (const bg of [CHAT_BG_LIGHT, CHAT_BG_DARK]) {
    it(`names are painted with ≥ 4.5:1 on ${bg} through the CSSOM`, () => {
      const { list, flush } = setup({ bg });
      list.append(['#ffee88', '#101010', '#0090ff', 'not-a-colour'].map((c, i) => m(i + 1, 'x', { a: `k${i}`, n: `N${i}`, c, r: 'viewer' })));
      flush();
      for (const nick of list.list.querySelectorAll<HTMLElement>('.nick')) {
        const c = nick.style.getPropertyValue('--nick');
        expect(c).toMatch(/^#[0-9a-f]{6}$/);
        expect(contrastRatio(c, bg)).toBeGreaterThanOrEqual(4.5);
        expect(nick.getAttribute('style') ?? '').not.toContain('color:');
      }
    });
  }

  it(`renders at most ${RENDER_PER_FRAME} per frame: older ones become one "skipped" line`, () => {
    const { list, flush } = setup();
    list.append(Array.from({ length: 120 }, (_, i) => m(i + 1, `m${i + 1}`)));
    flush();
    const r = rows(list);
    expect(r.length).toBe(RENDER_PER_FRAME);
    expect(r[0]!.classList.contains('skipped')).toBe(true);
    expect(r[0]!.textContent).toBe('71 messages skipped');
    expect(r.at(-1)!.dataset.seq).toBe('120');
  });

  it(`keeps at most ${DOM_MAX} rows`, () => {
    const { list, flush } = setup();
    for (let b = 0; b < 8; b++) {
      list.append(Array.from({ length: 40 }, (_, i) => m(b * 40 + i + 1, 'x')));
      flush();
    }
    expect(rows(list).length).toBe(DOM_MAX);
    expect(rows(list).at(-1)!.dataset.seq).toBe('320');
  });

  it('renders nothing while hidden; on return shows what waited (capped)', () => {
    const { list, flush, setVisible } = setup({ visible: false });
    list.append(Array.from({ length: 30 }, (_, i) => m(i + 1, 'x')));
    flush();
    expect(list.list.querySelectorAll('li.msg').length).toBe(0);
    setVisible(true);
    list.resume();
    flush();
    expect(list.list.querySelectorAll('li.msg').length).toBe(30);
  });

  it('own message: "sending…", then replaced by the server copy; a reject marks it "not sent"', () => {
    const { list, flush } = setup();
    list.addPending(11, 'oi', ana);
    expect(list.list.querySelector('li.pending .state')!.textContent).toBe('sending…');
    list.ack(11, 5);
    list.append([m(5, 'oi')]);
    flush();
    expect(list.list.querySelectorAll('li.pending').length).toBe(0);
    expect(list.list.querySelectorAll('li.msg').length).toBe(1);
    list.addPending(12, 'feio', ana);
    list.reject(12);
    expect(list.list.querySelector('li.failed .state')!.textContent).toBe('not sent');
    expect(list.list.querySelector('li.failed .text')!.textContent).toBe('feio');
  });

  it('removes deleted messages and clears up to a seq', () => {
    const { list, flush } = setup();
    list.append([m(1, 'a'), m(2, 'b'), m(3, 'c')]);
    flush();
    list.remove([2]);
    expect(rows(list).map((r) => r.dataset.seq)).toEqual(['1', '3']);
    list.clearUpTo(3);
    expect(list.list.querySelectorAll('li.msg').length).toBe(0);
  });

  it('a roster change re-colours that author only', () => {
    const { list, flush } = setup();
    list.append([m(1, 'a'), m(2, 'b', { a: 'k9', n: 'Rafa', c: '#46a758', r: 'viewer' })]);
    flush();
    list.recolor({ ...ana, c: '#0090ff' });
    const nicks = [...list.list.querySelectorAll<HTMLElement>('.nick')];
    expect(nicks[0]!.dataset.c).toBe('#0090ff');
    expect(nicks[1]!.dataset.c).toBe('#46a758');
  });

  it('the list is a log region with a separate polite status for summaries', () => {
    const { list } = setup();
    expect(list.list.getAttribute('role')).toBe('log');
    expect(list.list.getAttribute('aria-live')).toBe('off');
    expect(list.live.getAttribute('aria-live')).toBe('polite');
  });
});
