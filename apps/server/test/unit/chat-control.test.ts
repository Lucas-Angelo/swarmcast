import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { defaultChatSettings, validateNickname, type ChatSettings } from '@swarmcast/shared';
import { AccessControl } from '../../src/access/access.js';
import { ChatHub } from '../../src/chat/hub.js';
import { ControlChannel } from '../../src/control/control.js';
import { ActivityLog } from '../../src/core/activity.js';
import { silentLog } from './helpers.js';

function setup(over: Partial<ChatSettings> = {}) {
  const access = new AccessControl();
  access.begin();
  const control = new ControlChannel(access, silentLog);
  const settings = { ...defaultChatSettings(), ...over };
  const hub = new ChatHub({
    access,
    host: control,
    settings: () => settings,
    uploadCapMbps: () => 10,
    viewers: () => 2,
    activity: new ActivityLog(),
    log: silentLog,
    guard: { sample: () => ({ p99Ms: 0, elu: 0 }), intervalMs: 3_600_000 },
  });
  hub.begin();
  control.chat = hub;
  const s = access.createSession({ nickname: 'Ana', deviceId: 'dev', device: 'desktop', ip: '198.51.100.7' });
  s.joinedAt = Date.now() - 600_000;
  const sock = {
    sessionId: s.id,
    msgs: { n: 0, at: Date.now() },
    frames: { n: 0, at: Date.now() },
    chatFrames: { n: 0, at: Date.now() },
    opens: { n: 0, at: Date.now() },
    channels: new Map(),
    readyState: 1,
    OPEN: 1,
    bufferedAmount: 0,
    sent: [] as string[],
    send(d: string) {
      this.sent.push(d);
    },
    terminate: vi.fn(),
    close: vi.fn(),
  };
  const onMessage = (control as unknown as { onMessage(s: unknown, t: Buffer | string, b: boolean): void }).onMessage.bind(control);
  const close = () => {
    hub.reset();
    control.close();
  };
  return { access, control, hub, s, sock, onMessage, settings, close };
}

describe('chat on /control', () => {
  it('chat frames have their own budget: 20 per 10 s never cost the control budget, 21 terminate', () => {
    const { sock, onMessage, close } = setup({ slowModeS: 0 });
    for (let i = 1; i <= 20; i++) onMessage(sock, `{"t":"chat.send","n":${i},"text":"m${i}"}`, false);
    // The control budget (30 per 10 s) is untouched: 29 pongs still pass.
    for (let i = 0; i < 29; i++) onMessage(sock, '{"t":"pong"}', false);
    expect(sock.terminate).not.toHaveBeenCalled();
    onMessage(sock, '{"t":"chat.send","n":21,"text":"x"}', false);
    expect(sock.terminate).toHaveBeenCalledTimes(1);
    close();
  });

  it('a raw frame over 2 KB is refused before it is decoded, without closing the socket', () => {
    const { sock, onMessage, close } = setup();
    const big = Buffer.from(`{"t":"chat.send","n":1,"text":"${'a'.repeat(3000)}"}`);
    const toString = vi.spyOn(big, 'toString');
    onMessage(sock, big, false);
    expect(toString).not.toHaveBeenCalled();
    expect(JSON.parse(sock.sent.at(-1)!)).toMatchObject({ t: 'chat.reject', code: 'text.tooLong' });
    expect(sock.terminate).not.toHaveBeenCalled();
    expect(sock.close).not.toHaveBeenCalled();
    close();
  });

  it('binary frames still terminate; frames of an ended session close it', () => {
    const { sock, onMessage, access, s, close } = setup();
    access.sessions.delete(s.id);
    onMessage(sock, '{"t":"chat.send","n":1,"text":"hi"}', false);
    expect(sock.close).toHaveBeenCalledWith(4001, 'session ended');
    onMessage(sock, Buffer.from([1, 2, 3]), true);
    expect(sock.terminate).toHaveBeenCalled();
    close();
  });

  it('fuzz: random and hostile frames never throw, terminate only for the documented reasons, and caps hold', () => {
    const { sock, onMessage, hub, close } = setup({ slowModeS: 0, duplicateWindowS: 0 });
    const frame = fc.oneof(
      fc.string({ maxLength: 300 }),
      fc.string({ unit: 'binary', maxLength: 300 }).map((x) => `{"t":"chat.send","n":1,"text":${JSON.stringify(x)}}`),
      fc.json().map((j) => `{"t":"chat.${['send', 'color', 'resume', 'x'][j.length % 4]}",${j.startsWith('{') ? j.slice(1) : `"v":${j}}`}`),
      fc.constantFrom('{"t":"chat.send","n":1,"text":{"__proto__":{"x":1}}}', '{"t":"chat.send","constructor":{"prototype":{}}}', '{"t":"chat.color","color":"#zzzzzz"}', '{"t":"chat.resume","after":1e308}', '{"t":"chat.send"', '~o1', '~d1 x'),
      fc.uint8Array({ maxLength: 64 }).map((u) => Buffer.from(u)),
    );
    fc.assert(
      fc.property(fc.array(frame, { maxLength: 30 }), (frames) => {
        sock.chatFrames = { n: 0, at: Date.now() };
        sock.frames = { n: 0, at: Date.now() };
        sock.msgs = { n: 0, at: Date.now() };
        sock.opens = { n: 0, at: Date.now() };
        sock.terminate.mockClear();
        let chat = 0;
        for (const f of frames) {
          const isChat = (typeof f === 'string' ? f : f.toString('latin1')).startsWith('{"t":"chat.');
          if (isChat) chat++;
          expect(() => onMessage(sock, f, false)).not.toThrow();
        }
        if (chat <= 20 && frames.length <= 30) {
          // Non-chat garbage may hit the 30-per-10 s control budget; chat alone never terminates below 21.
          const controlFrames = frames.length - chat;
          if (controlFrames <= 30) expect(sock.terminate).not.toHaveBeenCalled();
        }
        expect(hub.ringSize.items).toBeLessThanOrEqual(200);
        expect(hub.isBroken).toBe(false);
        return true;
      }),
      { numRuns: 300, seed: 42 },
    );
    close();
  });

  it('the hello snapshot is there while the chat is on, and absent while it is off', () => {
    const { s, hub, settings, close } = setup();
    expect(hub.snapshot(s)).toMatchObject({ v: 1, lastSeq: 0, you: { mutedUntil: null } });
    settings.enabled = false;
    hub.refresh();
    expect(hub.snapshot(s)).toBeUndefined();
    close();
  });
});

describe('nickname uniqueness and reserved names', () => {
  it('refuses look-alikes of someone watching (case, Cyrillic, I/l) with a suggestion; the same device may rejoin', () => {
    const a = new AccessControl();
    a.begin();
    const ana = a.createSession({ nickname: 'ana', deviceId: 'd1', device: 'desktop', ip: 'x' });
    ana.connections = 1;
    a.createSession({ nickname: 'lucas', deviceId: 'd2', device: 'desktop', ip: 'x' }).connections = 1;
    expect(a.nicknameProblem('Ana', 'd9')).toBe('taken');
    expect(a.nicknameProblem('\u{430}na', 'd9')).toBe('taken');
    expect(a.nicknameProblem('Iucas', 'd9')).toBe('taken');
    expect(a.nicknameProblem('ana_', 'd9')).toBe('taken');
    expect(a.nicknameProblem('Ana', 'd1')).toBeNull();
    expect(a.nicknameProblem('Bia', 'd9')).toBeNull();
    const suggestion = a.suggestNickname('Ana', 'd9');
    expect(suggestion).toBe('Ana2');
    expect(validateNickname(suggestion).ok).toBe(true);
    expect(a.suggestNickname('a'.repeat(24), 'd9')).toHaveLength(24);
  });

  it('a session gone for 30 s frees its name', () => {
    let t = 1_000_000;
    const a = new AccessControl(() => t);
    a.begin();
    a.createSession({ nickname: 'ana', deviceId: 'd1', device: 'desktop', ip: 'x' });
    expect(a.nicknameProblem('Ana', 'd2')).toBe('taken');
    t += 31_000;
    expect(a.nicknameProblem('Ana', 'd2')).toBeNull();
  });

  it('reserved names and the streamer chat name, also as look-alikes', () => {
    const a = new AccessControl();
    a.begin();
    for (const n of ['Streamer', 'STREAMER', 'Moderador', 'Swarm Cast', 'admin']) expect(a.nicknameProblem(n, 'd'), n).toBe('reserved');
    expect(a.nicknameProblem('Lucas Live', 'd', ['lucas-live'])).toBe('reserved');
    expect(a.nicknameProblem('Lucas', 'd', [''])).toBeNull();
  });
});
