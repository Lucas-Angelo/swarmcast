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
  /**
   * The viewer agreed that their browser may contact the GIF provider (plan 3.3). Always asked:
   * nothing is fetched from the provider before this is true.
   */
  gifs: boolean;
  /** Animate GIFs; null = follow the system's "reduce motion" setting. */
  animate: boolean | null;
}

const KEY = 'swarmcast.chat';
export const RECENT_MAX = 24;

/** The choices of one page: read from storage once, then kept in memory and written through. */
export interface PrefsStore {
  load(): ChatPrefs;
  save(patch: Partial<ChatPrefs>): ChatPrefs;
}

type PrefsStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * A store over `storage()` (the page's localStorage by default). Storage that is missing, blocked
 * (the getter or a call throws) or holds bad JSON gives the defaults, and the choices then last for
 * this page only.
 */
export function createPrefsStore(storage: () => PrefsStorage | null = () => localStorage): PrefsStore {
  let memory: ChatPrefs | null = null;
  const load = (): ChatPrefs => {
    if (memory) return memory;
    let stored: Partial<ChatPrefs> = {};
    try {
      const raw = storage()?.getItem(KEY);
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
      gifs: stored.gifs === true,
      animate: typeof stored.animate === 'boolean' ? stored.animate : null,
    };
    return memory;
  };
  return {
    load,
    save(patch) {
      memory = { ...load(), ...patch };
      try {
        storage()?.setItem(KEY, JSON.stringify(memory));
      } catch {
        /* storage blocked: the choice lasts for this page only */
      }
      return memory;
    },
  };
}

/** The page's store: the chat, its settings and the picker share it. */
export const pagePrefs = createPrefsStore();

export function loadPrefs(): ChatPrefs {
  return pagePrefs.load();
}

export function savePrefs(patch: Partial<ChatPrefs>): ChatPrefs {
  return pagePrefs.save(patch);
}

/** Animate GIFs now: the viewer's choice, else off when the system asks for reduced motion. */
export function animateGifs(p: ChatPrefs = loadPrefs()): boolean {
  if (p.animate !== null) return p.animate;
  try {
    return !matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return true;
  }
}
