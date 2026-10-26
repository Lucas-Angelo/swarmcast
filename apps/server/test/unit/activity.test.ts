import { EventEmitter } from 'node:events';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { ActivityEntry } from '@swarmcast/shared';
import { ActivityLog, scrubActivity } from '../../src/core/activity.js';
import { defaultConfig } from '../../src/core/config.js';
import { LiveController } from '../../src/core/live.js';
import type { DirectMode } from '../../src/direct/direct.js';
import type { ManifestSigner } from '../../src/hls/manifest.js';
import { maxRecentDuration } from '../../src/hls/origin.js';
import type { MediaMtx } from '../../src/media/mediamtx.js';
import { NoTunnel } from '../../src/tunnel/provider.js';
import { silentLog } from './helpers.js';

describe('activity log', () => {
  it('keeps only the newest entries (ring buffer)', () => {
    const log = new ActivityLog(5);
    for (let i = 0; i < 12; i++) log.add({ text: `line ${i}` });
    const list = log.list();
    expect(list).toHaveLength(5);
    expect(list.map((e) => e.text)).toEqual(['line 7', 'line 8', 'line 9', 'line 10', 'line 11']);
    expect(list[0]!.id).toBe(8);
  });

  it('scrubs link secrets, tokens, stream keys and IP addresses (not loopback or clock times)', () => {
    const text = scrubActivity(
      'join https://x.trycloudflare.com/join/AbC_123-xyz auth /auth/tok3n key sc_abcdefghijklmnopqrstu from 203.0.113.9 and 2001:db8::1 and fe80:0:0:0:1:2:3:4 at 12:30:45 via 127.0.0.1',
    );
    expect(text).not.toMatch(/AbC_123|tok3n|abcdefghijklmnop|203\.0\.113\.9|2001:db8|fe80/);
    expect(text).toContain('/join/[redacted]');
    expect(text).toContain('12:30:45');
    expect(text).toContain('127.0.0.1');
    expect(text.match(/\[ip\]/g)).toHaveLength(3);
  });

  it('scrubs params and derives English text from the code', () => {
    const log = new ActivityLog();
    const e = log.add({ kind: 'viewer', code: 'warn.tunnelDropped', params: { reason: 'lost 198.51.100.7' } });
    expect(e.text).toBe('The tunnel dropped (lost [ip]). Reconnecting…');
    expect(e.params).toEqual({ reason: 'lost [ip]' });
  });

  it('emits new entries and clears', () => {
    const log = new ActivityLog();
    const seen: ActivityEntry[] = [];
    const cleared = vi.fn();
    log.on('entry', (e) => seen.push(e));
    log.on('clear', cleared);
    log.action('log.linkRotated');
    expect(seen[0]).toMatchObject({ kind: 'action', level: 'info', code: 'log.linkRotated', text: 'New link generated. The old link no longer lets people join.' });
    log.clear();
    expect(log.list()).toEqual([]);
    expect(cleared).toHaveBeenCalled();
  });

  it('is fed by logger warnings/errors (not info, not records already shown with a code), redacted', () => {
    const log = new ActivityLog();
    const logger = pino({ level: 'info', redact: { paths: ['streamKey'], censor: '[redacted]' } }, pino.multistream([{ level: 'warn', stream: log.logStream() }]));
    logger.info('just info');
    logger.warn({ mediamtx: 'WAR [RTMP] [conn 10.0.0.5:51234] closed' }, 'mediamtx');
    logger.error({ err: 'boom', streamKey: 'sc_secretsecretsecret' }, 'child process failed to start');
    logger.warn({ panel: true }, 'already in the panel');
    const list = log.list();
    expect(list.map((e) => e.text)).toEqual(['MediaMTX: WAR [RTMP] [conn [ip]:51234] closed', 'child process failed to start (err=boom)']);
    expect(list.map((e) => e.level)).toEqual(['warn', 'error']);
    expect(JSON.stringify(list)).not.toContain('secret');
  });
});

describe('keyframe interval warning', () => {
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

  it('measures the longest of the newest segments', () => {
    const e = (duration: number) => ({ tags: [], uri: 'x.mp4', duration });
    expect(maxRecentDuration([e(8), e(2), e(2), e(2), e(2), e(2.1)])).toBe(2);
    // One long segment (reconnect / ladder switch) does not count; consistently long ones do.
    expect(maxRecentDuration([e(2), e(2), e(6.4), e(2), e(2)])).toBe(2);
    expect(maxRecentDuration([e(8.3), e(8.3), e(8.3)])).toBe(8.3);
    expect(maxRecentDuration([])).toBe(0);
  });

  it('warns (with a code) when OBS keyframes are more than 3 s apart, once in the activity log', () => {
    const live = makeLive();
    live.phase = 'live';
    live.origin.maxSegmentDurationS = 2;
    expect(live.snapshot().warningCodes.map((w) => w.code)).not.toContain('warn.keyframes');
    live.origin.maxSegmentDurationS = 6.2;
    const s = live.snapshot();
    const i = s.warningCodes.findIndex((w) => w.code === 'warn.keyframes');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(s.warningCodes[i]!.params).toEqual({ seconds: 6 });
    expect(s.warnings[i]).toMatch(/^OBS keyframes are every ~6 s\. .*Keyframe Interval = 2 s/);
    live.snapshot();
    expect(live.activity.list().filter((e) => e.code === 'warn.keyframes')).toHaveLength(1);
  });

  it('records actions in the activity log with codes', () => {
    const live = makeLive();
    live.updateSettings({ uploadLimitMbps: 25, autoStopMinutes: 10, alsoStreamingElsewhere: false, showViewerCount: true });
    expect(live.activity.list().at(-1)).toMatchObject({ kind: 'action', code: 'log.settingsSaved', params: { upload: 25, autoStop: 10 } });
  });
});
