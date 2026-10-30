// @vitest-environment happy-dom
// The chat box (chat/input.ts): why the viewer cannot send right now, the length rules it shares
// with the server, and the box itself. Time comes from an injected clock (NOW, moved by `tick`).
import { describe, expect, it } from 'vitest';
import type { ChatPublicSettings, ChatYou } from '@swarmcast/shared/chat';
import { ChatInput, inputBlock, lengthState, oneLine } from '../../src/chat/input.js';

function settings(over: Partial<ChatPublicSettings> = {}): ChatPublicSettings {
  return { enabled: true, content: ['text', 'emotes'], slowS: 0, autoSlow: false, maxGraphemes: 200, maxEmoji: 30, newViewerWaitS: 0, colors: 'choose', linksBlocked: false, emotes: [], builtinEmotes: true, protect: 'off', streamerName: '', ...over };
}
const you: ChatYou = { a: 'me', color: '#0090ff', colorLocked: false, mutedUntil: null };
const NOW = 1_700_000_000_000;

/** A chat box in the page. `type` puts text in it like the viewer does; `tick` moves its clock; `sent` has what it sent. */
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
  const key = (k: string, o: KeyboardEventInit = {}): void => void input.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: k, cancelable: true, ...o }));
  return { input, sent, type, key, tick: (ms: number) => (now += ms) };
}

describe('inputBlock: why the viewer cannot send', () => {
  it.each([
    ['chat off (no settings)', null, you, { key: 'chat.viewer.off', typing: false }],
    ['chat off', settings({ enabled: false }), you, { key: 'chat.viewer.off' }],
    ['muted until the stream ends', settings(), { ...you, mutedUntil: 'live' as const }, { key: 'chat.viewer.mutedLive' }],
    ['muted for a while', settings(), { ...you, mutedUntil: NOW + 60_000 }, { key: 'chat.viewer.mutedUntil', typing: false }],
    ['GIFs only', settings({ content: ['gifs'] }), you, { key: 'chat.viewer.gifsOnly' }],
  ])('%s: the box is disabled', (_case, s, y, block) => {
    // Act
    const why = inputBlock(s, y, true, NOW, 0);

    // Assert
    expect(why).toMatchObject(block);
  });

  it('a mute that ended does not block', () => {
    // Act
    const why = inputBlock(settings(), { ...you, mutedUntil: NOW - 1 }, true, NOW, 0);

    // Assert
    expect(why).toBeNull();
  });

  it.each([
    ['offline', you, false, 0, { key: 'chat.viewer.offline', typing: true }],
    ['the new-viewer wait (rounded up)', { ...you, waitUntil: NOW + 4200 }, true, 0, { key: 'chat.viewer.newViewer', params: { seconds: '5 s' }, typing: true }],
    ['slow mode', you, true, NOW + 1500, { key: 'chat.viewer.wait', params: { seconds: '2 s' } }],
  ])('%s: typing stays possible, with a countdown', (_case, y, connected, nextAt, block) => {
    // Act
    const why = inputBlock(settings(), y, connected, NOW, nextAt);

    // Assert
    expect(why).toMatchObject(block);
  });

  it('nothing in the way: no block', () => {
    // Act
    const why = inputBlock(settings(), you, true, NOW, 0);

    // Assert
    expect(why).toBeNull();
  });
});

describe('input limits (same rules as the server)', () => {
  it.each([
    ['a family emoji and an accented letter are 2 graphemes, 1 emoji', '👩‍👩‍👧‍👦é', settings(), { graphemes: 2, emoji: 1, over: false }],
    ['201 letters are over 200', 'a'.repeat(201), settings(), { over: true }],
    ['20 letters fit a 20 limit', 'a'.repeat(20), settings({ maxGraphemes: 20 }), { over: false }],
    ['4 emoji are over a 3 emoji limit', '😀'.repeat(4), settings({ maxEmoji: 3 }), { emoji: 4, over: true }],
  ])('counts graphemes, not UTF-16 units: %s', (_case, text, s, state) => {
    // Act
    const got = lengthState(text, s);

    // Assert
    expect(got).toMatchObject(state);
  });

  it('one line: newlines and separators become spaces', () => {
    // Act
    const line = oneLine('a\nb\r\nc\td e\u0085f');

    // Assert
    expect(line).toBe('a b c d e f');
  });
});

describe('ChatInput', () => {
  it('Enter sends the trimmed text and empties the box', () => {
    // Arrange
    const { input, sent, type, key } = makeInput();
    type('  oi gente  ');

    // Act
    key('Enter');

    // Assert
    expect(sent).toEqual(['oi gente']);
    expect(input.textarea.value).toBe('');
  });

  it('Shift+Enter does not send', () => {
    // Arrange
    const { sent, type, key } = makeInput();
    type('oi gente');

    // Act
    key('Enter', { shiftKey: true });

    // Assert
    expect(sent).toEqual([]);
  });

  it('the counter follows the text', () => {
    // Arrange
    const { input, type } = makeInput({ settings: settings({ maxGraphemes: 20 }) });

    // Act
    type('a'.repeat(5));

    // Assert
    expect(input.counter.textContent).toBe('5/20');
    expect(input.sendButton.disabled).toBe(false);
  });

  it('over the limit the counter is red, Send is disabled and the status says by how much', () => {
    // Arrange
    const { input, type } = makeInput({ settings: settings({ maxGraphemes: 20 }) });

    // Act
    type('a'.repeat(21));

    // Assert
    expect(input.counter.classList.contains('over')).toBe(true);
    expect(input.sendButton.disabled).toBe(true);
    expect(input.status.textContent).toBe('Too long: 21 of 20 characters.');
  });

  it('a reject shows the translated reason and gives the text back into an empty box', () => {
    // Arrange
    const { input, sent, type } = makeInput();
    type('palavra feia');
    input.submit();

    // Act
    input.rejected(1, 'chat.err.blocked', undefined, undefined);

    // Assert
    expect(sent).toEqual(['palavra feia']);
    expect(input.textarea.value).toBe('palavra feia');
    expect(input.status.classList.contains('error')).toBe(true);
    expect(input.status.textContent).not.toBe('');
  });

  it('a reject without a nonce belongs to the oldest send still waiting', () => {
    // Arrange
    const { input, type } = makeInput();
    type('um');

    // Act
    input.submit();
    type('dois');
    input.submit();

    // Assert
    expect(input.oldestPending()).toBe(1);
  });

  it('once the oldest send is acked, the next one is the oldest still waiting', () => {
    // Arrange
    const { input, type } = makeInput();
    type('um');
    input.submit();
    type('dois');
    input.submit();

    // Act
    input.acked(1);

    // Assert
    expect(input.oldestPending()).toBe(2);
  });

  it('a reject does not overwrite what the viewer is typing now', () => {
    // Arrange
    const { input, type } = makeInput();
    type('primeira');
    input.submit();
    type('segunda');

    // Act
    input.rejected(1, 'chat.err.dup', undefined, undefined);

    // Assert
    expect(input.textarea.value).toBe('segunda');
  });

  it('slow mode: after a send, Send waits and the line counts down', () => {
    // Arrange
    const { input, type } = makeInput({ settings: settings({ slowS: 5 }) });
    type('um');

    // Act
    input.submit();
    type('dois');

    // Assert
    expect(input.sendButton.disabled).toBe(true);
    expect(input.status.textContent).toBe('You can send again in 5 s.');
  });

  it('slow mode: Send comes back once the wait is over', () => {
    // Arrange
    const { input, type, tick } = makeInput({ settings: settings({ slowS: 5 }) });
    type('um');
    input.submit();
    type('dois');

    // Act
    tick(5000);
    input.update();

    // Assert
    expect(input.sendButton.disabled).toBe(false);
  });

  it("slow mode counts from the server's ack: a send that took a while to arrive does not end the wait early", () => {
    // Arrange
    const { input, type, tick } = makeInput({ settings: settings({ slowS: 5 }) });
    type('um');
    input.submit();
    tick(300);
    input.acked(1);
    type('dois');

    // Act
    tick(4999);
    input.update();

    // Assert
    expect(input.sendButton.disabled).toBe(true);
  });

  it('slow mode: Send comes back slowS after the ack', () => {
    // Arrange
    const { input, type, tick } = makeInput({ settings: settings({ slowS: 5 }) });
    type('um');
    input.submit();
    tick(300);
    input.acked(1);
    type('dois');

    // Act
    tick(5000);
    input.update();

    // Assert
    expect(input.sendButton.disabled).toBe(false);
  });

  it('a GIF the server took starts the slow-mode wait too', () => {
    // Arrange
    const { input, type, tick } = makeInput({ settings: settings({ slowS: 5 }) });
    input.noteSent(7);
    tick(200);
    input.acked(7);
    type('oi');

    // Act
    tick(4999);
    input.update();

    // Assert
    expect(input.sendButton.disabled).toBe(true);
  });

  it('slow mode: a message the server refused starts no wait, so it can be fixed and sent again', () => {
    // Arrange
    const { input, type } = makeInput({ settings: settings({ slowS: 5 }) });
    type('um');
    input.submit();

    // Act
    input.rejected(1, 'chat.err.blocked', undefined, undefined);

    // Assert
    expect(input.sendButton.disabled).toBe(false);
  });

  it.each([
    ['without retryMs (lockdown)', 'chat.err.protect', undefined],
    ['with a shorter retryMs (busy)', 'chat.err.busy', 3000],
  ] as const)('a GIF refused %s does not end the wait of a message the server took', (_case, code, retryMs) => {
    // Arrange
    const { input, type, tick } = makeInput({ settings: settings({ slowS: 5 }) });
    type('um');
    input.submit();
    tick(300);
    input.acked(1);
    input.noteSent(2);
    tick(700);
    input.rejected(2, code, undefined, retryMs);
    type('dois');

    // Act
    tick(4299);
    input.update();

    // Assert
    expect(input.sendButton.disabled).toBe(true);
  });

  it('retryMs from a reject holds Send', () => {
    // Arrange
    const { input, type } = makeInput();
    type('oi');
    input.submit();

    // Act
    input.rejected(1, 'chat.err.slow', { count: 3 }, 3000);

    // Assert
    expect(input.sendButton.disabled).toBe(true);
  });

  it('Send comes back once retryMs is over', () => {
    // Arrange
    const { input, type, tick } = makeInput();
    type('oi');
    input.submit();
    input.rejected(1, 'chat.err.slow', { count: 3 }, 3000);

    // Act
    tick(3000);
    input.update();

    // Assert
    expect(input.sendButton.disabled).toBe(false);
  });

  it('chat off: the box is disabled and says so', () => {
    // Act
    const { input } = makeInput({ settings: settings({ enabled: false }) });

    // Assert
    expect(input.textarea.disabled).toBe(true);
    expect(input.status.textContent).toBe('The chat is off.');
  });

  it('emotes only: the placeholder says so', () => {
    // Act
    const { input } = makeInput({ settings: settings({ content: ['emotes'] }) });

    // Assert
    expect(input.textarea.placeholder).toBe('Only emotes and emoji right now');
  });

  it('insert() puts text at the caret', () => {
    // Arrange
    const { input, type } = makeInput();
    type('oi !');
    input.textarea.setSelectionRange(3, 3);

    // Act
    input.insert('😀');

    // Assert
    expect(input.textarea.value).toBe('oi 😀!');
  });

  it('the box allows at most 1,500 UTF-16 units (the server limit before its pipeline) and its Enter key says "send"', () => {
    // Act
    const { input } = makeInput();

    // Assert
    expect(input.textarea.maxLength).toBe(1500);
    expect(input.textarea.getAttribute('enterkeyhint')).toBe('send');
  });
});
