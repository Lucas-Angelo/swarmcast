import { describe, expect, it } from 'vitest';
import { segmentStart, trackTimescales } from '../../src/hls/fmp4.js';
import { fmp4Init, fmp4Segment } from './helpers-b.js';

// Where an fMP4 segment starts on the stream's media clock: the origin dates the segments of all
// its playlists on one timeline by it (hls/playlist.ts, DiscontinuityClock.dateAt). The numbers
// are MediaMTX's for the fake OBS: video at 90 kHz, audio at 48 kHz, 21 ms apart at a cut.

describe('fMP4 media times', () => {
  it("reads a segment's start from its decode time and its init segment's timescale", () => {
    // Arrange
    const video = trackTimescales(fmp4Init(90_000));
    const audio = trackTimescales(fmp4Init(48_000));

    // Act
    const videoStart = segmentStart(fmp4Segment(1_804_230), video);
    const audioStart = segmentStart(fmp4Segment(961_248), audio);

    // Assert
    expect(video).toEqual(new Map([[1, 90_000]]));
    expect(videoStart).toBeCloseTo(20.047, 9);
    expect(audioStart).toBeCloseTo(20.026, 9);
  });

  it('reads decode times past 32 bits (a stream hours long)', () => {
    // Arrange
    const ticks = 2 ** 33 + 90_000;

    // Act
    const start = segmentStart(fmp4Segment(ticks), trackTimescales(fmp4Init(90_000)));

    // Assert
    expect(start).toBeCloseTo(ticks / 90_000, 6);
  });

  it('gives nothing for what it cannot read, and never throws', () => {
    // Arrange
    const timescales = trackTimescales(fmp4Init(90_000));
    const segment = fmp4Segment(1_804_230);

    // Act
    const truncated = segmentStart(segment.subarray(0, 40), timescales);
    const noInit = segmentStart(segment, new Map());
    const notMp4 = segmentStart(Buffer.from('#EXTM3U\n'), timescales);
    const initOfSegment = trackTimescales(segment);

    // Assert
    expect(truncated).toBeUndefined();
    expect(noInit).toBeUndefined();
    expect(notMp4).toBeUndefined();
    expect(initOfSegment.size).toBe(0);
  });
});
