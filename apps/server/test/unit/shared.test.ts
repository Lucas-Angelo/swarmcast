import { describe, expect, it } from 'vitest';
import { clientMessageSchema, estimateCapacity, nicknameSchema } from '@swarmcast/shared';

// The shared schemas as the server uses them (packages/shared/test has the nickname and chat
// properties), and the panel's capacity estimate. Worked example of the estimate: 100 Mbps of
// upload, 75 % of it usable, minus the 6 Mbps she also streams elsewhere, leaves 69 Mbps; a viewer
// costs the 6 Mbps bitrate plus 15 % overhead (6.9 Mbps), so about 10 viewers fit.

/** A stats report as the viewer page sends it every few seconds. */
const STATS = { t: 'stats', p2pEnabled: true, httpBytes: 1, p2pDownBytes: 2, p2pUpBytes: 3, peers: 1, device: 'mobile' } as const;

describe('nickname', () => {
  it.each([
    ['  Ana   Maria ', 'Ana Maria'],
    ['joão_99', 'joão_99'],
    ['Zoë-x.y', 'Zoë-x.y'],
  ])('accepts %j as %j (whitespace trimmed and collapsed)', (input, expected) => {
    // Act
    const nickname = nicknameSchema.parse(input);
    // Assert
    expect(nickname).toBe(expected);
  });

  it.each([
    ['empty', '   '],
    ['too long', 'x'.repeat(25)],
    ['markup', '<script>'],
    ['a quote', 'a"b'],
  ])('rejects %s', (_what, input) => {
    // Act
    const r = nicknameSchema.safeParse(input);
    // Assert
    expect(r.success).toBe(false);
  });
});

describe('control messages', () => {
  it.each([
    ['stats', STATS, true],
    ['stats with the player delay', { ...STATS, delayS: 14 }, true],
    ['stats with a negative delay', { ...STATS, delayS: -1 }, false],
    ['an unknown type', { t: 'evil' }, false],
    ['a hash failure with a peer id that is not hex', { t: 'hash-fail', peerId: 'nothex', segment: 'x' }, false],
  ])('%s: valid = %s', (_what, message, valid) => {
    // Act
    const r = clientMessageSchema.safeParse(message);
    // Assert
    expect(r.success).toBe(valid);
  });
});

describe('capacity estimate', () => {
  it('is unknown without a speed test', () => {
    // Act
    const c = estimateCapacity({ limitMbps: 100, bitrateKbps: 6000, p2pShare: 0, alsoStreamingElsewhere: true, viewers: 0 });
    // Assert
    expect(c.level).toBe('unknown');
  });

  it('reserves upload for the streamer and keeps headroom (69 Mbps usable: about 10 viewers)', () => {
    // Act
    const c = estimateCapacity({ uploadMbps: 100, limitMbps: 1000, bitrateKbps: 6000, p2pShare: 0, alsoStreamingElsewhere: true, viewers: 0 });
    // Assert
    expect(c.usableUploadMbps).toBe(69);
    expect(c.recommendedLimitMbps).toBe(69);
    expect(c.directViewers).toBe(10);
    expect(c.message).toContain('about 10 viewers');
  });

  it('respects the configured limit', () => {
    // Act
    const c = estimateCapacity({ uploadMbps: 100, limitMbps: 20, bitrateKbps: 6000, p2pShare: 0, alsoStreamingElsewhere: false, viewers: 0 });
    // Assert
    expect(c.effectiveLimitMbps).toBe(20);
    expect(c.directViewers).toBe(2);
  });

  describe('with P2P help and an audience', () => {
    const base = { uploadMbps: 100, limitMbps: 1000, bitrateKbps: 6000, alsoStreamingElsewhere: true };

    it('counts the share of the video peers deliver', () => {
      // Act
      const helped = estimateCapacity({ ...base, p2pShare: 0.5, viewers: 0 });
      // Assert
      expect(helped.withP2PViewers).toBe(20);
    });

    it('warns near the limit', () => {
      // Act
      const c = estimateCapacity({ ...base, p2pShare: 0, viewers: 9 });
      // Assert
      expect(c.level).toBe('near');
    });

    it('says what helps once over it', () => {
      // Act
      const over = estimateCapacity({ ...base, p2pShare: 0, viewers: 30 });
      // Assert
      expect(over.level).toBe('over');
      expect(over.message).toMatch(/more internet or more viewers helping via P2P/);
    });
  });

  it('handles very low upload', () => {
    // Act
    const c = estimateCapacity({ uploadMbps: 5, limitMbps: 100, bitrateKbps: 6000, p2pShare: 0, alsoStreamingElsewhere: true, viewers: 0 });
    // Assert
    expect(c.directViewers).toBe(0);
    expect(c.level).toBe('over');
  });
});
