import { describe, expect, it } from 'vitest';
import { clientMessageSchema, estimateCapacity, nicknameSchema } from '@swarmcast/shared';

describe('nickname', () => {
  it('accepts normal nicknames and trims/collapses whitespace', () => {
    expect(nicknameSchema.parse('  Ana   Maria ')).toBe('Ana Maria');
    expect(nicknameSchema.parse('joão_99')).toBe('joão_99');
    expect(nicknameSchema.parse('Zoë-x.y')).toBe('Zoë-x.y');
  });
  it('rejects empty, too long and markup', () => {
    expect(nicknameSchema.safeParse('   ').success).toBe(false);
    expect(nicknameSchema.safeParse('x'.repeat(25)).success).toBe(false);
    expect(nicknameSchema.safeParse('<script>').success).toBe(false);
    expect(nicknameSchema.safeParse('a"b').success).toBe(false);
  });
});

describe('control messages', () => {
  it('validates stats and rejects unknown types', () => {
    expect(
      clientMessageSchema.safeParse({ t: 'stats', p2pEnabled: true, httpBytes: 1, p2pDownBytes: 2, p2pUpBytes: 3, peers: 1, device: 'mobile' }).success,
    ).toBe(true);
    expect(clientMessageSchema.safeParse({ t: 'stats', p2pEnabled: true, httpBytes: 1, p2pDownBytes: 2, p2pUpBytes: 3, peers: 1, device: 'mobile', delayS: 14 }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ t: 'stats', p2pEnabled: true, httpBytes: 1, p2pDownBytes: 2, p2pUpBytes: 3, peers: 1, device: 'mobile', delayS: -1 }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ t: 'evil' }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ t: 'hash-fail', peerId: 'nothex', segment: 'x' }).success).toBe(false);
  });
});

describe('capacity estimate', () => {
  it('is unknown without a speed test', () => {
    const c = estimateCapacity({ limitMbps: 100, bitrateKbps: 6000, p2pShare: 0, alsoStreamingElsewhere: true, viewers: 0 });
    expect(c.level).toBe('unknown');
  });

  it('reserves upload for the streamer and keeps headroom', () => {
    // 100 Mbps * 0.75 - 6 (other platform) = 69 usable; 6 * 1.15 = 6.9 per viewer → 10 viewers
    const c = estimateCapacity({ uploadMbps: 100, limitMbps: 1000, bitrateKbps: 6000, p2pShare: 0, alsoStreamingElsewhere: true, viewers: 0 });
    expect(c.usableUploadMbps).toBe(69);
    expect(c.recommendedLimitMbps).toBe(69);
    expect(c.directViewers).toBe(10);
    expect(c.message).toContain('about 10 viewers');
  });

  it('respects the configured limit', () => {
    const c = estimateCapacity({ uploadMbps: 100, limitMbps: 20, bitrateKbps: 6000, p2pShare: 0, alsoStreamingElsewhere: false, viewers: 0 });
    expect(c.effectiveLimitMbps).toBe(20);
    expect(c.directViewers).toBe(2);
  });

  it('counts P2P help and warns near the limit', () => {
    const base = { uploadMbps: 100, limitMbps: 1000, bitrateKbps: 6000, alsoStreamingElsewhere: true };
    const helped = estimateCapacity({ ...base, p2pShare: 0.5, viewers: 0 });
    expect(helped.withP2PViewers).toBe(20);
    expect(estimateCapacity({ ...base, p2pShare: 0, viewers: 9 }).level).toBe('near');
    const over = estimateCapacity({ ...base, p2pShare: 0, viewers: 30 });
    expect(over.level).toBe('over');
    expect(over.message).toMatch(/more internet or more viewers helping via P2P/);
  });

  it('handles very low upload', () => {
    const c = estimateCapacity({ uploadMbps: 5, limitMbps: 100, bitrateKbps: 6000, p2pShare: 0, alsoStreamingElsewhere: true, viewers: 0 });
    expect(c.directViewers).toBe(0);
    expect(c.level).toBe('over');
  });
});
