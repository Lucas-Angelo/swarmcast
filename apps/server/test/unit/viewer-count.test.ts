import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@swarmcast/shared';
import { settingsSchema } from '@swarmcast/shared';
import { configSchema, defaultConfig } from '../../src/core/config.js';
import { LiveController, VIEWER_COUNT_INTERVAL_MS } from '../../src/core/live.js';
import type { DirectMode } from '../../src/direct/direct.js';
import type { ManifestSigner } from '../../src/hls/manifest.js';
import type { MediaMtx } from '../../src/media/mediamtx.js';
import { NoTunnel } from '../../src/tunnel/provider.js';
import { silentLog } from './helpers.js';

function makeLive(): { live: LiveController; sent: ServerMessage[] } {
  const direct = { noteViewer: vi.fn(), snapshot: () => ({ active: false, viewersSeen: 0 }), active: false, ipChanged: null } as unknown as DirectMode;
  const mediamtx = Object.assign(new EventEmitter(), { onPublish: () => {}, pid: undefined }) as unknown as MediaMtx;
  const live = new LiveController({
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
    now: () => Date.now(),
  });
  const sent: ServerMessage[] = [];
  vi.spyOn(live.control, 'broadcast').mockImplementation((m) => void sent.push(m));
  live.access.begin();
  return { live, sent };
}

const counts = (sent: ServerMessage[]): (number | null)[] => sent.flatMap((m) => (m.t === 'viewers' ? [m.count] : []));

describe('viewer count for viewers', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is on by default in the config and the settings schema', () => {
    expect(defaultConfig().showViewerCount).toBe(true);
    expect(configSchema.parse({}).showViewerCount).toBe(true);
    expect(settingsSchema.parse({ uploadLimitMbps: 10, autoStopMinutes: 10, alsoStreamingElsewhere: false }).showViewerCount).toBe(true);
  });

  it('broadcasts only the number, coalesced and at most every few seconds, only when it changes', () => {
    const { live, sent } = makeLive();
    live.access.createSession({ nickname: 'ana', deviceId: 'd1', device: 'desktop', ip: 'ip1' });
    vi.advanceTimersByTime(0);
    expect(counts(sent)).toEqual([1]);
    expect(JSON.stringify(sent)).not.toContain('ana');

    // Two more joins right away: one push after the throttle window, with the final number.
    live.access.createSession({ nickname: 'bia', deviceId: 'd2', device: 'mobile', ip: 'ip2' });
    live.access.createSession({ nickname: 'caio', deviceId: 'd3', device: 'desktop', ip: 'ip3' });
    vi.advanceTimersByTime(VIEWER_COUNT_INTERVAL_MS - 100);
    expect(counts(sent)).toEqual([1]);
    vi.advanceTimersByTime(200);
    expect(counts(sent)).toEqual([1, 3]);

    // No change → nothing sent.
    live.viewerCountChanged();
    vi.advanceTimersByTime(VIEWER_COUNT_INTERVAL_MS * 2);
    expect(counts(sent)).toEqual([1, 3]);

    // The hello message carries the current count.
    expect(live.control.viewerCount()).toBe(3);
  });

  it('counts the same sessions as the panel "Watching" stat', () => {
    const { live } = makeLive();
    const a = live.access.createSession({ nickname: 'a', deviceId: 'd1', device: 'desktop', ip: 'ip1' });
    live.access.createSession({ nickname: 'b', deviceId: 'd2', device: 'desktop', ip: 'ip2' });
    a.lastSeenAt = Date.now() - 60_000;
    a.connections = 0;
    expect(live.connectedSessions()).toHaveLength(1);
    expect(live.snapshot().stats.viewersConnected).toBe(1);
    expect(live.control.viewerCount()).toBe(1);
  });

  it('when the streamer hides the count, sends null and nothing in hello', () => {
    const { live, sent } = makeLive();
    live.access.createSession({ nickname: 'a', deviceId: 'd1', device: 'desktop', ip: 'ip1' });
    vi.advanceTimersByTime(0);
    live.updateSettings({ ...live.snapshot().settings, showViewerCount: false });
    vi.advanceTimersByTime(VIEWER_COUNT_INTERVAL_MS);
    expect(counts(sent)).toEqual([1, null]);
    expect(live.control.viewerCount()).toBeNull();
    expect(live.snapshot().settings.showViewerCount).toBe(false);
    live.access.createSession({ nickname: 'b', deviceId: 'd2', device: 'desktop', ip: 'ip2' });
    vi.advanceTimersByTime(VIEWER_COUNT_INTERVAL_MS);
    expect(counts(sent)).toEqual([1, null]);
  });
});
