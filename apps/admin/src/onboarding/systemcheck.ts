// Installer system check (GET /api/system-check) → rows for the "Your PC check" step.
// Pure functions (no DOM) so the rendering logic is unit-tested in Node.
import { t, type MessageKey } from '@swarmcast/shared/i18n';
import type { SystemCheck, SystemCheckResult } from '@swarmcast/shared/system-check';

/** The file's types come from its schema in the shared package (also read by the server). */
export type { SystemCheck, SystemCheckResult };
export type CheckStatus = SystemCheckResult['status'];
type Value = SystemCheckResult['value'];

export const CHECK_IDS = ['os', 'ram', 'cpu', 'upload', 'download', 'disk', 'ports', 'obs', 'github', 'release'] as const;
export type CheckId = (typeof CHECK_IDS)[number];

const LABEL: Record<CheckId, MessageKey> = {
  os: 'onb.sys.id.os',
  ram: 'onb.sys.id.ram',
  cpu: 'onb.sys.id.cpu',
  upload: 'onb.sys.id.upload',
  download: 'onb.sys.id.download',
  disk: 'onb.sys.id.disk',
  ports: 'onb.sys.id.ports',
  obs: 'onb.sys.id.obs',
  github: 'onb.sys.id.github',
  release: 'onb.sys.id.release',
};

const FIX: Record<CheckId, MessageKey> = {
  os: 'onb.sys.fix.os',
  ram: 'onb.sys.fix.ram',
  cpu: 'onb.sys.fix.cpu',
  upload: 'onb.sys.fix.upload',
  download: 'onb.sys.fix.download',
  disk: 'onb.sys.fix.disk',
  ports: 'onb.sys.fix.ports',
  obs: 'onb.sys.fix.obs',
  github: 'onb.sys.fix.github',
  release: 'onb.sys.fix.release',
};

const ICON: Record<CheckStatus, string> = { ok: '✓', warn: '⚠', fail: '✗', skipped: '–' };

function isCheckId(id: string): id is CheckId {
  return (CHECK_IDS as readonly string[]).includes(id);
}

function show(v: Value): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v ? '✓' : '✗';
  return String(v);
}

/**
 * The installer and the desktop check write their values in English (start-*.sh / .ps1,
 * apps/server/src/desktop/system-check.ts). Words are translated by check id; numbers and
 * units ("8 GB", "120 Mbps") are shown as written.
 */
const VALUES: Partial<Record<CheckId, Array<[RegExp, MessageKey, string?]>>> = {
  ports: [
    [/^free$/i, 'onb.sys.val.free'],
    [/^in use: (.+)$/i, 'onb.sys.val.inUse', 'ports'],
  ],
  obs: [
    [/^installed$/i, 'onb.sys.val.installed'],
    [/^not found$/i, 'onb.sys.val.notFound'],
  ],
  github: [
    [/^reachable$/i, 'onb.sys.val.reachable'],
    [/^unreachable \(not needed\)$/i, 'onb.sys.val.unreachableOk'],
    [/^unreachable$/i, 'onb.sys.val.unreachable'],
  ],
  release: [
    [/^reachable \(latest (v\S+)\)$/i, 'onb.sys.val.reachableLatest', 'version'],
    [/^not reachable \(fine\)$/i, 'onb.sys.val.unreachableOk'],
    [/^unreachable$/i, 'onb.sys.val.unreachable'],
    [/^(v\S+) \(desktop app\)$/i, 'onb.sys.val.desktopApp', 'version'],
  ],
  upload: [
    [/^not measured \(skipped\)$/i, 'onb.sys.val.notMeasured'],
    [/^speed test failed$/i, 'onb.sys.val.speedFailed'],
  ],
  download: [
    [/^not measured \(skipped\)$/i, 'onb.sys.val.notMeasured'],
    [/^speed test failed$/i, 'onb.sys.val.speedFailed'],
  ],
};

/** A check value in the panel's language (unknown values are shown as written). */
export function translateValue(id: string, value: string | null): string | null {
  if (value === null || !isCheckId(id)) return value;
  for (const [re, key, param] of VALUES[id] ?? []) {
    const m = re.exec(value.trim());
    if (m) return param ? t(key, { [param]: m[1]! }) : t(key);
  }
  return value;
}

export interface CheckRow {
  id: string;
  status: CheckStatus;
  icon: string;
  label: string;
  /** e.g. "8 GB" — the measured value (words translated, units as the script wrote them). */
  value: string | null;
  /** "minimum 4 GB · recommended 8 GB" (translated), or null. */
  target: string | null;
  /** Plain-language "what to do" for warn/fail; null otherwise. */
  advice: string | null;
  detail: string | null;
}

export function checkRow(r: SystemCheckResult): CheckRow {
  const known = isCheckId(r.id);
  const min = show(r.min);
  const rec = show(r.recommended);
  const target = min && rec ? t('onb.sys.minRec', { min, recommended: rec }) : min ? t('onb.sys.min', { min }) : rec ? t('onb.sys.rec', { recommended: rec }) : null;
  const bad = r.status === 'warn' || r.status === 'fail';
  return {
    id: r.id,
    status: r.status,
    icon: ICON[r.status] ?? '?',
    label: known ? t(LABEL[r.id as CheckId]) : r.id,
    value: r.status === 'skipped' ? t('onb.sys.skipped') : translateValue(r.id, show(r.value)),
    target: r.status === 'skipped' ? null : target,
    advice: bad ? (known ? t(FIX[r.id as CheckId]) : t('onb.sys.fix.generic')) : null,
    detail: r.detail?.trim() ? r.detail.trim() : null,
  };
}

/** Rows in the installer's order (OS first … release last); unknown ids at the end. */
export function checkRows(c: SystemCheck): CheckRow[] {
  const order = (id: string): number => (isCheckId(id) ? CHECK_IDS.indexOf(id) : CHECK_IDS.length);
  return [...c.results].sort((a, b) => order(a.id) - order(b.id)).map(checkRow);
}

/** Show the friendly "below the recommended minimum" banner. */
export function belowMinimum(c: SystemCheck): boolean {
  return c.belowMinimum.length > 0 || c.results.some((r) => r.status === 'fail');
}

function isSystemCheck(v: unknown): v is SystemCheck {
  const c = v as Partial<SystemCheck> | null;
  return !!c && c.version === 1 && Array.isArray(c.results) && Array.isArray(c.belowMinimum);
}

/** The installer's check, or null when there is none (404, older server, error): the step falls back to live data. */
export async function loadSystemCheck(get: (path: string, method: string) => Promise<unknown>): Promise<SystemCheck | null> {
  try {
    const r = await get('/api/system-check', 'GET');
    return isSystemCheck(r) ? r : null;
  } catch {
    return null;
  }
}
