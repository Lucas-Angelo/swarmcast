// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSnapshot } from '@swarmcast/shared/chat';

const calls: string[] = [];
let failMount = false;
vi.mock('../../src/chat/chat.js', () => ({
  mountChat: () => {
    if (failMount) throw new Error('old browser');
    return {
      hello: (s: unknown) => calls.push(`hello ${s ? 'snapshot' : 'none'}`),
      frame: (m: { t: string }) => calls.push(`frame ${m.t}`),
      connection: (o: boolean) => calls.push(`conn ${o}`),
    };
  },
}));

const { createChatRouter } = await import('../../src/chat/loader.js');

const snapshot = { v: 1 } as ChatSnapshot;
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function router() {
  document.body.replaceChildren();
  const root = document.createElement('aside');
  root.hidden = true;
  const showButton = document.createElement('button');
  return { r: createChatRouter({ root, showButton, nickname: () => 'Bia', send: () => true }), root, showButton };
}

describe('chat router in the main bundle', () => {
  beforeEach(() => {
    calls.length = 0;
    failMount = false;
  });

  it('only chat.* frames are taken; non-chat frames go on to the page', () => {
    const { r } = router();
    expect(r.frame({ t: 'viewers' })).toBe(false);
    expect(r.frame({ t: 'chat.batch' })).toBe(true);
  });

  it('chat off at hello: the chunk is not loaded and chat frames are dropped', async () => {
    const { r } = router();
    r.hello(undefined);
    r.frame({ t: 'chat.batch' });
    await tick();
    expect(calls).toEqual([]);
  });

  it('loads the chunk on a hello with a snapshot and replays what came meanwhile, in order', async () => {
    const { r } = router();
    r.connection(true);
    r.hello(snapshot);
    r.frame({ t: 'chat.batch' });
    r.frame({ t: 'chat.ack' });
    await tick();
    expect(calls).toEqual(['conn true', 'hello snapshot', 'frame chat.batch', 'frame chat.ack']);
    r.frame({ t: 'chat.you' });
    expect(calls.at(-1)).toBe('frame chat.you');
  });

  it('turned on later (chat.settings enabled): loads then', async () => {
    const { r } = router();
    r.hello(undefined);
    r.frame({ t: 'chat.settings', settings: { enabled: true } } as { t: string });
    await tick();
    expect(calls).toContain('frame chat.settings');
  });

  it('a chunk that fails to start leaves the chat hidden and the page alone', async () => {
    failMount = true;
    const { r, root, showButton } = router();
    r.hello(snapshot);
    await tick();
    expect(root.hidden).toBe(true);
    expect(showButton.hidden).toBe(true);
    expect(() => r.frame({ t: 'chat.batch' })).not.toThrow();
  });
});
