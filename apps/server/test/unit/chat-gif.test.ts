import { afterEach, describe, expect, it, vi } from 'vitest';
import { GIF_PROVIDERS, gifRatingParam } from '@swarmcast/shared/chat';
import { defaultConfig } from '../../src/core/config.js';
import type { LiveController } from '../../src/core/live.js';
import type { DirectMode } from '../../src/direct/direct.js';
import { viewerCsp } from '../../src/public/security.js';
import { makeController } from './live-helpers.js';

const lives: LiveController[] = [];
afterEach(async () => {
  for (const l of lives.splice(0)) await l.stop().catch(() => {});
});

describe('chat GIFs: the viewer CSP', () => {
  it('is unchanged while GIFs are off, and lists exactly the provider hosts while on', () => {
    const off = viewerCsp('abc.trycloudflare.com', true, []);
    expect(off).not.toMatch(/klipy|giphy/);
    const on = viewerCsp('abc.trycloudflare.com', true, [], 'klipy');
    expect(on).toContain("img-src 'self' data: https://static.klipy.com https://static1.klipy.com https://static2.klipy.com;");
    expect(on).toContain("connect-src 'self' wss://abc.trycloudflare.com https://api.klipy.com;");
    // Everything else stays byte-identical.
    expect(on.replace(/ https:\/\/[a-z0-9.]+klipy\.com/g, '')).toBe(off);
    expect(viewerCsp('x', true, [], 'giphy')).toContain(GIF_PROVIDERS.giphy.api);
  });

  it('follows the streamer setting on the real server (key required, protection pauses GIFs)', async () => {
    const config = defaultConfig();
    config.ports = { rtmp: 0, public: 0, admin: 0, mediamtxHls: 0 };
    const { live } = makeController({ noteViewer: vi.fn(), snapshot: () => ({ active: false, viewersSeen: 0 }), active: false } as unknown as DirectMode, { config });
    lives.push(live);
    await live.start();
    const csp = async () => (await fetch(`http://127.0.0.1:${live.publicPort}/healthz`)).headers.get('content-security-policy') ?? '';
    expect(await csp()).not.toContain('klipy');
    live.updateChatSettings({ ...live.chatSettings(), content: { text: true, emotes: true, gifs: true }, gif: { provider: 'klipy', key: 'Abcdefgh_123', rating: 'pg', consent: 'ask' } });
    expect(await csp()).toContain('https://api.klipy.com');
    expect(live.chat.effective.public.gif).toEqual({ provider: 'klipy', key: 'Abcdefgh_123', rating: 'pg', consent: 'ask' });
    live.chat.setProtect('slow');
    expect(await csp()).not.toContain('klipy');
    live.chat.setProtect('off');
    expect(await csp()).toContain('klipy');
    expect(() => live.updateChatSettings({ ...live.chatSettings(), gif: { ...live.chatSettings().gif, key: '' } })).toThrow();
  });

  it('maps the rating to each provider\'s filter', () => {
    expect(gifRatingParam('klipy', 'pg')).toEqual({ name: 'content_filter', value: 'medium' });
    expect(gifRatingParam('giphy', 'pg-13')).toEqual({ name: 'rating', value: 'pg-13' });
  });
});
