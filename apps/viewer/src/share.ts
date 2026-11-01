/**
 * The watch page's Share button: sends the live link to a friend.
 *
 * - The link comes from GET /api/share, which answers only while the streamer allows sharing and
 *   only to a viewer who joined with the current link (after "Generate new link" the others keep
 *   watching but never get the new secret). The server says which applies (hello.shareAllowed,
 *   {t:'share'}); the button shows only once the link is in hand.
 * - The link is fetched ahead of the click: the system share sheet and the clipboard both need a
 *   click that is still "fresh", and Safari counts it as stale after an await on the network.
 * - Share sheet (Web Share API) where the browser has one, else copy to the clipboard with a
 *   visible "Link copied", else (clipboard refused) the link in a selected read-only field to copy
 *   by hand.
 */

/** What the controller needs of navigator (share and clipboard are both optional). */
export interface ShareNavigator {
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data: ShareData) => boolean;
  clipboard?: { writeText(text: string): Promise<void> };
}

export interface ShareElements {
  button: HTMLButtonElement;
  /** A polite live region: "Link copied". */
  status: HTMLElement;
  /** The fallback: a wrapper (hidden until needed) and the read-only field inside it. */
  fallback: HTMLElement;
  field: HTMLInputElement;
}

export interface ShareDeps extends ShareElements {
  nav: ShareNavigator;
  /** GET /api/share: the link, or null when the server refuses (not allowed, 404, 429, offline). */
  fetchLink: () => Promise<string | null>;
  /** The share sheet's title (the streamer's name, or "Live · SwarmCast"). */
  title: () => string;
  labels: { copied: string };
  /** How long "Link copied" stays (ms). */
  copiedMs?: number;
}

export interface ShareControl {
  /** The server said this viewer may share (true) or not any more (false). */
  setAllowed(allowed: boolean): Promise<void>;
  /** The link the button sends, null while hidden (tests). */
  readonly link: string | null;
}

export function createShareControl(d: ShareDeps): ShareControl {
  let allowed = false;
  let link: string | null = null;
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  // A newer setAllowed wins over an older one still fetching.
  let seq = 0;

  const hide = (): void => {
    link = null;
    d.button.hidden = true;
    d.fallback.hidden = true;
    d.field.value = '';
    d.status.textContent = '';
  };
  hide();

  const copied = (): void => {
    d.fallback.hidden = true;
    d.status.textContent = d.labels.copied;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (d.status.textContent = ''), d.copiedMs ?? 4000);
  };

  const showField = (url: string): void => {
    d.status.textContent = '';
    d.field.value = url;
    d.fallback.hidden = false;
    d.field.focus();
    d.field.select();
  };

  const copy = async (url: string): Promise<void> => {
    try {
      if (!d.nav.clipboard) throw new Error('no clipboard');
      await d.nav.clipboard.writeText(url);
      copied();
    } catch {
      showField(url);
    }
  };

  d.button.addEventListener('click', () => {
    const url = link;
    if (!url) return;
    const data: ShareData = { title: d.title(), url };
    // Called right in the click (no await before it): the share sheet needs the fresh click.
    if (d.nav.share && (d.nav.canShare?.(data) ?? true)) {
      d.nav.share(data).catch((err: unknown) => {
        // The viewer closed the sheet: nothing to do. Anything else (no target app, a webview that
        // refuses): copy instead.
        if (!(err instanceof Error && err.name === 'AbortError')) void copy(url);
      });
      return;
    }
    void copy(url);
  });

  return {
    async setAllowed(on) {
      const mine = ++seq;
      allowed = on;
      if (!on) {
        hide();
        return;
      }
      if (link) return;
      const url = await d.fetchLink().catch(() => null);
      if (mine !== seq || !allowed) return;
      if (!url) {
        hide();
        return;
      }
      link = url;
      d.button.hidden = false;
    },
    get link() {
      return link;
    },
  };
}

/** An http(s) live link: `<base>/join/<secret>` (the base may have a path: a reverse proxy of the streamer's own). */
function isJoinLink(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.search === '' && u.hash === '' && /\/join\/[A-Za-z0-9_-]+$/.test(u.pathname);
  } catch {
    return false;
  }
}

/** GET /api/share with the session cookie: the link, or null when refused. */
export async function fetchShareLink(f: typeof fetch = fetch): Promise<string | null> {
  const res = await f('/api/share', { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) return null;
  const body = (await res.json()) as { url?: unknown };
  return typeof body.url === 'string' && isJoinLink(body.url) ? body.url : null;
}
