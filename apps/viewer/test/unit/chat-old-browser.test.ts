// @vitest-environment happy-dom
// Plan §2.4.1b: the chat needs neither Intl.Segmenter (the shared core has its own UAX #29
// segmenter) nor String.prototype.isWellFormed (Safari < 16.4). The modules are loaded fresh after
// the APIs are removed, so nothing cached a reference before.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const intl = Intl as unknown as Record<string, unknown>;
const proto = String.prototype as unknown as Record<string, unknown>;
const saved = { segmenter: intl.Segmenter, isWellFormed: proto.isWellFormed };

beforeAll(() => {
  vi.resetModules();
  delete intl.Segmenter;
  delete proto.isWellFormed;
});

afterAll(() => {
  intl.Segmenter = saved.segmenter;
  proto.isWellFormed = saved.isWellFormed;
});

describe('chat on an older browser', () => {
  it('renders messages and emotes, and still hides unsafe text', async () => {
    expect('Segmenter' in Intl).toBe(false);
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
    list.append([
      { kind: 'msg', s: 1, at: 1, author, text: 'boa noite 👩‍👩‍👧‍👦 :hi:' },
      { kind: 'msg', s: 2, at: 2, author, text: 'abc‮fdp.exe' },
      { kind: 'msg', s: 3, at: 3, author, text: 'lone \uD800' },
    ]);
    while (frames.length) frames.shift()!();
    const rows = [...list.list.querySelectorAll('li.msg')];
    expect(rows[0]!.querySelector('.text')!.textContent).toBe('boa noite 👩‍👩‍👧‍👦 ');
    expect(rows[0]!.querySelector('img.emote')).not.toBeNull();
    expect(rows[1]!.classList.contains('hidden-msg')).toBe(true);
    expect(rows[2]!.classList.contains('hidden-msg')).toBe(true);
  });

  it('the input still counts graphemes', async () => {
    const { lengthState } = await import('../../src/chat/input.js');
    expect(lengthState('olá 👩‍👩‍👧‍👦', null)).toMatchObject({ graphemes: 5, emoji: 1 });
    expect(lengthState('a'.repeat(250), null).over).toBe(true);
  });
});
