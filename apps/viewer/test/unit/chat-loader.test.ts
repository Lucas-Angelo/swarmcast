// @vitest-environment happy-dom
// The chat router in the watch page's main bundle (chat/loader.ts): it routes `chat.*` frames and
// loads the chat chunk only when the live has the chat on. Each test gives it a fake chunk of its
// own (createChatRouter's loadMountChat), which records what the router hands the mounted chat.
import { describe, expect, it, vi } from 'vitest';
import type { ChatSnapshot } from '@swarmcast/shared/chat';
import { createChatRouter, type MountChat } from '../../src/chat/loader.js';

const SNAPSHOT = { v: 1 } as ChatSnapshot;

/**
 * A router over a fake chat chunk. `calls` lists what reached the mounted chat, in order;
 * `mounted` resolves once the chunk is mounted and what came meanwhile was replayed; `failed`
 * resolves with the router's debug line when the chunk fails to load (`fail: 'load'`) or to start
 * (`fail: 'mount'`, an old browser).
 */
function router(o: { fail?: 'load' | 'mount' } = {}) {
  document.body.replaceChildren();
  const root = document.createElement('aside');
  root.hidden = true;
  const showButton = document.createElement('button');
  const calls: string[] = [];
  let onMounted: () => void = () => {};
  const mounted = new Promise<void>((resolve) => (onMounted = resolve));
  let onFailed: (line: string) => void = () => {};
  const failed = new Promise<string>((resolve) => (onFailed = resolve));
  const mountChat = (() => {
    if (o.fail === 'mount') throw new Error('old browser');
    // Whoever awaits `mounted` resumes after the router's own callback (mount, then replay) ends.
    onMounted();
    return {
      hello: (s: unknown) => calls.push(`hello ${s ? 'snapshot' : 'none'}`),
      frame: (m: { t: string }) => calls.push(`frame ${m.t}`),
      connection: (open: boolean) => calls.push(`conn ${open}`),
      lastSeq: () => 0,
    };
  }) as unknown as MountChat;
  const loadChunk = vi.fn(() => (o.fail === 'load' ? Promise.reject(new Error('offline')) : Promise.resolve(mountChat)));
  const r = createChatRouter({ root, showButton, nickname: () => 'Bia', send: () => true, loadMountChat: loadChunk, debug: (line) => onFailed(line) });
  return { r, root, showButton, calls, loadChunk, mounted, failed };
}

describe('chat router in the main bundle', () => {
  it('takes only chat.* frames; the others go on to the page', () => {
    // Arrange
    const { r } = router();

    // Act
    const taken = [r.frame({ t: 'viewers' }), r.frame({ t: 'chat.batch' })];

    // Assert
    expect(taken).toEqual([false, true]);
  });

  it('chat off at hello: the chunk is not loaded and chat frames are dropped', () => {
    // Arrange
    const { r, loadChunk } = router();

    // Act
    r.hello(undefined);
    r.frame({ t: 'chat.batch' });

    // Assert
    expect(loadChunk).not.toHaveBeenCalled();
  });

  it('loads the chunk on a hello with a snapshot and replays what came meanwhile, in order', async () => {
    // Arrange
    const { r, calls, loadChunk, mounted } = router();

    // Act
    r.connection(true);
    r.hello(SNAPSHOT);
    r.frame({ t: 'chat.batch' });
    r.frame({ t: 'chat.ack' });
    await mounted;

    // Assert
    expect(loadChunk).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['conn true', 'hello snapshot', 'frame chat.batch', 'frame chat.ack']);
  });

  it('once mounted, frames go straight to the chat', async () => {
    // Arrange
    const { r, calls, mounted } = router();
    r.hello(SNAPSHOT);
    await mounted;

    // Act
    r.frame({ t: 'chat.you' });

    // Assert
    expect(calls.at(-1)).toBe('frame chat.you');
  });

  it('turned on later (chat.settings enabled): loads then, and the chat gets that frame', async () => {
    // Arrange
    const { r, calls, mounted } = router();
    r.hello(undefined);

    // Act
    r.frame({ t: 'chat.settings', settings: { enabled: true } } as { t: string });
    await mounted;

    // Assert
    expect(calls).toContain('frame chat.settings');
  });

  it.each(['load', 'mount'] as const)('a chunk that fails to %s leaves the chat hidden and the page alone', async (fail) => {
    // Arrange
    const { r, root, showButton, failed } = router({ fail });

    // Act
    r.hello(SNAPSHOT);
    const line = await failed;

    // Assert
    expect(line).toMatch(/^chat chunk failed: Error: (offline|old browser)$/);
    expect(root.hidden).toBe(true);
    expect(showButton.hidden).toBe(true);
    expect(() => r.frame({ t: 'chat.batch' })).not.toThrow();
  });
});
