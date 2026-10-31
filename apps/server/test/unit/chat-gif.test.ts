import { describe, expect, it } from 'vitest';
import { GIF_PROVIDERS, gifRatingParam } from '@swarmcast/shared/chat';
import { GUARD, type LoopSample } from '../../src/chat/guard.js';
import type { LiveController } from '../../src/core/live.js';
import { viewerCsp } from '../../src/public/security.js';
import { inactiveDirect, makeController, startController } from './live-helpers.js';

// Chat GIFs (docs/CHAT.md): the viewer CSP opens exactly the provider's hosts while GIFs are on,
// and only then; everything else in it stays byte-identical. Protection and the event-loop guard
// pause GIFs, so the CSP drops the provider while either is on.

const KLIPY_HOSTS = / https:\/\/[a-z0-9.]+klipy\.com/g;
/** Event-loop samples the chat's guard reads (injected: the test ticks it by hand). */
const CALM_LOOP: LoopSample = { p99Ms: 10, elu: 0.1 };
const HEAVY_LOOP: LoopSample = { p99Ms: 300, elu: 0.95 };
/** The guard's own timer period here: an hour, so only the test's tick() calls sample it. */
const GUARD_NEVER_TICKS_MS = 3_600_000;

/** The CSP the live's real public server sends right now. */
async function csp(live: LiveController): Promise<string> {
  return (await fetch(`http://127.0.0.1:${live.publicPort}/healthz`)).headers.get('content-security-policy') ?? '';
}

/** Turn GIFs on with a Klipy key. */
function gifsOn(live: LiveController): void {
  live.updateChatSettings({ ...live.chatSettings(), content: { text: true, emotes: true, gifs: true }, gif: { provider: 'klipy', key: 'Abcdefgh_123', rating: 'pg', consent: 'ask' } });
}

describe('chat GIFs: the viewer CSP', () => {
  it('is unchanged while GIFs are off, and lists exactly the provider hosts while on', () => {
    // Act
    const off = viewerCsp('abc.trycloudflare.com', true, []);
    const on = viewerCsp('abc.trycloudflare.com', true, [], 'klipy');
    const giphy = viewerCsp('x', true, [], 'giphy');
    // Assert
    expect(off).not.toMatch(/klipy|giphy/);
    expect(on).toContain("img-src 'self' data: https://static.klipy.com https://static1.klipy.com https://static2.klipy.com;");
    expect(on).toContain("connect-src 'self' wss://abc.trycloudflare.com https://api.klipy.com;");
    expect(on.replace(KLIPY_HOSTS, '')).toBe(off);
    expect(giphy).toContain(GIF_PROVIDERS.giphy.api);
  });

  it('follows the streamer setting on the real server', async () => {
    // Arrange
    const { live } = await startController();
    const before = await csp(live);
    // Act
    gifsOn(live);
    // Assert
    expect(before).not.toContain('klipy');
    expect(await csp(live)).toContain('https://api.klipy.com');
    expect(live.chat.effective.public.gif).toEqual({ provider: 'klipy', key: 'Abcdefgh_123', rating: 'pg', consent: 'ask' });
  });

  it('protection pauses GIFs, and lifting it brings them back', async () => {
    // Arrange
    const { live } = await startController();
    gifsOn(live);
    // Act
    live.chat.setProtect('slow');
    // Assert
    expect(await csp(live)).not.toContain('klipy');
    // Act
    live.chat.setProtect('off');
    // Assert
    expect(await csp(live)).toContain('klipy');
  });

  it('the event-loop guard pauses GIFs, and its recovery brings them back', async () => {
    // Arrange
    let load: LoopSample = CALM_LOOP;
    const { live } = await startController(inactiveDirect(), { chatGuard: { sample: () => load, intervalMs: GUARD_NEVER_TICKS_MS } });
    gifsOn(live);
    live.chat.guard.tick();
    load = HEAVY_LOOP;
    // Act
    for (let i = 0; i < GUARD.pauseAfter; i++) live.chat.guard.tick();
    // Assert
    expect(live.chat.guardState).toBe('pause');
    expect(live.chat.effective.public.gif).toBeUndefined();
    expect(await csp(live)).not.toContain('klipy');
    // Act
    load = CALM_LOOP;
    for (let i = 0; i < GUARD.recoverAfter; i++) live.chat.guard.tick();
    // Assert
    expect(live.chat.guardState).toBe('ok');
    expect(await csp(live)).toContain('klipy');
  });

  it('GIFs need the streamer key', () => {
    // Arrange
    const { live } = makeController();
    gifsOn(live);
    // Act
    const withoutKey = () => live.updateChatSettings({ ...live.chatSettings(), gif: { ...live.chatSettings().gif, key: '' } });
    // Assert
    expect(withoutKey).toThrow();
  });

  it.each([
    ['klipy', 'pg', { name: 'content_filter', value: 'medium' }],
    ['giphy', 'pg-13', { name: 'rating', value: 'pg-13' }],
  ] as const)("maps the rating to the provider's filter (%s, %s)", (provider, rating, param) => {
    // Act
    const p = gifRatingParam(provider, rating);
    // Assert
    expect(p).toEqual(param);
  });
});
