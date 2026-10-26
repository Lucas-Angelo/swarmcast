// Desktop app state for the panel (GET /api/desktop + the `desktop` WebSocket message).
// Pure helpers (no DOM) are unit-tested; the tiny store lets any component follow the state.
import { useEffect, useState } from 'preact/hooks';
import type { DesktopInfo, DesktopUpdate, LivePhase } from '@swarmcast/shared';

export const DESKTOP_API = '/api/desktop';

export function isDesktopInfo(v: unknown): v is DesktopInfo {
  const d = v as Partial<DesktopInfo> | null;
  return !!d && typeof d === 'object' && d.desktop === true && typeof d.version === 'string' && !!d.autostart && typeof d.autostart === 'object';
}

/** The desktop state, or null in script mode (`{ desktop: false }`), on older servers and on errors. */
export async function loadDesktop(get: (path: string, method: string) => Promise<unknown>): Promise<DesktopInfo | null> {
  try {
    const r = await get(DESKTOP_API, 'GET');
    return isDesktopInfo(r) ? r : null;
  } catch {
    return null;
  }
}

export type BannerView =
  | { kind: 'available'; version: string; current?: string; notes?: string; liveOn: boolean }
  | { kind: 'downloading'; version?: string; percent: number | null }
  | { kind: 'installing'; version?: string }
  | { kind: 'error'; version?: string; error?: string; liveOn: boolean };

/**
 * The update banner at the top of the panel: an update was found, is downloading or installing,
 * or installing it failed. A failed *check* (no version known) is shown in the card only.
 */
export function updateBanner(update: DesktopUpdate | null | undefined, phase: LivePhase): BannerView | null {
  if (!update) return null;
  const liveOn = phase !== 'off';
  switch (update.status) {
    case 'available':
      return update.version ? { kind: 'available', version: update.version, current: update.current, notes: update.notes?.trim() || undefined, liveOn } : null;
    case 'downloading':
      return { kind: 'downloading', version: update.version, percent: typeof update.progress === 'number' ? Math.round(update.progress * 100) : null };
    case 'installing':
      return { kind: 'installing', version: update.version };
    case 'error':
      return update.version ? { kind: 'error', version: update.version, error: update.error, liveOn } : null;
    default:
      return null;
  }
}

export type CheckView = 'checking' | 'upToDate' | 'available' | 'busy' | 'error' | 'unknown';

/** Status line next to "Check for updates" in the card. */
export function checkView(d: Pick<DesktopInfo, 'update' | 'updateChecking'>): CheckView {
  if (d.updateChecking) return 'checking';
  switch (d.update?.status) {
    case 'none':
      return 'upToDate';
    case 'available':
      return 'available';
    case 'downloading':
    case 'installing':
      return 'busy';
    case 'error':
      return 'error';
    default:
      return 'unknown';
  }
}

// ---- store ----

let current: DesktopInfo | null = null;
const listeners = new Set<(d: DesktopInfo | null) => void>();

export function setDesktop(d: DesktopInfo | null): void {
  current = d;
  for (const l of listeners) l(d);
}

export function getDesktop(): DesktopInfo | null {
  return current;
}

/** Current desktop state (null in script mode); re-renders on every change. */
export function useDesktop(): DesktopInfo | null {
  const [d, setD] = useState<DesktopInfo | null>(current);
  useEffect(() => {
    listeners.add(setD);
    setD(current);
    return () => {
      listeners.delete(setD);
    };
  }, []);
  return d;
}
