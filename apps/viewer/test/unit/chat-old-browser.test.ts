// @vitest-environment happy-dom
// Plan §2.4.1b: the chat needs neither Intl.Segmenter (the shared core has its own UAX #29
// segmenter) nor String.prototype.isWellFormed (Safari < 16.4). The modules are loaded fresh after
// the APIs are removed, so nothing cached a reference before. Test files are isolated (Vitest's
// default), so no other file sees the APIs missing.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const intl = Intl as unknown as Record<string, unknown>;
const proto = String.prototype as unknown as Record<string, unknown>;
const saved = { segmenter: intl.Segmenter, isWellFormed: proto.isWellFormed };

beforeAll(() => {
  vi.resetModules();
  delete intl.Segmenter;
  delete proto.isWellFormed;
  if ('Segmenter' in Intl || 'isWellFormed' in String.prototype) throw new Error('could not remove Intl.Segmenter / String.prototype.isWellFormed');
});

afterAll(() => {
  intl.Segmenter = saved.segmenter;
  proto.isWellFormed = saved.isWellFormed;
});

/** A chat list (loaded after the APIs went) with the :hi: emote; `show` renders entries now. */
async function oldBrowserList() {
  const { ChatList } = await import('../../src/chat/render.js');
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const frames: Array<() => void> = [];
  const list = new ChatList(root, {
    emotes: () => new Map([['hi', { code: 'hi', url: '/a/hi.webp', url2x: '', w: 56, h: 56 }]]),
    nickColor: () => '#0f5c53',
    showTimes: () => true,
    visible: () => true,
    raf: (cb) => frames.push(cb),
  });
  const author = { a: 'k1', n: 'Ana', c: '#e5484d', r: 'viewer' as const };
  const show = (...texts: string[]): Element[] => {
    list.append(texts.map((text, i) => ({ kind: 'msg' as const, s: i + 1, at: i + 1, author, text })));
    while (frames.length) frames.shift()!();
    return [...list.list.querySelectorAll('li.msg')];
  };
  return { show };
}

describe('chat on an older browser', () => {
  it('renders a message with a family emoji and an emote', async () => {
    // Arrange
    const { show } = await oldBrowserList();

    // Act
    const [row] = show('boa noite 👩‍👩‍👧‍👦 :hi:');

    // Assert
    expect(row!.querySelector('.text')!.textContent).toBe('boa noite 👩‍👩‍👧‍👦 ');
    expect(row!.querySelector('img.emote')).not.toBeNull();
  });

  it('still hides unsafe text: a bidi override and a lone surrogate', async () => {
    // Arrange
    const { show } = await oldBrowserList();

    // Act
    const rows = show('abc‮fdp.exe', 'lone \uD800');

    // Assert
    expect(rows.map((r) => r.classList.contains('hidden-msg'))).toEqual([true, true]);
  });

  it('the input still counts graphemes', async () => {
    // Arrange
    const { lengthState } = await import('../../src/chat/input.js');

    // Act
    const states = [lengthState('olá 👩‍👩‍👧‍👦', null), lengthState('a'.repeat(250), null)];

    // Assert
    expect(states[0]).toMatchObject({ graphemes: 5, emoji: 1 });
    expect(states[1]!.over).toBe(true);
  });
});
