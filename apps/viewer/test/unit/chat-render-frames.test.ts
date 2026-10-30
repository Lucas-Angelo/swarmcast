// @vitest-environment happy-dom
// When the chat list draws (apps/viewer/src/chat/render.ts): on the next animation frame, or from
// a timer when that frame is FRAME_FALLBACK_MS late. Browsers may skip rendering opportunities of
// a page they still report as visible (HTML "update the rendering"; WebKit throttles visually idle
// pages, rendering stalls on a busy VM), and a message must not wait for them: in the stability
// soak a second viewer's page on WebKit/macOS did not show a message within 5 s (1 run in 30).
// Frames and timers are doubles the test fires by hand.
import { describe, expect, it } from 'vitest';
import type { ChatAuthor } from '@swarmcast/shared/chat';
import { ChatList, FRAME_FALLBACK_MS } from '../../src/chat/render.js';
import type { ChatEntry } from '../../src/chat/session.js';

const ana: ChatAuthor = { a: 'k1', n: 'Ana', c: '#0f5c53', r: 'viewer' };
const msg = (s: number, text: string): ChatEntry => ({ kind: 'msg', s, at: 1_700_000_000_000 + s, author: ana, text });

/** A chat list whose animation frames and timers fire only when the test says so. */
function chatList(o: { visible?: () => boolean } = {}) {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  const frames: Array<() => void> = [];
  const timers: Array<{ cb: () => void; ms: number; cancelled: boolean }> = [];
  const list = new ChatList(root, {
    emotes: () => new Map(),
    nickColor: (c) => c,
    showTimes: () => false,
    visible: o.visible ?? (() => true),
    raf: (cb) => frames.push(cb),
    later: (cb, ms) => {
      const timer = { cb, ms, cancelled: false };
      timers.push(timer);
      return () => (timer.cancelled = true);
    },
  });
  const texts = (): string[] => [...list.list.querySelectorAll('li.msg .text')].map((el) => el.textContent ?? '');
  const nextFrame = (): void => frames.shift()!();
  const timerFires = (): void => {
    const timer = timers.shift()!;
    if (!timer.cancelled) timer.cb();
  };
  return { list, frames, timers, texts, nextFrame, timerFires };
}

describe('ChatList: when it draws', () => {
  it('draws new messages on the next animation frame and drops the fallback timer', () => {
    // Arrange
    const c = chatList();
    c.list.append([msg(1, 'oi'), msg(2, 'tudo bem?')]);

    // Act
    c.nextFrame();

    // Assert
    expect(c.texts()).toEqual(['oi', 'tudo bem?']);
    expect(c.timers).toEqual([expect.objectContaining({ ms: FRAME_FALLBACK_MS, cancelled: true })]);
    expect(c.list.stats.late).toBe(0);
  });

  it('draws them from the timer when no animation frame comes, and once only when the frame comes after all', () => {
    // Arrange
    const c = chatList();
    c.list.append([msg(1, 'alguém aí?')]);

    // Act
    c.timerFires();

    // Assert
    expect(c.texts()).toEqual(['alguém aí?']);
    expect(c.list.stats.late).toBe(1);

    // Act
    c.nextFrame();

    // Assert
    expect(c.texts()).toEqual(['alguém aí?']);
  });

  it('asks for one frame at a time, however many messages arrive before it', () => {
    // Arrange
    const c = chatList();

    // Act
    c.list.append([msg(1, 'um')]);
    c.list.append([msg(2, 'dois')]);
    c.list.append([msg(3, 'três')]);

    // Assert
    expect(c.frames).toHaveLength(1);
    expect(c.timers).toHaveLength(1);

    // Act
    c.nextFrame();
    c.list.append([msg(4, 'quatro')]);

    // Assert
    expect(c.texts()).toEqual(['um', 'dois', 'três']);
    expect(c.frames).toHaveLength(1);
  });

  it('neither asks for frames nor sets timers while the chat cannot be seen', () => {
    // Arrange
    let shown = false;
    const c = chatList({ visible: () => shown });

    // Act
    c.list.append([msg(1, 'oi')]);

    // Assert
    expect(c.frames).toEqual([]);
    expect(c.timers).toEqual([]);

    // Act
    shown = true;
    c.list.resume();
    c.timerFires();

    // Assert
    expect(c.texts()).toEqual(['oi']);
  });
});
