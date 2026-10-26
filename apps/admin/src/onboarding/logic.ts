// Pure logic of the first-run setup tutorial (no DOM): step order, auto-open, OBS detection,
// persistence calls. Kept separate from the Preact components so it can be unit-tested in Node.
import type { AdminState, QualityState } from '@swarmcast/shared';

export const STEPS = ['welcome', 'pc', 'output', 'choose', 'connect', 'test', 'share', 'tour', 'finish'] as const;
export type StepId = (typeof STEPS)[number];

/** "both": another platform (Twitch, YouTube, Kick...) + SwarmCast with the Multiple RTMP outputs plugin; "only": Settings → Stream → Custom. */
export type Route = 'both' | 'only';

export const ONBOARDING_API = '/api/onboarding';
/** Window event that reopens the tutorial (the "Redo setup tutorial" button). */
export const OPEN_EVENT = 'swarmcast:onboarding-open';

/** The tutorial opens by itself only when the server says it was never finished or skipped. */
export function shouldAutoOpen(done: boolean | null | undefined): boolean {
  return done === false;
}

export function clampStep(i: number): number {
  return Math.max(0, Math.min(STEPS.length - 1, Math.trunc(i)));
}

export function nextStep(i: number): number {
  return clampStep(i + 1);
}

export function prevStep(i: number): number {
  return clampStep(i - 1);
}

export function isLastStep(i: number): boolean {
  return i >= STEPS.length - 1;
}

export type TestStatus = 'off' | 'starting' | 'waiting' | 'receiving' | 'ok';

/**
 * Where the OBS test stands, from the live panel state:
 * off → SwarmCast is off; starting → turning on; waiting → on, no video yet;
 * receiving → OBS connected, video being prepared; ok → live with video from OBS.
 */
export function testStatus(s: Pick<AdminState, 'phase' | 'obsConnected'>): TestStatus {
  switch (s.phase) {
    case 'off':
    case 'stopping':
      return 'off';
    case 'starting':
      return 'starting';
    case 'waiting-obs':
      return s.obsConnected ? 'receiving' : 'waiting';
    case 'live':
      return s.obsConnected ? 'ok' : 'waiting';
    default:
      return 'off';
  }
}

/** The server's keyframe warning (segments longer than ~3 s), if present: OBS keyframe interval is not 2 s. */
export function keyframeProblem(s: Pick<AdminState, 'warningCodes'>): { seconds?: number } | null {
  const w = s.warningCodes?.find((c) => c?.code === 'warn.keyframes');
  if (!w) return null;
  const seconds = Number(w.params?.seconds);
  return Number.isFinite(seconds) && seconds > 0 ? { seconds } : {};
}

export type VideoSupport = 'unknown' | 'checking' | 'noFfmpeg' | 'hardware' | 'software' | 'none';

/** Plain-language summary of the quality ladder support; tolerant of missing fields (older servers). */
export function videoSupport(q: Partial<QualityState> | null | undefined): VideoSupport {
  if (!q || typeof q !== 'object') return 'unknown';
  if (q.ffmpeg && q.ffmpeg.available === false) return 'noFfmpeg';
  const encoders = Array.isArray(q.encoders) ? q.encoders : [];
  if (encoders.some((e) => e?.ok && e.hardware)) return 'hardware';
  if (encoders.some((e) => e?.ok)) return 'software';
  if (q.probing) return 'checking';
  return encoders.length > 0 ? 'none' : 'unknown';
}

/** The video converter install progress of GET /api/quality (`install`). */
export interface InstallLike {
  phase: string;
  receivedBytes?: number;
  totalBytes?: number;
  message?: string;
  attempt?: number;
  attempts?: number;
}

/** Where the ffmpeg install stands: installing, retrying (automatic, desktop first run), failed, or null (none / done). */
export function converterInstall(q: { install?: InstallLike | null } | null | undefined): 'installing' | 'retrying' | 'failed' | null {
  const phase = q?.install?.phase;
  if (!phase || phase === 'done') return null;
  if (phase === 'error') return 'failed';
  if (phase === 'retrying') return 'retrying';
  return 'installing';
}

type Get = (path: string, method: string) => Promise<unknown>;
type Post = (path: string, body: unknown) => Promise<unknown>;

/** Whether the tutorial was finished, or null when the server does not know (older server, error). */
export async function loadDone(get: Get): Promise<boolean | null> {
  try {
    const r = (await get(ONBOARDING_API, 'GET')) as { done?: unknown } | null;
    return typeof r?.done === 'boolean' ? r.done : null;
  } catch {
    return null;
  }
}

/** Persist completion server-side (survives browser changes). Errors are swallowed: the UI never blocks on it. */
export async function saveDone(post: Post, done: boolean): Promise<boolean> {
  try {
    await post(ONBOARDING_API, { done });
    return true;
  } catch {
    return false;
  }
}
