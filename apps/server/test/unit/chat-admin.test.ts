import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ADMIN_COOKIE, type AdminChatState } from '@swarmcast/shared';
import { createAdminServer } from '../../src/admin/server.js';
import { defaultConfig, type AppConfig } from '../../src/core/config.js';
import type { LiveController } from '../../src/core/live.js';
import type { DirectMode } from '../../src/direct/direct.js';
import { BandwidthLimiter } from '../../src/hls/throttle.js';
import { chatReserveMbps } from '../../src/quality/upload-controller.js';
import { SecurityShield } from '../../src/security/shield.js';
import { ActivityLog } from '../../src/core/activity.js';
import { makeController } from './live-helpers.js';
import { silentLog } from './helpers.js';

const PORT = 39398;
const TOKEN = 'chat-admin-token_123';
const host = `127.0.0.1:${PORT}`;
const origin = `http://${host}`;
const cookie = `${ADMIN_COOKIE}=${TOKEN}`;

describe('chat admin API', () => {
  let app: FastifyInstance;
  let live: LiveController;
  const saved: AppConfig[] = [];
  beforeAll(async () => {
    const adminDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-admin-chat-'));
    fs.writeFileSync(path.join(adminDir, 'index.html'), '<!doctype html>');
    const config = defaultConfig();
    config.ports = { rtmp: 0, public: 0, admin: 0, mediamtxHls: 0 };
    ({ live } = makeController({ noteViewer: vi.fn(), snapshot: () => ({ active: false, viewersSeen: 0 }), active: false } as unknown as DirectMode, { config, saveConfig: (c) => void saved.push(JSON.parse(JSON.stringify(c)) as AppConfig) }));
    live.access.begin();
    live.chat.begin();
    app = await createAdminServer({ port: PORT, adminDir, live, log: silentLog, token: TOKEN, onQuit: vi.fn(), checkDirect: vi.fn(), cleanupStale: vi.fn() });
  });
  afterAll(async () => {
    live.chat.reset();
    await app.close();
  });

  const call = (method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, headers: Record<string, string> = { host, origin, cookie }) =>
    app.inject({ method, url, headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });

  it('refuses requests without the panel cookie or from another origin', async () => {
    expect((await call('GET', '/api/chat', undefined, { host })).statusCode).toBe(401);
    expect((await call('POST', '/api/chat/clear', {}, { host, origin: 'http://evil.example', cookie })).statusCode).toBe(403);
    expect((await call('POST', '/api/chat/clear', {}, { host, cookie })).statusCode).toBe(403);
    expect((await call('POST', '/api/chat/send', { text: 'x' }, { host: 'evil.example', origin, cookie })).statusCode).toBe(421);
  });

  it('streamer messages, delete, clear and protection', async () => {
    const r = await call('POST', '/api/chat/send', { text: 'Bem-vindos!' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, s: 1 });
    const bad = await call('POST', '/api/chat/send', { text: '\u{200B}' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'text.empty' });
    expect((await call('POST', '/api/chat/send', { text: 'a', gif: { p: 'klipy', id: 'x1', w: 20, h: 20 } })).statusCode).toBe(400);
    expect((await call('POST', '/api/chat/delete', { seqs: [1] })).json()).toEqual({ ok: true, removed: 1 });
    expect((await call('POST', '/api/chat/delete', { seqs: Array.from({ length: 101 }, (_, i) => i + 1) })).statusCode).toBe(400);
    expect((await call('POST', '/api/chat/clear', {})).statusCode).toBe(200);
    expect((await call('POST', '/api/chat/protect', { mode: 'lockdown' })).json()).toEqual({ ok: true, protect: 'lockdown' });
    expect((await call('POST', '/api/chat/protect', { mode: 'off' })).json()).toEqual({ ok: true, protect: 'off' });
    const state = (await call('GET', '/api/chat')).json() as AdminChatState;
    expect(state.settings.enabled).toBe(true);
    expect(state.items.every((i) => i.k === 'sys')).toBe(true);
    expect(state.counters).toMatchObject({ guard: 'ok', protect: 'off', broken: false, budgetKbps: 960 });
  });

  it('mute, unmute and colour act on a live session; unknown sessions are refused', async () => {
    const s = live.access.createSession({ nickname: 'Ana', deviceId: 'dev1', device: 'desktop', ip: '1.1.1.1' });
    expect((await call('POST', '/api/chat/mute', { sessionId: s.id, minutes: null })).json()).toEqual({ ok: true });
    expect(live.chat.moderation.mutedUntil(s)).toBe('live');
    expect((await call('POST', '/api/chat/mute', { sessionId: s.id, minutes: 1441 })).statusCode).toBe(400);
    expect((await call('POST', '/api/chat/unmute', { sessionId: s.id })).json()).toEqual({ ok: true });
    expect((await call('PUT', '/api/chat/color', { sessionId: s.id, color: '#12A594', lock: true })).json()).toEqual({ ok: true });
    expect(live.chat.you(s)).toMatchObject({ color: '#12a594', colorLocked: true });
    const r = await call('POST', '/api/chat/mute', { sessionId: 'nope', minutes: 10 });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: 'admin.chat.err.noSession' });
    expect(live.activity.list().some((e) => e.code === 'log.chat.mutedLive' && e.params?.nickname === 'Ana')).toBe(true);
  });

  it('settings: validated, saved to config.json, applied; bad names, words and GIFs without a key refused', async () => {
    const cur = live.chatSettings();
    const ok = await call('PUT', '/api/chat/settings', { ...cur, slowModeS: 5, streamerName: '  Lucas  ', blockedWords: ['idiota'] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ settings: { slowModeS: 5, streamerName: 'Lucas' }, effective: { slowS: 5 } });
    expect(saved.at(-1)?.chat).toMatchObject({ slowModeS: 5, streamerName: 'Lucas' });
    for (const [body, code] of [
      [{ ...cur, streamerName: 'Lu\u{202E}cas' }, 'admin.chat.err.streamerName'],
      [{ ...cur, blockedWords: ['x'.repeat(41)] }, 'admin.chat.err.blockedWord'],
      [{ ...cur, content: { text: true, emotes: true, gifs: true }, gif: { ...cur.gif, key: '' } }, 'admin.chat.err.gifKey'],
    ] as const) {
      const r = await call('PUT', '/api/chat/settings', body);
      expect(r.statusCode).toBe(400);
      expect(r.json()).toMatchObject({ code });
    }
    expect((await call('PUT', '/api/chat/settings', { ...cur, content: { text: false, emotes: false, gifs: false } })).statusCode).toBe(400);
    expect((await call('PUT', '/api/chat/settings', { ...cur, slowModeS: 9999 })).statusCode).toBe(400);
  });

  it('the panel snapshot never carries chat (it has its own /ws message)', () => {
    for (let i = 0; i < 4; i++) live.chat.system('chat.sys.protect');
    expect(JSON.stringify(live.snapshot())).not.toContain('chat.sys.protect');
  });
});

describe('shield: a chat flood alone is capped at suspicious', () => {
  function shield(mode: 'secure' | 'direct', settings: Partial<ReturnType<typeof base>> = {}) {
    let t = 1_000_000;
    const actions = { mode: () => mode, rotateLink: vi.fn(), backToSecure: vi.fn(async () => {}), stopAll: vi.fn(async () => true), report: vi.fn() };
    const sh = new SecurityShield({
      settings: () => ({ ...base(), ...settings }),
      limits: () => ({ maxViewers: 100, maxSessionsPerDevice: 3 }),
      activity: new ActivityLog(),
      log: silentLog,
      sample: () => ({ viewers: 50, sessions: 50, saturation: 0 }),
      actions,
      changed: () => {},
      now: () => t,
    });
    const tick = (n = 1) => {
      for (let i = 0; i < n; i++) {
        t += 1000;
        sh.tick();
      }
    };
    return { sh, actions, tick };
  }
  function base() {
    return { blockKnownBadIps: false, requireBrowserCheck: false, autoTighten: true, autoBrowserCheck: true, autoNewLink: true, autoSecureFromDirect: true, autoStopIfDirectFails: true, stopOnAttack: true };
  }

  for (const mode of ['secure', 'direct'] as const) {
    it(`${mode} mode: only the light browser check, never a new link, tighter admission, leaving Direct mode or Stop`, () => {
      const { sh, actions, tick } = shield(mode);
      sh.chatSignal(2);
      tick(10);
      expect(sh.snapshot()).toMatchObject({ threat: 'suspicious', reasonCode: 'attack.reason.chat', browserCheck: 1, tightened: false });
      expect(sh.warning()).toMatchObject({ code: 'warn.attackSuspicious', params: { reasonKey: 'attack.reason.chat' } });
      expect(actions.rotateLink).not.toHaveBeenCalled();
      expect(actions.backToSecure).not.toHaveBeenCalled();
      expect(actions.stopAll).not.toHaveBeenCalled();
      expect(sh.effectiveLimits().maxSessionsPerDevice).toBe(3);
      sh.chatSignal(0);
      tick();
      expect(sh.snapshot()).toMatchObject({ threat: 'normal', browserCheck: 0 });
    });
  }

  it('the browser check stays off when the streamer turned automatic checks off', () => {
    const { sh, tick } = shield('secure', { autoBrowserCheck: false });
    sh.chatSignal(1);
    tick(5);
    expect(sh.snapshot()).toMatchObject({ threat: 'suspicious', browserCheck: 0 });
  });
});

describe('upload: the video limiter leaves room for the chat', () => {
  it('reserve = min(B_chat, 1.2 × chat upload)', () => {
    expect(chatReserveMbps(400_000, 100_000)).toBeCloseTo(0.12);
    expect(chatReserveMbps(400_000, 1_000_000)).toBeCloseTo(0.4);
    expect(chatReserveMbps(400_000, Number.NaN)).toBe(0);
    expect(chatReserveMbps(-1, 5)).toBe(0);
  });

  it('video gets the cap minus the reserve (never below half the cap); mbps still reports the cap', () => {
    const l = BandwidthLimiter.fromMbps(8);
    const rate = () => ((l as unknown as { rate: number }).rate * 8) / 1_000_000;
    expect(rate()).toBe(8);
    l.setReserveMbps(0.768);
    expect(l.mbps).toBe(8);
    expect(l.reserveMbps).toBeCloseTo(0.768);
    expect(rate()).toBeCloseTo(8 - 0.768);
    l.setReserveMbps(100);
    expect(rate()).toBe(4);
    l.setReserveMbps(0);
    expect(rate()).toBe(8);
    l.close();
  });
});
