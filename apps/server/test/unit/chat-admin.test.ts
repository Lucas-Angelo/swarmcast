import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { AdminChatState, ChatSettings } from '@swarmcast/shared';
import type { AppConfig } from '../../src/core/config.js';
import { BandwidthLimiter } from '../../src/hls/throttle.js';
import { chatReserveMbps } from '../../src/quality/upload-controller.js';
import { SecurityShield } from '../../src/security/shield.js';
import { ActivityLog } from '../../src/core/activity.js';
import { manualClock, silentLog } from './helpers.js';
import { joinViewer } from './helpers-b.js';
import { makeController, panelServer } from './live-helpers.js';

// The chat in the panel (docs/CHAT.md): the panel API, the shield's reaction to a chat flood, and
// the upload the video limiter keeps for the chat.

/** The panel of a fresh live whose chat is open, and the config.json writes it makes. */
async function chatPanel() {
  const saved: AppConfig[] = [];
  const { live } = makeController(undefined, { saveConfig: (c) => void saved.push(structuredClone(c)) });
  live.access.begin();
  live.chat.begin();
  onTestFinished(() => live.chat.reset());
  const { app, headers } = await panelServer({ live });
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, h: Record<string, string> = { host: headers.host, origin: headers.origin, cookie: headers.cookie }) =>
    app.inject({ method, url, headers: { ...h, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
  return { live, saved, headers, call };
}

/** A GIF the shared schema accepts (klipy media path). */
const GIF = { p: 'klipy', id: 'x1', w: 20, h: 20, m: '/ii/935d7ab9d8c6202580a668421940ec81/14/af/SE72470w.webp' };

describe('chat admin API', () => {
  it('refuses requests without the panel cookie, from another origin, without an origin, or for another host', async () => {
    // Arrange
    const { headers, call } = await chatPanel();
    // Act
    const noCookie = await call('GET', '/api/chat', undefined, { host: headers.host });
    const foreignOrigin = await call('POST', '/api/chat/clear', {}, { host: headers.host, origin: 'http://evil.example', cookie: headers.cookie });
    const noOrigin = await call('POST', '/api/chat/clear', {}, { host: headers.host, cookie: headers.cookie });
    const foreignHost = await call('POST', '/api/chat/send', { text: 'x' }, { host: 'evil.example', origin: headers.origin, cookie: headers.cookie });
    // Assert
    expect(noCookie.statusCode).toBe(401);
    expect(foreignOrigin.statusCode).toBe(403);
    expect(noOrigin.statusCode).toBe(403);
    expect(foreignHost.statusCode).toBe(421);
  });

  it('the streamer sends a message: it gets seq 1', async () => {
    // Arrange
    const { call } = await chatPanel();
    // Act
    const r = await call('POST', '/api/chat/send', { text: 'Bem-vindos!' });
    // Assert
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, s: 1 });
  });

  it('an empty message (invisible characters only) or text with a GIF is refused', async () => {
    // Arrange
    const { call } = await chatPanel();
    // Act
    const empty = await call('POST', '/api/chat/send', { text: '\u{200B}' });
    const withGif = await call('POST', '/api/chat/send', { text: 'a', gif: GIF });
    // Assert
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({ code: 'text.empty' });
    expect(withGif.statusCode).toBe(400);
  });

  it('delete removes messages (at most 100 at once), clear leaves only system items', async () => {
    // Arrange
    const { call } = await chatPanel();
    await call('POST', '/api/chat/send', { text: 'Bem-vindos!' });
    // Act
    const deleted = await call('POST', '/api/chat/delete', { seqs: [1] });
    const tooMany = await call('POST', '/api/chat/delete', { seqs: Array.from({ length: 101 }, (_, i) => i + 1) });
    const cleared = await call('POST', '/api/chat/clear', {});
    // Assert
    expect(deleted.json()).toEqual({ ok: true, removed: 1 });
    expect(tooMany.statusCode).toBe(400);
    expect(cleared.statusCode).toBe(200);
    const state = (await call('GET', '/api/chat')).json() as AdminChatState;
    expect(state.items.every((i) => i.k === 'sys')).toBe(true);
  });

  it('protection goes to lockdown and back off; the state shows the counters', async () => {
    // Arrange
    const { call } = await chatPanel();
    // Act
    const lockdown = await call('POST', '/api/chat/protect', { mode: 'lockdown' });
    const off = await call('POST', '/api/chat/protect', { mode: 'off' });
    // Assert
    expect(lockdown.json()).toEqual({ ok: true, protect: 'lockdown' });
    expect(off.json()).toEqual({ ok: true, protect: 'off' });
    const state = (await call('GET', '/api/chat')).json() as AdminChatState;
    expect(state.settings.enabled).toBe(true);
    expect(state.counters).toMatchObject({ guard: 'ok', protect: 'off', broken: false, budgetKbps: 960 });
  });

  it('mute, unmute and colour act on a live session', async () => {
    // Arrange
    const { live, call } = await chatPanel();
    const s = joinViewer(live.access, 'Ana');
    // Act
    const muted = await call('POST', '/api/chat/mute', { sessionId: s.id, minutes: null });
    // Assert
    expect(muted.json()).toEqual({ ok: true });
    expect(live.chat.moderation.mutedUntil(s)).toBe('live');
    expect(live.activity.list().some((e) => e.code === 'log.chat.mutedLive' && e.params?.nickname === 'Ana')).toBe(true);
    // Act
    const tooLong = await call('POST', '/api/chat/mute', { sessionId: s.id, minutes: 1441 });
    const unmuted = await call('POST', '/api/chat/unmute', { sessionId: s.id });
    const coloured = await call('PUT', '/api/chat/color', { sessionId: s.id, color: '#12A594', lock: true });
    // Assert
    expect(tooLong.statusCode).toBe(400);
    expect(unmuted.json()).toEqual({ ok: true });
    expect(coloured.json()).toEqual({ ok: true });
    expect(live.chat.you(s)).toMatchObject({ color: '#12a594', colorLocked: true });
  });

  it('an unknown session is refused with a code', async () => {
    // Arrange
    const { call } = await chatPanel();
    // Act
    const r = await call('POST', '/api/chat/mute', { sessionId: 'nope', minutes: 10 });
    // Assert
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: 'admin.chat.err.noSession' });
  });

  it('settings: validated, saved to config.json and applied', async () => {
    // Arrange
    const { live, saved, call } = await chatPanel();
    // Act
    const ok = await call('PUT', '/api/chat/settings', { ...live.chatSettings(), slowModeS: 5, streamerName: '  Lucas  ', blockedWords: ['idiota'] });
    // Assert
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ settings: { slowModeS: 5, streamerName: 'Lucas' }, effective: { slowS: 5 } });
    expect(saved.at(-1)?.chat).toMatchObject({ slowModeS: 5, streamerName: 'Lucas' });
  });

  it.each<[string, (cur: ChatSettings) => ChatSettings, string]>([
    ['a streamer name with a bidi override', (cur) => ({ ...cur, streamerName: 'Lu\u{202E}cas' }), 'admin.chat.err.streamerName'],
    ['a blocked word over 40 characters', (cur) => ({ ...cur, blockedWords: ['x'.repeat(41)] }), 'admin.chat.err.blockedWord'],
    ['GIFs without the streamer key', (cur) => ({ ...cur, content: { text: true, emotes: true, gifs: true }, gif: { ...cur.gif, key: '' } }), 'admin.chat.err.gifKey'],
  ])('settings: %s is refused with its code', async (_what, edit, code) => {
    // Arrange
    const { live, call } = await chatPanel();
    // Act
    const r = await call('PUT', '/api/chat/settings', edit(live.chatSettings()));
    // Assert
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code });
  });

  it.each([
    ['nothing allowed', { content: { text: false, emotes: false, gifs: false } }],
    ['a slow mode of 9999 s', { slowModeS: 9999 }],
  ])('settings: %s fails the schema', async (_what, change) => {
    // Arrange
    const { live, call } = await chatPanel();
    // Act
    const r = await call('PUT', '/api/chat/settings', { ...live.chatSettings(), ...change });
    // Assert
    expect(r.statusCode).toBe(400);
  });

  it('the panel snapshot never carries chat (it has its own /ws message)', async () => {
    // Arrange
    const { live } = await chatPanel();
    // Act
    for (let i = 0; i < 4; i++) live.chat.system('chat.sys.protect');
    // Assert
    expect(JSON.stringify(live.snapshot())).not.toContain('chat.sys.protect');
  });
});

describe('shield: a chat flood alone is capped at suspicious', () => {
  const base = () => ({ blockKnownBadIps: false, requireBrowserCheck: false, autoTighten: true, autoBrowserCheck: true, autoNewLink: true, autoSecureFromDirect: true, autoStopIfDirectFails: true, stopOnAttack: true });

  /** A shield on a manual clock; `tick(n)` lets n seconds pass, sampling once a second like start() does. */
  function shield(mode: 'secure' | 'direct', settings: Partial<ReturnType<typeof base>> = {}) {
    const clock = manualClock();
    const actions = { mode: () => mode, rotateLink: vi.fn(), backToSecure: vi.fn(async () => {}), stopAll: vi.fn(async () => true), report: vi.fn() };
    const sh = new SecurityShield({
      settings: () => ({ ...base(), ...settings }),
      limits: () => ({ maxViewers: 100, maxSessionsPerDevice: 3 }),
      activity: new ActivityLog(),
      log: silentLog,
      sample: () => ({ viewers: 50, sessions: 50, saturation: 0 }),
      actions,
      changed: () => {},
      now: clock.now,
    });
    const tick = (n = 1) => {
      for (let i = 0; i < n; i++) {
        clock.advance(1000);
        sh.tick();
      }
    };
    return { sh, actions, tick };
  }

  it.each(['secure', 'direct'] as const)('%s mode: only the light browser check, never a new link, tighter admission, leaving Direct mode or Stop', (mode) => {
    // Arrange
    const { sh, actions, tick } = shield(mode);
    // Act
    sh.chatSignal(2);
    tick(10);
    // Assert
    expect(sh.snapshot()).toMatchObject({ threat: 'suspicious', reasonCode: 'attack.reason.chat', browserCheck: 1, tightened: false });
    expect(sh.warning()).toMatchObject({ code: 'warn.attackSuspicious', params: { reasonKey: 'attack.reason.chat' } });
    expect(actions.rotateLink).not.toHaveBeenCalled();
    expect(actions.backToSecure).not.toHaveBeenCalled();
    expect(actions.stopAll).not.toHaveBeenCalled();
    expect(sh.effectiveLimits().maxSessionsPerDevice).toBe(3);
    // Act
    sh.chatSignal(0);
    tick();
    // Assert
    expect(sh.snapshot()).toMatchObject({ threat: 'normal', browserCheck: 0 });
  });

  it('the browser check stays off when the streamer turned automatic checks off', () => {
    // Arrange
    const { sh, tick } = shield('secure', { autoBrowserCheck: false });
    // Act
    sh.chatSignal(1);
    tick(5);
    // Assert
    expect(sh.snapshot()).toMatchObject({ threat: 'suspicious', browserCheck: 0 });
  });
});

describe('upload: the video limiter leaves room for the chat', () => {
  it.each([
    [400_000, 100_000, 0.12],
    [400_000, 1_000_000, 0.4],
  ])('reserve = min(B_chat, 1.2 × chat upload): budget %d B/s, chat %d B/s → %d Mbps', (budget, egress, mbps) => {
    // Act
    const reserve = chatReserveMbps(budget, egress);
    // Assert
    expect(reserve).toBeCloseTo(mbps);
  });

  it.each([
    ['an unknown chat upload', 400_000, Number.NaN],
    ['a negative budget', -1, 5],
  ])('no reserve for %s', (_what, budget, egress) => {
    // Act
    const reserve = chatReserveMbps(budget, egress);
    // Assert
    expect(reserve).toBe(0);
  });

  it('video gets the cap minus the reserve (never below half the cap); mbps still reports the cap', () => {
    // Arrange
    const l = BandwidthLimiter.fromMbps(8);
    onTestFinished(() => l.close());
    // Act
    const before = l.videoMbps;
    l.setReserveMbps(0.768);
    // Assert
    expect(before).toBe(8);
    expect(l.mbps).toBe(8);
    expect(l.reserveMbps).toBeCloseTo(0.768);
    expect(l.videoMbps).toBeCloseTo(8 - 0.768);
    // Act
    l.setReserveMbps(100);
    // Assert
    expect(l.videoMbps).toBe(4);
    // Act
    l.setReserveMbps(0);
    // Assert
    expect(l.videoMbps).toBe(8);
  });
});
