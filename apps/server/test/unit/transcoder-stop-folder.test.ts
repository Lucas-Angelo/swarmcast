import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LADDER_RUNGS, sleepingFfmpeg, transcoderWith } from './helpers-b.js';

// "Stop everything" right after OBS left: the ladder is already being stopped (OBS leaving stops
// it), and the live's own stop of the transcoder finds no folder of its own to delete. It must
// still return only once the folder of the stop in progress is gone, as the panel says "your
// files are deleted" when it returns. (Seen in the ladder integration test on Ubuntu: the folder
// still existed when live.stop() had returned true.) The folder holds many files so that deleting
// it takes a while after the child is gone: a stop that did not wait would return before.
// POSIX only: the stand-in for ffmpeg is a shell script.

/** Segment files in the ladder folder: enough that deleting them is not instant. */
const SEGMENTS = 2000;

describe.skipIf(process.platform === 'win32')('Transcoder: a stop while another stop is in progress', () => {
  it('returns only once the folder of the earlier stop is deleted', async () => {
    // Arrange
    const t = transcoderWith(sleepingFfmpeg());
    t.start(LADDER_RUNGS, 'libx264', false);
    const dir = t.outDir!;
    for (let i = 0; i < SEGMENTS; i++) fs.writeFileSync(path.join(dir, `seg_${i}.m4s`), 'x');
    const first = t.stop();
    // Act
    await t.stop();
    // Assert
    expect(fs.existsSync(dir)).toBe(false);
    await first;
    expect(t.status).toBe('off');
  });
});
