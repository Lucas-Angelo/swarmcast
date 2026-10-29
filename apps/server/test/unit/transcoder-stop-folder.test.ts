import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Rung } from '@swarmcast/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { Transcoder } from '../../src/quality/transcoder.js';
import { silentLog } from './helpers.js';

// "Stop everything" right after OBS left: the ladder is already being stopped (OBS leaving
// stops it), and the live's own stop of the transcoder finds no folder of its own to delete.
// It must still return only once the folder of the stop in progress is gone, as the panel says
// "your files are deleted" when it returns. (Seen in the ladder integration test on Ubuntu:
// the folder still existed when live.stop() had returned true.)

const rungs: Rung[] = [
  { name: 'v1080', height: 1080, width: 1920, fps: 30, kbps: 6000, source: true },
  { name: 'v480', height: 480, width: 854, fps: 30, kbps: 1500, source: false },
];
const dirs: string[] = [];
const transcoders: Transcoder[] = [];
afterEach(async () => {
  for (const t of transcoders.splice(0)) await t.stop();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A stand-in for ffmpeg that runs until killed. */
function fakeFfmpeg(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-fake-ffmpeg-'));
  dirs.push(dir);
  const bin = path.join(dir, 'ffmpeg');
  fs.writeFileSync(bin, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  return bin;
}

describe.skipIf(process.platform === 'win32')('Transcoder: a stop while another stop is in progress', () => {
  it('returns only once the folder of the earlier stop is deleted', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-ladder-'));
    dirs.push(workDir);
    const t = new Transcoder({ ffmpeg: fakeFfmpeg(), inputUrl: 'rtmp://127.0.0.1:9/live/x', workDir, reaper: null, log: silentLog });
    transcoders.push(t);
    t.start(rungs, 'libx264', false);
    const dir = t.outDir!;
    // Many files, so deleting the folder takes a while after the child is gone.
    for (let i = 0; i < 2000; i++) fs.writeFileSync(path.join(dir, `seg_${i}.m4s`), 'x');
    const first = t.stop(); // OBS left
    await t.stop(); // "Stop everything"
    expect(fs.existsSync(dir)).toBe(false);
    await first;
    expect(t.status).toBe('off');
  });
});
