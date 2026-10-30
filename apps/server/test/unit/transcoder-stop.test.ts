import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { TranscoderStatus } from '@swarmcast/shared';
import { isAlive } from '../../src/process/children.js';
import { LADDER_RUNGS, sleepingFfmpeg, transcoderWith } from './helpers-b.js';

// A start() while a stop() still waits for ffmpeg to exit (OBS reconnecting, a rendition dropped)
// must get its own child and a fresh folder; the late stop must not take them away, report 'off',
// or count the stopped child's exit as a crash. A second stop waits for the first one's child:
// 'off' means no ffmpeg is left. The stand-in for ffmpeg is a shell script (POSIX only; the
// Windows process tree is covered by kill-tree.test.ts and the integration tests).

describe.skipIf(process.platform === 'win32')('Transcoder: stop and start overlapping', () => {
  /** A ladder running, then stopped and started again at once (synchronously, while the stop waits for the old child). */
  async function restartedDuringStop() {
    const t = transcoderWith(sleepingFfmpeg());
    t.start(LADDER_RUNGS, 'libx264', false);
    const old = { dir: t.outDir!, pid: t.pid! };
    const statuses: TranscoderStatus[] = [];
    t.on('status', (s) => statuses.push(s));
    const stopping = t.stop();
    t.start(LADDER_RUNGS, 'libx264', false);
    const fresh = { dir: t.outDir!, pid: t.pid! };
    await stopping;
    return { t, old, fresh, statuses };
  }

  it('a start during a pending stop keeps its own child and folder', async () => {
    // Act
    const { t, old, fresh, statuses } = await restartedDuringStop();
    // Assert
    expect(fresh.dir).not.toBe(old.dir);
    expect(fresh.pid).not.toBe(old.pid);
    expect(t.outDir).toBe(fresh.dir);
    expect(t.pid).toBe(fresh.pid);
    expect(fs.existsSync(fresh.dir)).toBe(true);
    expect(isAlive(fresh.pid)).toBe(true);
    expect(statuses).not.toContain('off');
    expect(t.status).toBe('starting');
  });

  it('the late stop removes its own child and folder, and its exit is no crash and no restart', async () => {
    // Act
    const { t, old } = await restartedDuringStop();
    // Assert
    expect(isAlive(old.pid)).toBe(false);
    expect(fs.existsSync(old.dir)).toBe(false);
    expect({ launches: t.launches, crashes: t.crashes, restarts: t.restarts }).toEqual({ launches: 2, crashes: 0, restarts: 0 });
  });

  it('the next stop ends the new ladder: off, no child, no folder', async () => {
    // Arrange
    const { t, fresh } = await restartedDuringStop();
    // Act
    await t.stop();
    // Assert
    expect(t.status).toBe('off');
    expect(isAlive(fresh.pid)).toBe(false);
    expect(fs.existsSync(fresh.dir)).toBe(false);
  });

  it("a second stop waits for the first one's child: 'off' means no ffmpeg is left", async () => {
    // Arrange
    const t = transcoderWith(sleepingFfmpeg());
    t.start(LADDER_RUNGS, 'libx264', false);
    const pid = t.pid!;
    const first = t.stop();
    // Act
    await t.stop();
    // Assert
    expect(t.status).toBe('off');
    expect(isAlive(pid)).toBe(false);
    await first;
  });
});
