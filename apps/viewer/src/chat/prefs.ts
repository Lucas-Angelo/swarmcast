// The viewer's own chat choices on this device (localStorage, wrapped like the P2P switch:
// with storage blocked they last for this page only).

export interface ChatPrefs {
  hidden: boolean;
  times: boolean;
  large: boolean;
  /** Skin tone index for the emoji picker (0 = default yellow, 1..5 = light..dark). */
  tone: number;
  /** Recently used emoji / `:emote:` codes, newest first. */
  recent: string[];
}

const KEY = 'swarmcast.chat';
export const RECENT_MAX = 24;

let memory: ChatPrefs | null = null;

export function loadPrefs(): ChatPrefs {
  if (memory) return memory;
  let stored: Partial<ChatPrefs> = {};
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) stored = JSON.parse(raw) as Partial<ChatPrefs>;
  } catch {
    /* storage blocked or bad JSON: defaults */
  }
  memory = {
    hidden: stored.hidden === true,
    times: stored.times === true,
    large: stored.large === true,
    tone: Number.isInteger(stored.tone) && (stored.tone as number) >= 0 && (stored.tone as number) <= 5 ? (stored.tone as number) : 0,
    recent: Array.isArray(stored.recent) ? stored.recent.filter((r): r is string => typeof r === 'string' && r.length <= 40).slice(0, RECENT_MAX) : [],
  };
  return memory;
}

export function savePrefs(patch: Partial<ChatPrefs>): ChatPrefs {
  memory = { ...loadPrefs(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(memory));
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
  return memory;
}

/** Tests only. */
export function resetPrefsCache(): void {
  memory = null;
}
