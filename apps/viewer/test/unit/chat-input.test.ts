// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { ChatPublicSettings, ChatYou } from '@swarmcast/shared/chat';
import { ChatInput, inputBlock, lengthState, oneLine } from '../../src/chat/input.js';

function settings(over: Partial<ChatPublicSettings> = {}): ChatPublicSettings {
  return { enabled: true, content: ['text', 'emotes'], slowS: 0, autoSlow: false, maxGraphemes: 200, maxEmoji: 30, newViewerWaitS: 0, colors: 'choose', linksBlocked: false, emotes: [], builtinEmotes: true, protect: 'off', streamerName: '', ...over };
}
const you: ChatYou = { a: 'me', color: '#0090ff', colorLocked: false, mutedUntil: null };
const NOW = 1_700_000_000_000;

describe('inputBlock: why the viewer cannot send', () => {
  it('chat off, muted, GIFs only: the box is disabled', () => {
    expect(inputBlock(null, you, true, NOW, 0)).toMatchObject({ key: 'chat.viewer.off', typing: false });
    expect(inputBlock(settings({ enabled: false }), you, true, NOW, 0)?.key).toBe('chat.viewer.off');
    expect(inputBlock(settings(), { ...you, mutedUntil: 'live' }, true, NOW, 0)?.key).toBe('chat.viewer.mutedLive');
    expect(inputBlock(settings(), { ...you, mutedUntil: NOW + 60_000 }, true, NOW, 0)).toMatchObject({ key: 'chat.viewer.mutedUntil', typing: false });
    expect(inputBlock(settings({ content: ['gifs'] }), you, true, NOW, 0)?.key).toBe('chat.viewer.gifsOnly');
  });
  it('a mute that ended does not block', () => {
    expect(inputBlock(settings(), { ...you, mutedUntil: NOW - 1 }, true, NOW, 0)).toBeNull();
  });
  it('offline, new-viewer wait and slow mode: typing stays possible, with a countdown', () => {
    expect(inputBlock(settings(), you, false, NOW, 0)).toMatchObject({ key: 'chat.viewer.offline', typing: true });
    expect(inputBlock(settings(), { ...you, waitUntil: NOW + 4200 }, true, NOW, 0)).toMatchObject({ key: 'chat.viewer.newViewer', params: { seconds: '5 s' }, typing: true });
    expect(inputBlock(settings(), you, true, NOW, NOW + 1500)).toMatchObject({ key: 'chat.viewer.wait', params: { seconds: '2 s' } });
    expect(inputBlock(settings(), you, true, NOW, 0)).toBeNull();
  });
});

describe('input limits (same rules as the server)', () => {
  it('counts graphemes, not UTF-16 units', () => {
    expect(lengthState('👩‍👩‍👧‍👦é', settings())).toMatchObject({ graphemes: 2, emoji: 1, over: false });
    expect(lengthState('a'.repeat(201), settings()).over).toBe(true);
    expect(lengthState('a'.repeat(20), settings({ maxGraphemes: 20 })).over).toBe(false);
    expect(lengthState('😀'.repeat(4), settings({ maxEmoji: 3 }))).toMatchObject({ emoji: 4, over: true });
  });
  it('one line: newlines and separators become spaces', () => {
    expect(oneLine('a\nb\r\nc\td e\u0085f')).toBe('a b c d e f');
  });
});

function makeInput(over: { settings?: ChatPublicSettings; connected?: boolean } = {}) {
  document.body.replaceChildren();
  const sent: string[] = [];
  let n = 0;
  let now = NOW;
  const input = new ChatInput({
    settings: () => over.settings ?? settings(),
    you: () => you,
    connected: () => over.connected ?? true,
    send: (text) => {
      sent.push(text);
      return ++n;
    },
    now: () => now,
  });
  document.body.append(input.form);
  const type = (v: string): void => {
    input.textarea.value = v;
    input.textarea.dispatchEvent(new Event('input'));
  };
  return { input, sent, type, tick: (ms: number) => (now += ms) };
}

describe('ChatInput', () => {
  it('Enter sends the trimmed text and empties the box; Shift+Enter does not send', () => {
    const { input, sent, type } = makeInput();
    type('  oi gente  ');
    input.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true }));
    expect(sent).toEqual([]);
    input.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    expect(sent).toEqual(['oi gente']);
    expect(input.textarea.value).toBe('');
  });

  it('the counter follows the text; over the limit it is red and Send is disabled', () => {
    const { input, type } = makeInput({ settings: settings({ maxGraphemes: 20 }) });
    type('a'.repeat(5));
    expect(input.counter.textContent).toBe('5/20');
    expect(input.sendButton.disabled).toBe(false);
    type('a'.repeat(21));
    expect(input.counter.classList.contains('over')).toBe(true);
    expect(input.sendButton.disabled).toBe(true);
    expect(input.status.textContent).toBe('Too long: 21 of 20 characters.');
  });

  it('a reject shows the translated reason and gives the text back into an empty box', () => {
    const { input, sent, type } = makeInput();
    type('palavra feia');
    input.submit();
    expect(input.textarea.value).toBe('');
    input.rejected(1, 'chat.err.blocked', undefined, undefined);
    expect(input.textarea.value).toBe('palavra feia');
    expect(input.status.classList.contains('error')).toBe(true);
    expect(input.status.textContent).not.toBe('');
    expect(sent).toEqual(['palavra feia']);
  });

  it('a reject does not overwrite what the viewer is typing now', () => {
    const { input, type } = makeInput();
    type('primeira');
    input.submit();
    type('segunda');
    input.rejected(1, 'chat.err.dup', undefined, undefined);
    expect(input.textarea.value).toBe('segunda');
  });

  it('slow mode: after a send, Send waits and the line counts down', () => {
    const { input, type, tick } = makeInput({ settings: settings({ slowS: 5 }) });
    type('um');
    input.submit();
    type('dois');
    expect(input.sendButton.disabled).toBe(true);
    expect(input.status.textContent).toBe('You can send again in 5 s.');
    tick(5000);
    input.update();
    expect(input.sendButton.disabled).toBe(false);
  });

  it('retryMs from a reject holds Send for that long', () => {
    const { input, type, tick } = makeInput();
    type('oi');
    input.submit();
    input.rejected(1, 'chat.err.slow', { count: 3 }, 3000);
    expect(input.sendButton.disabled).toBe(true);
    tick(3000);
    input.update();
    expect(input.sendButton.disabled).toBe(false);
  });

  it('chat off: the box is disabled and says so; emotes only changes the placeholder', () => {
    let m = makeInput({ settings: settings({ enabled: false }) });
    expect(m.input.textarea.disabled).toBe(true);
    expect(m.input.status.textContent).toBe('The chat is off.');
    m = makeInput({ settings: settings({ content: ['emotes'] }) });
    expect(m.input.textarea.placeholder).toBe('Only emotes and emoji right now');
  });

  it('insert() puts text at the caret', () => {
    const { input, type } = makeInput();
    type('oi !');
    input.textarea.setSelectionRange(3, 3);
    input.insert('😀');
    expect(input.textarea.value).toBe('oi 😀!');
  });

  it('the box allows at most 1,500 UTF-16 units (the server limit before its pipeline)', () => {
    const { input } = makeInput();
    expect(input.textarea.maxLength).toBe(1500);
    expect(input.textarea.getAttribute('enterkeyhint')).toBe('send');
  });
});
