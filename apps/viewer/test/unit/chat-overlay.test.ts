// @vitest-environment happy-dom
// The chat over the video (overlay-mode.ts and chat/overlay.ts, docs/CHAT.md "Chat over the video"):
// the viewer's choice (off by default, remembered, blocked storage), when it shows (the player fills
// the screen: full screen or the page-filling mode, and there is a chat), the bar button and the
// Settings switch, and the lines (at most CHAT_OVERLAY_LINES, each gone after CHAT_OVERLAY_FADE_S,
// a snapshot's only for what is left of it, deletes and clears) and the message box moved over the
// video and back, on a manual clock.
import { beforeEach, describe, expect, it } from 'vitest';
import { setLang } from '@swarmcast/shared/i18n';
import { CHAT_OVERLAY_FADE_S, CHAT_OVERLAY_LINES } from '@swarmcast/shared/chat';
import { createOverlayMode, loadOverlayPref, OVERLAY_PREF_KEY } from '../../src/overlay-mode.js';
import { ChatOverlay, FADE_OUT_MS } from '../../src/chat/overlay.js';
import type { ChatEntry } from '../../src/chat/session.js';

beforeEach(() => setLang('en'));

function memoryStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), map: m };
}

describe('overlay mode', () => {
  function mode(o: { storage?: ReturnType<typeof memoryStorage> | undefined } = {}) {
    document.body.innerHTML = `<div class="player"><video></video></div>
      <div id="row" hidden><input id="box" type="checkbox" /></div>`;
    const player = document.querySelector<HTMLElement>('.player')!;
    const row = document.getElementById('row')!;
    const box = document.getElementById('box') as HTMLInputElement;
    let fsEl: Element | null = null;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fsEl });
    const storage = 'storage' in o ? o.storage : memoryStorage();
    const m = createOverlayMode({ player, doc: document, storage, setting: { row, box }, labels: { button: 'Chat on the video', tip: 'tip' } });
    const calls: boolean[] = [];
    m.subscribe(() => calls.push(m.active));
    const fullscreen = (on: boolean) => {
      fsEl = on ? player : null;
      document.dispatchEvent(new Event('fullscreenchange'));
    };
    return { m, player, row, box, storage, calls, fullscreen };
  }

  it('is off by default; the button shows only while the player fills the screen and there is a chat; the Settings switch only with a chat', () => {
    // Arrange
    const { m, row, fullscreen } = mode();
    // Act
    const atStart = { hidden: m.button.hidden, row: row.hidden };
    m.setAvailable(true);
    const withChat = { hidden: m.button.hidden, row: row.hidden };
    fullscreen(true);
    // Assert
    expect(m.on).toBe(false);
    expect(atStart).toEqual({ hidden: true, row: true });
    expect(withChat).toEqual({ hidden: true, row: false });
    expect(m.button.hidden).toBe(false);
    expect(m.button.getAttribute('aria-pressed')).toBe('false');
    expect(m.button.textContent).toBe('Chat on the video');
    expect(m.active).toBe(false);
  });

  it('the button and the switch set the same choice, remembered in this browser; active only with all three, and listeners hear each change once', () => {
    // Arrange
    const { m, box, storage, calls, fullscreen } = mode();
    m.setAvailable(true);
    fullscreen(true);
    // Act
    m.button.click();
    const afterButton = { active: m.active, pressed: m.button.getAttribute('aria-pressed'), box: box.checked };
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    fullscreen(false);
    m.setAvailable(false);
    fullscreen(true);
    m.setAvailable(true);
    // Assert
    expect(afterButton).toEqual({ active: true, pressed: 'true', box: true });
    expect(calls).toEqual([true, false, true, false, true]);
    expect(storage!.map.get(OVERLAY_PREF_KEY)).toBe('on');
    expect(loadOverlayPref(storage)).toBe(true);
  });

  it("the page-filling mode counts as filling the screen (player-controls.ts' sc-fillchange)", () => {
    // Arrange
    const { m, player } = mode({ storage: memoryStorage({ [OVERLAY_PREF_KEY]: 'on' }) });
    m.setAvailable(true);
    // Act
    player.classList.add('pc-fill');
    player.dispatchEvent(new Event('sc-fillchange'));
    // Assert
    expect(m.fills).toBe(true);
    expect(m.active).toBe(true);
  });

  it('C opens the message box only while it shows', () => {
    // Arrange
    const { m, fullscreen } = mode({ storage: memoryStorage({ [OVERLAY_PREF_KEY]: 'on' }) });
    let opened = 0;
    m.setInputOpener(() => (opened++, true));
    // Act
    const before = m.openInput();
    m.setAvailable(true);
    fullscreen(true);
    const during = m.openInput();
    // Assert
    expect([before, during, opened]).toEqual([false, true, 1]);
  });

  it('with storage blocked the choice lasts for this page only', () => {
    // Arrange
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    document.body.innerHTML = '<div class="player"></div>';
    const m = createOverlayMode({ player: document.querySelector<HTMLElement>('.player')!, doc: document, storage: throwing, labels: { button: 'b', tip: 't' } });
    // Act
    m.set(true);
    // Assert
    expect(m.on).toBe(true);
  });
});

describe('ChatOverlay', () => {
  function overlay() {
    document.body.innerHTML = '<div class="player"><video></video><div class="pc"><div class="pc-bar"></div></div></div><aside id="chat"><form id="form"><textarea></textarea></form></aside>';
    const player = document.querySelector<HTMLElement>('.player')!;
    const form = document.getElementById('form')!;
    const chat = document.getElementById('chat')!;
    let now = 1_700_000_000_000;
    let id = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    const o = new ChatOverlay({
      player,
      line: (e) => {
        if (e.kind !== 'msg' || e.gif) return e.kind === 'sys' ? Object.assign(document.createElement('div'), { className: 'ov-line sys', textContent: 'sys' }) : null;
        const el = document.createElement('div');
        el.className = 'ov-line';
        el.textContent = `${e.author.n}: ${e.text ?? ''}`;
        return el;
      },
      moveInput: (host) => (host ? host.append(form) : chat.append(form)),
      focusInput: () => form.querySelector('textarea')!.focus(),
      now: () => now,
      setTimer: (fn, ms) => (timers.set(++id, { at: now + ms, fn }), id),
      clearTimer: (t) => void timers.delete(t as number),
    });
    const advance = (ms: number) => {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    };
    const msg = (s: number, text: string, at = now): ChatEntry => ({ kind: 'msg', s, at, author: { a: 'k1', n: 'Ana', c: '#e5484d', r: 'viewer' }, text });
    const texts = () => [...o.root.querySelectorAll('.ov-line')].map((e) => e.textContent);
    return { o, player, form, chat, advance, msg, texts, now: () => now, timers };
  }

  it('sits in the player before its controls, hidden until it shows; its lines are hidden from screen readers', () => {
    // Arrange
    const { o, player } = overlay();
    // Assert
    expect([...player.children].map((e) => e.className)).toEqual(['', 'chat-overlay', 'pc']);
    expect(o.root.hidden).toBe(true);
    expect(o.root.querySelector('.ov-lines')!.getAttribute('aria-hidden')).toBe('true');
  });

  it(`keeps at most ${CHAT_OVERLAY_LINES} lines; each starts to fade ${FADE_OUT_MS} ms before it goes, ${CHAT_OVERLAY_FADE_S} s after it came; GIFs and skips are left out`, () => {
    // Arrange
    const { o, advance, msg, texts } = overlay();
    // Act
    o.add(Array.from({ length: CHAT_OVERLAY_LINES + 2 }, (_, i) => msg(i + 1, `m${i + 1}`)));
    o.add([{ kind: 'skip', n: 3 }, { ...msg(20, ''), gif: { p: 'klipy', id: 'x', w: 100, h: 100, m: '/x' } } as ChatEntry]);
    const first = texts();
    advance(CHAT_OVERLAY_FADE_S * 1000 - FADE_OUT_MS);
    const fading = o.root.querySelectorAll('.ov-old').length;
    advance(FADE_OUT_MS - 1);
    const stillThere = o.count;
    advance(1);
    // Assert
    expect(first).toEqual(Array.from({ length: CHAT_OVERLAY_LINES }, (_, i) => `Ana: m${i + 3}`));
    expect(fading).toBe(CHAT_OVERLAY_LINES);
    expect(stillThere).toBe(CHAT_OVERLAY_LINES);
    expect(o.count).toBe(0);
    expect(texts()).toEqual([]);
  });

  it("a snapshot's messages show only for what is left of their time; older ones not at all", () => {
    // Arrange
    const { o, advance, msg, texts, now } = overlay();
    // Act
    o.reset([msg(1, 'antiga', now() - 60_000), msg(2, 'recente', now() - 10_000), msg(3, 'agora', now() + 5_000)]);
    const shown = texts();
    advance(2_000);
    const later = texts();
    advance(CHAT_OVERLAY_FADE_S * 1000);
    // Assert
    expect(shown).toEqual(['Ana: recente', 'Ana: agora']);
    expect(later).toEqual(['Ana: agora']);
    expect(texts()).toEqual([]);
  });

  it('deleted messages go, Clear removes what it covers, a reset drops what showed', () => {
    // Arrange
    const { o, msg, texts } = overlay();
    o.add([msg(1, 'a'), msg(2, 'b'), msg(3, 'c'), { kind: 'sys', s: 4, at: 0, code: 'chat.sys.protect' }]);
    // Act
    o.remove([2]);
    const afterDelete = texts();
    o.clearUpTo(3);
    const afterClear = texts();
    o.reset();
    // Assert
    expect(afterDelete).toEqual(['Ana: a', 'Ana: c', 'sys']);
    expect(afterClear).toEqual(['sys']);
    expect(texts()).toEqual([]);
  });

  it('the message box moves over the video and back with its button, only while it shows; hiding it puts the box back', () => {
    // Arrange
    const { o, form, chat } = overlay();
    const write = o.root.querySelector<HTMLButtonElement>('.ov-write')!;
    // Act
    const whileHidden = o.openInput();
    o.setActive(true);
    write.click();
    const open = { inOverlay: o.root.contains(form), expanded: write.getAttribute('aria-expanded'), label: write.textContent, focus: document.activeElement === form.querySelector('textarea') };
    write.click();
    const closed = { inChat: chat.contains(form), focus: document.activeElement === write, label: write.textContent };
    o.openInput();
    o.setActive(false);
    // Assert
    expect(whileHidden).toBe(false);
    expect(open).toEqual({ inOverlay: true, expanded: 'true', label: 'Close the message box', focus: true });
    expect(closed).toEqual({ inChat: true, focus: true, label: 'Write a message' });
    expect(chat.contains(form)).toBe(true);
    expect(o.writing).toBe(false);
    expect(o.root.hidden).toBe(true);
  });

  it('is placed just above the player\'s control bar, measured', () => {
    // Arrange
    const { o, player } = overlay();
    const bar = player.querySelector<HTMLElement>('.pc-bar')!;
    bar.getBoundingClientRect = () => ({ height: 60.4, width: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    // Act
    o.setActive(true);
    // Assert
    expect(o.root.style.getPropertyValue('--ov-bottom')).toBe('69px');
  });

  it('is named in Portuguese', () => {
    // Arrange
    setLang('pt-BR');
    // Act
    const { o } = overlay();
    // Assert
    expect(o.root.querySelector('.ov-write')!.textContent).toBe('Escrever uma mensagem');
  });
});
