import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { ActivityEntry } from '@swarmcast/shared';
import { ActivityLog, scrubActivity } from '../../src/core/activity.js';
import { maxRecentDuration } from '../../src/hls/origin.js';
import { makeController } from './live-helpers.js';

/** A media playlist entry of `duration` seconds. */
const segment = (duration: number) => ({ tags: [], uri: 'x.mp4', duration });

describe('activity log', () => {
  it('keeps only the newest entries (ring buffer)', () => {
    // Arrange
    const log = new ActivityLog(5);
    // Act
    for (let i = 0; i < 12; i++) log.add({ text: `line ${i}` });
    // Assert
    const list = log.list();
    expect(list.map((e) => e.text)).toEqual(['line 7', 'line 8', 'line 9', 'line 10', 'line 11']);
    expect(list[0]!.id).toBe(8);
  });

  it('scrubs link secrets, tokens, stream keys and IP addresses (not loopback or clock times)', () => {
    // Act
    const text = scrubActivity(
      'join https://x.trycloudflare.com/join/AbC_123-xyz auth /auth/tok3n key sc_abcdefghijklmnopqrstu from 203.0.113.9 and 2001:db8::1 and fe80:0:0:0:1:2:3:4 at 12:30:45 via 127.0.0.1',
    );
    // Assert
    expect(text).not.toMatch(/AbC_123|tok3n|abcdefghijklmnop|203\.0\.113\.9|2001:db8|fe80/);
    expect(text).toContain('/join/[redacted]');
    expect(text).toContain('12:30:45');
    expect(text).toContain('127.0.0.1');
    expect(text.match(/\[ip\]/g)).toHaveLength(3);
  });

  it('scrubs params and derives English text from the code', () => {
    // Arrange
    const log = new ActivityLog();
    // Act
    const e = log.add({ kind: 'viewer', code: 'warn.tunnelDropped', params: { reason: 'lost 198.51.100.7' } });
    // Assert
    expect(e.text).toBe('The tunnel dropped (lost [ip]). Reconnecting…');
    expect(e.params).toEqual({ reason: 'lost [ip]' });
  });

  it('emits new entries', () => {
    // Arrange
    const log = new ActivityLog();
    const seen: ActivityEntry[] = [];
    log.on('entry', (e) => seen.push(e));
    // Act
    log.action('log.linkRotated');
    // Assert
    expect(seen).toEqual([expect.objectContaining({ kind: 'action', level: 'info', code: 'log.linkRotated', text: 'New link generated. The old link no longer lets people join.' })]);
  });

  it('clears, and says so', () => {
    // Arrange
    const log = new ActivityLog();
    const cleared = vi.fn();
    log.on('clear', cleared);
    log.action('log.linkRotated');
    // Act
    log.clear();
    // Assert
    expect(log.list()).toEqual([]);
    expect(cleared).toHaveBeenCalledOnce();
  });

  it('is fed by logger warnings/errors (not info, not records already shown with a code), redacted', () => {
    // Arrange
    const log = new ActivityLog();
    const logger = pino({ level: 'info', redact: { paths: ['streamKey'], censor: '[redacted]' } }, pino.multistream([{ level: 'warn', stream: log.logStream() }]));
    // Act
    logger.info('just info');
    logger.warn({ mediamtx: 'WAR [RTMP] [conn 10.0.0.5:51234] closed' }, 'mediamtx');
    logger.error({ err: 'boom', streamKey: 'sc_secretsecretsecret' }, 'child process failed to start');
    logger.warn({ panel: true }, 'already in the panel');
    // Assert
    const list = log.list();
    expect(list.map((e) => e.text)).toEqual(['MediaMTX: WAR [RTMP] [conn [ip]:51234] closed', 'child process failed to start (err=boom)']);
    expect(list.map((e) => e.level)).toEqual(['warn', 'error']);
    expect(JSON.stringify(list)).not.toContain('secret');
  });
});

describe('keyframe interval warning', () => {
  // The longest of the newest segments: one long segment (a reconnect, a ladder switch) does not
  // count; consistently long ones do.
  it.each([
    [[8, 2, 2, 2, 2, 2.1], 2],
    [[2, 2, 6.4, 2, 2], 2],
    [[8.3, 8.3, 8.3], 8.3],
    [[], 0],
  ])('segments %j: the keyframe interval is %d s', (durations, seconds) => {
    // Act
    const measured = maxRecentDuration(durations.map(segment));
    // Assert
    expect(measured).toBe(seconds);
  });

  it('warns (with a code) when OBS keyframes are more than 3 s apart, once in the activity log', () => {
    // Arrange
    const { live } = makeController();
    live.phase = 'live';
    live.origin.maxSegmentDurationS = 2;
    const before = live.snapshot().warningCodes.map((w) => w.code);
    // Act
    live.origin.maxSegmentDurationS = 6.2;
    const s = live.snapshot();
    live.snapshot();
    // Assert
    expect(before).not.toContain('warn.keyframes');
    const i = s.warningCodes.findIndex((w) => w.code === 'warn.keyframes');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(s.warningCodes[i]!.params).toEqual({ seconds: 6 });
    expect(s.warnings[i]).toMatch(/^OBS keyframes are every ~6 s\. .*Keyframe Interval = 2 s/);
    expect(live.activity.list().filter((e) => e.code === 'warn.keyframes')).toHaveLength(1);
  });

  it('records actions in the activity log with codes', () => {
    // Arrange
    const { live } = makeController();
    // Act
    live.updateSettings({ uploadLimitMbps: 25, autoStopMinutes: 10, alsoStreamingElsewhere: false, showViewerCount: true, allowViewerP2P: true });
    // Assert
    expect(live.activity.list().at(-1)).toMatchObject({ kind: 'action', code: 'log.settingsSaved', params: { upload: 25, autoStop: 10 } });
  });
});
