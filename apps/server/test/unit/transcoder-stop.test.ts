import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Rung } from '@swarmcast/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { isAlive } from '../../src/process/children.js';
import { Transcoder } from '../../src/quality/transcoder.js';
import { silentLog } from './helpers.js';

// A start() while a stop() still waits for ffmpeg to exit (OBS reconnecting, a rendition
// dropped) must get its own child and a fresh folder; the late stop must not take them away,
// report 'off', or count the stopped child's exit as a crash.

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

/** A stand-in for ffmpeg that runs until killed (whatever arguments it gets). */
function fakeFfmpeg(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-fake-ffmpeg-'));
  dirs.push(dir);
  const bin = path.join(dir, 'ffmpeg');
  fs.writeFileSync(bin, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  return bin;
}

function make(): Transcoder {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-ladder-'));
  dirs.push(workDir);
  const t = new Transcoder({ ffmpeg: fakeFfmpeg(), inputUrl: 'rtmp://127.0.0.1:9/live/x', workDir, reaper: null, log: silentLog });
  transcoders.push(t);
  return t;
}

describe.skipIf(process.platform === 'win32')('Transcoder: stop and start overlapping', () => {
  it('a start during a pending stop keeps its own child and folder; the old ones are gone', async () => {
    const t = make();
    t.start(rungs, 'libx264', false);
    const oldDir = t.outDir!;
    const oldPid = t.pid!;
    const statuses: string[] = [];
    t.on('status', (s) => statuses.push(s));
    const stopping = t.stop();
    // Synchronously, while the stop waits for the old child: OBS is back.
    t.start(rungs, 'libx264', false);
    const newDir = t.outDir!;
    const newPid = t.pid!;
    await stopping;
    expect(newDir).not.toBe(oldDir);
    expect(newPid).not.toBe(oldPid);
    // The late stop left the new ladder alone…
    expect(t.outDir).toBe(newDir);
    expect(t.pid).toBe(newPid);
    expect(fs.existsSync(newDir)).toBe(true);
    expect(isAlive(newPid)).toBe(true);
    expect(statuses).not.toContain('off');
    expect(t.status).toBe('starting');
    // …and removed its own child and folder.
    expect(isAlive(oldPid)).toBe(false);
    expect(fs.existsSync(oldDir)).toBe(false);
    // The stopped child's exit is not a crash, and nothing restarts because of it.
    expect({ launches: t.launches, crashes: t.crashes, restarts: t.restarts }).toEqual({ launches: 2, crashes: 0, restarts: 0 });
    await t.stop();
    expect(t.status).toBe('off');
    expect(isAlive(newPid)).toBe(false);
    expect(fs.existsSync(newDir)).toBe(false);
  });

  it("a second stop waits for the first one's child: 'off' means no ffmpeg is left", async () => {
    const t = make();
    t.start(rungs, 'libx264', false);
    const pid = t.pid!;
    const first = t.stop();
    await t.stop();
    expect(t.status).toBe('off');
    expect(isAlive(pid)).toBe(false);
    await first;
  });
});
