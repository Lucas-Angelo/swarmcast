import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SEGMENT_DURATION_S, type CodedText, type EncoderId, type Rung, type TranscoderStatus, type X264Preset } from '@swarmcast/shared';
import type { Logger } from '../core/logger.js';
import { coded } from '../core/messages.js';
import { ManagedChild, type Reaper } from '../process/children.js';
import { encoderArgs, encoderInputArgs } from './encoders.js';
import { SpeedWindow } from './load-guard.js';

export interface LadderArgsInput {
  inputUrl: string;
  outDir: string;
  /** Short id that prefixes every segment of one ffmpeg run, so a restart never reuses a name. */
  runId: string;
  rungs: Rung[];
  encoder: EncoderId;
  /** x264 preset for the CPU fallback. */
  preset?: X264Preset;
  hasAudio: boolean;
  segmentDurationS?: number;
  listSize?: number;
}

/**
 * One ffmpeg process makes the whole ladder: the source is copied (no quality loss, no CPU),
 * the smaller renditions are encoded with keyframes forced where the source has them, and
 * the audio is copied once into a shared audio rendition. One muxer means every rendition
 * shares the same timeline and segment boundaries, so hls.js can switch without gaps.
 */
export function buildLadderArgs(i: LadderArgsInput): string[] {
  const seg = i.segmentDurationS ?? SEGMENT_DURATION_S;
  const encoded = i.rungs.filter((r) => !r.source);
  const source = i.rungs.find((r) => r.source);
  if (!source) throw new Error('ladder needs the source rung');
  const args = [
    '-hide_banner', '-loglevel', 'warning', '-nostdin',
    '-progress', 'pipe:1', '-stats_period', '1',
    ...encoderInputArgs(i.encoder),
    // Give up (and get restarted) if MediaMTX sends nothing for 10 s.
    '-rw_timeout', '10000000',
    '-i', i.inputUrl,
    '-map', '0:v:0',
  ];
  for (let n = 0; n < encoded.length; n++) args.push('-map', '0:v:0');
  if (i.hasAudio) args.push('-map', '0:a:0');
  args.push('-c:v:0', 'copy');
  encoded.forEach((r, n) => {
    const spec = `v:${n + 1}`;
    const { filter, args: enc } = encoderArgs(i.encoder, spec, { kbps: r.kbps, height: r.height, fps: r.fps, ...(i.preset ? { preset: i.preset } : {}) });
    args.push(`-filter:${spec}`, filter, ...enc);
  });
  if (i.hasAudio) args.push('-c:a', 'copy');
  const names = [source, ...encoded].map((r, n) => `v:${n},${i.hasAudio ? 'agroup:aud,' : ''}name:${r.name}`);
  if (i.hasAudio) names.push('a:0,agroup:aud,name:audio');
  args.push(
    '-f', 'hls',
    // Half the target: ffmpeg cuts at the first keyframe AFTER hls_time, so with keyframes
    // exactly every `seg` seconds a full-length value can skip one and make 2×seg segments.
    '-hls_time', String(Math.max(1, seg / 2)),
    '-hls_list_size', String(i.listSize ?? 20),
    '-hls_flags', 'delete_segments+independent_segments+program_date_time+temp_file',
    '-hls_delete_threshold', '4',
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', `${i.runId}_%v_init.mp4`,
    '-hls_segment_filename', path.join(i.outDir, `${i.runId}_%v_%05d.m4s`),
    '-master_pl_name', 'index.m3u8',
    '-var_stream_map', names.join(' '),
    path.join(i.outDir, '%v.m3u8'),
  );
  return args;
}

export interface SourceMeta {
  /** CODECS of the source as MediaMTX advertised it, e.g. "avc1.64002a,mp4a.40.2". */
  codecs?: string;
  /** Source bitrate (video + audio) in kbps. */
  kbps: number;
}

/**
 * The multivariant playlist viewers get for the ladder. ffmpeg's own master leaves out the
 * copied source (it has no bitrate for stream-copied video when it writes the master, and
 * never rewrites it), so we write the STREAM-INF lines from the plan, reusing ffmpeg's
 * CODECS for the encoded renditions. Returns null until every rendition's playlist exists.
 */
export function renderLadderMultivariant(rungs: Rung[], hasAudio: boolean, ffmpegMaster: string | null, exists: (file: string) => boolean, src: SourceMeta): string | null {
  if (!ffmpegMaster) return null;
  for (const r of rungs) if (!exists(`${r.name}.m3u8`)) return null;
  if (hasAudio && !exists('audio.m3u8')) return null;
  const lines = ffmpegMaster.split(/\r?\n/).map((l) => l.trim());
  const audioLine = lines.find((l) => l.startsWith('#EXT-X-MEDIA:') && l.includes('TYPE=AUDIO'));
  const group = audioLine ? /GROUP-ID="([^"]+)"/.exec(audioLine)?.[1] : undefined;
  const ffInf = new Map<string, string>();
  lines.forEach((l, i) => {
    if (l.startsWith('#EXT-X-STREAM-INF:')) {
      const uri = lines.slice(i + 1).find((x) => x && !x.startsWith('#'));
      if (uri) ffInf.set(uri.replace(/\.m3u8$/, ''), l);
    }
  });
  const audioCodec = /mp4a\.[0-9.]+|opus|ac-3|ec-3/.exec(src.codecs ?? ffmpegMaster)?.[0] ?? 'mp4a.40.2';
  const audioKbps = hasAudio ? 128 : 0;
  const out = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];
  if (hasAudio && audioLine) out.push(audioLine);
  for (const r of rungs) {
    const avg = r.source ? Math.max(500, src.kbps || 6000) : r.kbps + audioKbps;
    const peak = Math.round(avg * (r.source ? 1.2 : 1.1));
    const ffCodecs = /CODECS="([^"]+)"/.exec(ffInf.get(r.name) ?? '')?.[1];
    const srcVideo = src.codecs?.split(',').find((c) => /^(avc|hvc|hev|av01|vp09)/.test(c.trim()))?.trim();
    const video = (r.source ? srcVideo : ffCodecs?.split(',')[0]) ?? ffCodecs?.split(',')[0] ?? 'avc1.64001f';
    const codecs = hasAudio ? `${video},${audioCodec}` : video;
    const attrs = [
      `BANDWIDTH=${peak * 1000}`,
      `AVERAGE-BANDWIDTH=${Math.round(avg * 1000)}`,
      `RESOLUTION=${r.width}x${r.height}`,
      `CODECS="${codecs}"`,
      `FRAME-RATE=${r.fps.toFixed(3)}`,
      ...(hasAudio && group ? [`AUDIO="${group}"`] : []),
    ];
    out.push(`#EXT-X-STREAM-INF:${attrs.join(',')}`, `${r.name}.m3u8`);
  }
  return out.join('\n') + '\n';
}

export interface TranscoderOptions {
  ffmpeg: string;
  inputUrl: string;
  /** Parent directory; each start gets a fresh subdirectory that is deleted on stop. */
  workDir: string;
  reaper: Reaper | null;
  log: Logger;
  /** Hide this string (the stream key) from logs. */
  secret?: string;
  maxRestarts?: number;
}

/**
 * The ffmpeg ladder process: started when OBS publishes (and the plan has renditions),
 * restarted with backoff if it dies, run at below-normal priority so OBS always wins
 * the CPU, and registered with the reaper like every other child.
 */
export class Transcoder extends EventEmitter<{ status: [TranscoderStatus]; ready: [] }> {
  status: TranscoderStatus = 'off';
  restarts = 0;
  message?: CodedText;
  outDir: string | null = null;
  private child: ManagedChild | null = null;
  private plan: { rungs: Rung[]; encoder: EncoderId; preset?: X264Preset; hasAudio: boolean } | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private readonly window = new SpeedWindow();

  constructor(private readonly o: TranscoderOptions) {
    super();
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Use another ffmpeg binary from the next start on (after installing it from the panel). */
  setBinary(ffmpeg: string): void {
    this.o.ffmpeg = ffmpeg;
  }

  get running(): boolean {
    return this.child?.running ?? false;
  }

  /** × real time over the last ~10 s (1.0 = keeping up with the live input). */
  get speed(): number | undefined {
    const v = this.window.speed;
    return v === undefined ? undefined : Math.round(v * 100) / 100;
  }

  /** How much time the speed window covers (ms). */
  get speedSpanMs(): number {
    return this.window.spanMs;
  }

  /** Rungs of the running ladder. */
  get rungs(): Rung[] {
    return this.plan?.rungs ?? [];
  }

  private set(status: TranscoderStatus, message?: CodedText): void {
    this.status = status;
    this.message = message;
    this.emit('status', status);
  }

  start(rungs: Rung[], encoder: EncoderId, hasAudio: boolean, preset?: X264Preset): void {
    this.stopping = false;
    this.plan = { rungs, encoder, hasAudio, ...(preset ? { preset } : {}) };
    this.window.clear();
    this.restarts = 0;
    if (!this.outDir) {
      fs.mkdirSync(this.o.workDir, { recursive: true, mode: 0o700 });
      this.outDir = fs.mkdtempSync(path.join(this.o.workDir, 'ladder-'));
    }
    this.spawn();
  }

  private spawn(): void {
    if (!this.plan || !this.outDir || this.stopping) return;
    const runId = `r${crypto.randomBytes(3).toString('hex')}`;
    const args = buildLadderArgs({ inputUrl: this.o.inputUrl, outDir: this.outDir, runId, ...this.plan });
    this.set(this.restarts === 0 ? 'starting' : 'restarting');
    const child = new ManagedChild('ffmpeg-ladder', this.o.ffmpeg, args, { cwd: this.outDir }, this.o.reaper, this.o.log);
    this.child = child;
    if (child.pid) {
      try {
        // OBS (and her stream to other platforms) must always win the CPU.
        os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        /* best effort */
      }
    }
    const clean = (l: string): string => (this.o.secret ? l.replaceAll(this.o.secret, '[key]') : l);
    let sawOutput = false;
    child.on('line', (line, stream) => {
      if (stream === 'stdout') {
        const t = /^out_time_us=(\d+)/.exec(line);
        if (t) this.window.add(Date.now(), Number(t[1]));
        if (!sawOutput && /^out_time_us=[1-9]\d*/.test(line)) {
          sawOutput = true;
          this.set('running');
        }
        return;
      }
      this.o.log.warn({ ffmpeg: clean(line) }, 'ffmpeg ladder');
    });
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      if (this.stopping) return;
      this.restarts += 1;
      const max = this.o.maxRestarts ?? 5;
      if (this.restarts > max) {
        this.set('failed', coded('quality.transcoder.failed', { count: this.restarts, exit: String(code ?? signal) }));
        return;
      }
      const delay = Math.min(10_000, 1000 * 2 ** (this.restarts - 1));
      this.o.log.warn({ code, signal, restarts: this.restarts, delay }, 'ffmpeg ladder exited, restarting');
      this.set('restarting', coded('quality.transcoder.restarting', { exit: String(code ?? signal) }));
      this.restartTimer = setTimeout(() => this.spawn(), delay);
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    await this.child?.stop(2000);
    this.child = null;
    this.window.clear();
    if (this.outDir) {
      fs.rmSync(this.outDir, { recursive: true, force: true });
      this.outDir = null;
    }
    this.plan = null;
    this.set('off');
  }
}
