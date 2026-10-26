import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@swarmcast/shared';
import { defaultConfig } from '../../src/core/config.js';
import { LiveController } from '../../src/core/live.js';
import type { DirectMode } from '../../src/direct/direct.js';
import type { ManifestSigner } from '../../src/hls/manifest.js';
import type { MediaMtx } from '../../src/media/mediamtx.js';
import { NoTunnel } from '../../src/tunnel/provider.js';
import { silentLog } from './helpers.js';

function makeLive(): LiveController {
  const direct = { noteViewer: vi.fn(), snapshot: () => ({ active: false, viewersSeen: 0 }), active: false, ipChanged: null } as unknown as DirectMode;
  const mediamtx = Object.assign(new EventEmitter(), { onPublish: () => {}, pid: undefined }) as unknown as MediaMtx;
  return new LiveController({
    config: defaultConfig(),
    saveConfig: () => {},
    streamKey: 'sc_testtesttesttest',
    signer: {} as ManifestSigner,
    mediamtx,
    tunnel: new NoTunnel(),
    direct,
    viewerDir: '/nonexistent',
    log: silentLog,
    version: 'test',
    secureCookies: false,
  });
}

describe('"remove from P2P"', () => {
  it('marks the session watch-only, closes its tracker sockets and tells everyone to drop its peers', () => {
    const live = makeLive();
    live.access.begin();
    const sent: Array<[string, ServerMessage]> = [];
    const broadcast: ServerMessage[] = [];
    vi.spyOn(live.control, 'send').mockImplementation((id, m) => void sent.push([id, m]));
    vi.spyOn(live.control, 'broadcast').mockImplementation((m) => void broadcast.push(m));
    const disc = vi.spyOn(live.tracker, 'disconnectSession');
    const s = live.access.createSession({ nickname: 'x', deviceId: 'd', device: 'desktop', ip: 'ip' });
    s.peerIds.add('aa'.repeat(20));

    expect(live.setP2P(s.id, false)).toBe(true);
    expect(s.p2pAllowed).toBe(false);
    expect(disc).toHaveBeenCalledWith(s.id);
    expect(sent).toContainEqual([s.id, { t: 'p2p', allowed: false }]);
    expect(broadcast).toContainEqual({ t: 'block-peers', peerIds: ['aa'.repeat(20)] });
    expect(live.control.blockedPeers.has('aa'.repeat(20))).toBe(true);
    // The session itself keeps watching.
    expect(live.access.sessions.has(s.id)).toBe(true);

    live.setP2P(s.id, true);
    expect(broadcast).toContainEqual({ t: 'unblock-peers', peerIds: ['aa'.repeat(20)] });
    expect(live.control.blockedPeers.size).toBe(0);
  });

  it('kick also blocks the peers of the kicked session', () => {
    const live = makeLive();
    live.access.begin();
    const broadcast: ServerMessage[] = [];
    vi.spyOn(live.control, 'broadcast').mockImplementation((m) => void broadcast.push(m));
    const kick = vi.spyOn(live.control, 'kick');
    const s = live.access.createSession({ nickname: 'x', deviceId: 'd', device: 'desktop', ip: 'ip' });
    s.peerIds.add('bb'.repeat(20));
    live.kick(s.id);
    expect(kick).toHaveBeenCalledWith(s.id);
    expect(broadcast).toContainEqual({ t: 'block-peers', peerIds: ['bb'.repeat(20)] });
  });

  it('repeated hash failures remove the accused session from P2P automatically', () => {
    const live = makeLive();
    live.access.begin();
    const reporter = live.access.createSession({ nickname: 'honest', deviceId: 'd1', device: 'desktop', ip: 'ip1' });
    const bad = live.access.createSession({ nickname: 'evil', deviceId: 'd2', device: 'desktop', ip: 'ip2' });
    bad.peerIds.add('cc'.repeat(20));
    const sock = { sessionId: reporter.id, msgs: { n: 0, at: Date.now() }, frames: { n: 0, at: Date.now() }, terminate: vi.fn(), close: vi.fn() };
    const onMessage = (live.control as unknown as { onMessage(s: unknown, t: string, b: boolean): void }).onMessage.bind(live.control);
    for (let i = 0; i < 3; i++) onMessage(sock, JSON.stringify({ t: 'hash-fail', peerId: 'cc'.repeat(20), segment: 'p2p' }), false);
    expect(bad.hashFailures).toBe(3);
    expect(bad.p2pAllowed).toBe(false);
    expect(bad.autoRemovedFromP2P).toBe(true);
    expect(live.snapshot().warnings.join(' ')).toMatch(/removed from P2P automatically/);
  });

  it('a viewer cannot report itself, and junk messages are ignored', () => {
    const live = makeLive();
    live.access.begin();
    const s = live.access.createSession({ nickname: 'a', deviceId: 'd', device: 'desktop', ip: 'ip' });
    s.peerIds.add('dd'.repeat(20));
    const sock = { sessionId: s.id, msgs: { n: 0, at: Date.now() }, frames: { n: 0, at: Date.now() }, terminate: vi.fn(), close: vi.fn() };
    const onMessage = (live.control as unknown as { onMessage(s: unknown, t: string, b: boolean): void }).onMessage.bind(live.control);
    for (let i = 0; i < 5; i++) onMessage(sock, JSON.stringify({ t: 'hash-fail', peerId: 'dd'.repeat(20), segment: 'x' }), false);
    onMessage(sock, '{not json', false);
    onMessage(sock, JSON.stringify({ t: 'stats', p2pEnabled: 'yes' }), false);
    expect(s.hashFailures).toBe(0);
    expect(s.p2pAllowed).toBe(true);
  });

  it('floods on the control channel terminate the socket', () => {
    const live = makeLive();
    live.access.begin();
    const s = live.access.createSession({ nickname: 'a', deviceId: 'd', device: 'desktop', ip: 'ip' });
    const sock = { sessionId: s.id, msgs: { n: 0, at: Date.now() }, frames: { n: 0, at: Date.now() }, terminate: vi.fn(), close: vi.fn() };
    const onMessage = (live.control as unknown as { onMessage(s: unknown, t: string, b: boolean): void }).onMessage.bind(live.control);
    for (let i = 0; i < 40; i++) onMessage(sock, JSON.stringify({ t: 'pong' }), false);
    expect(sock.terminate).toHaveBeenCalled();
  });
});
