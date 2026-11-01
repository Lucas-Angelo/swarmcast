// The message list (plan §2.4). Untrusted text reaches the DOM only through textContent and
// text nodes, inside <bdi> (isolated direction) in boxes that clip; colours go through the
// CSSOM (style.setProperty), which the strict CSP allows. No innerHTML anywhere in chat/
// (an ESLint rule enforces it).
//
// Budget: at most RENDER_PER_FRAME messages per animation frame (older ones become one
// "N messages skipped" line), at most DOM_MAX in the list, nothing rendered while the chat is
// hidden or the tab is in the background (messages wait, up to DOM_MAX). A visible page whose
// frames are late or do not come (the browser may skip rendering opportunities of a page it still
// reports as visible) gets its messages from a timer instead, FRAME_FALLBACK_MS later.
//
// One row never breaks the others: a system line whose code this page does not know (a newer
// server) shows a neutral line, and a row that fails to build for any reason is shown as
// "Message hidden" while the rest of the batch is drawn.
import { formatNumber, getLang, t, translateWire } from '@swarmcast/shared/i18n';
import { checkChatInvariants, CHAT_NICKNAME_MAX, defaultNameColor, gifMediaUrl, isHexColor, tokenizeChat, type ChatAuthor, type GifProvider, type GifRef } from './core/index.js';
import type { Emote } from './emotes.js';
import type { ChatEntry } from './session.js';

export const RENDER_PER_FRAME = 50;
export const DOM_MAX = 150;
export const ANNOUNCE_EVERY_MS = 3000;
/** Messages waiting for an animation frame are drawn by a timer when no frame came this long. */
export const FRAME_FALLBACK_MS = 500;
/** A sent message still waiting for its own copy from the server after the ack: shown as sent. */
const ACKED_WAIT_MS = 10_000;

export interface ListOptions {
  /** Emotes usable now (code → files). */
  emotes(): ReadonlyMap<string, Emote>;
  /** The colour to paint a name in (already adjusted for contrast against the chat background). */
  nickColor(color: string): string;
  showTimes(): boolean;
  /** Rendering is allowed (chat shown and tab visible). */
  visible(): boolean;
  /** Next animation frame (requestAnimationFrame). */
  raf?: (cb: () => void) => unknown;
  /** Run `cb` in `ms`; returns its cancel (setTimeout). */
  later?: (cb: () => void, ms: number) => () => void;
  now?: () => number;
  /** GIFs: has the viewer agreed to load them, and should they animate (plan 3.3, 5.4)? */
  gifs?: () => { consented: boolean; animate: boolean };
  /** The viewer tapped "show GIFs" on a placeholder. */
  onGifConsent?: () => void;
}

/** How a provider is named on screen. */
export const GIF_PROVIDER_NAMES: Record<GifProvider, string> = { klipy: 'KLIPY', giphy: 'GIPHY' };
/** At most this many animated GIF images in the list; older ones go back to a "play" button (frees decoded frames). */
export const LIVE_GIFS_MAX = 10;

export interface ListStats {
  rendered: number;
  hidden: number;
  skipped: number;
  /** Draws the fallback timer did because no animation frame came in FRAME_FALLBACK_MS. */
  late: number;
  /** Rows that failed to build (malformed entries): shown as "Message hidden" instead. */
  failed: number;
}

interface Pending {
  li: HTMLLIElement;
  s?: number;
  timer?: ReturnType<typeof setTimeout>;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

let timeFormat: { lang: string; f: Intl.DateTimeFormat } | null = null;
function clock(at: number): string {
  const lang = getLang();
  if (timeFormat?.lang !== lang) timeFormat = { lang, f: new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit' }) };
  return timeFormat.f.format(new Date(at));
}

export class ChatList {
  readonly list: HTMLUListElement;
  readonly pill: HTMLButtonElement;
  readonly live: HTMLDivElement;
  readonly stats: ListStats = { rendered: 0, hidden: 0, skipped: 0, late: 0, failed: 0 };
  private queue: ChatEntry[] = [];
  private scheduled = false;
  private stuck = true;
  private unread = 0;
  private toAnnounce = 0;
  private announceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly bySeq = new Map<number, HTMLLIElement>();
  private readonly pending = new Map<number, Pending>();
  private readonly gifRefs = new WeakMap<HTMLElement, GifRef>();
  private liveGifs: HTMLElement[] = [];
  private readonly raf: (cb: () => void) => unknown;
  private readonly later: (cb: () => void, ms: number) => () => void;
  /** Called when the unread count changes (for the "Show chat (3 new)" button). */
  onUnread: (n: number) => void = () => {};

  constructor(
    readonly root: HTMLElement,
    private readonly opts: ListOptions,
  ) {
    this.raf = opts.raf ?? ((cb) => requestAnimationFrame(cb));
    this.later =
      opts.later ??
      ((cb, ms) => {
        const id = setTimeout(cb, ms);
        return () => clearTimeout(id);
      });
    this.list = el('ul', 'chat-list');
    this.list.setAttribute('role', 'log');
    this.list.setAttribute('aria-live', 'off');
    this.list.setAttribute('aria-label', t('chat.viewer.title'));
    this.list.tabIndex = 0;
    this.list.dataset.testid = 'chat-list';
    this.pill = el('button', 'chat-pill');
    this.pill.type = 'button';
    this.pill.hidden = true;
    this.pill.textContent = t('chat.viewer.newMessages');
    this.pill.addEventListener('click', () => this.scrollToEnd());
    this.live = el('div', 'sr-only');
    this.live.setAttribute('aria-live', 'polite');
    this.live.setAttribute('role', 'status');
    this.list.addEventListener('scroll', () => {
      this.stuck = this.atEnd();
      if (this.stuck) this.setUnread(0);
    });
    root.append(this.list, this.pill, this.live);
    this.showEmpty();
  }

  /** Forget everything and show `entries` (snapshot). */
  reset(entries: ChatEntry[]): void {
    this.queue = [];
    this.bySeq.clear();
    for (const p of this.pending.values()) if (p.timer) clearTimeout(p.timer);
    this.pending.clear();
    this.list.replaceChildren();
    this.stuck = true;
    this.setUnread(0);
    this.append(entries, false);
    if (entries.length === 0) this.showEmpty();
  }

  append(entries: ChatEntry[], announce = true): void {
    if (entries.length === 0) return;
    this.queue.push(...entries);
    if (announce) this.toAnnounce += entries.filter((e) => e.kind === 'msg').length;
    // Waiting while hidden: keep at most DOM_MAX, count the rest as skipped.
    if (this.queue.length > DOM_MAX) this.dropOldestQueued(this.queue.length - DOM_MAX);
    this.schedule();
  }

  remove(seqs: readonly number[]): void {
    const set = new Set(seqs);
    this.queue = this.queue.filter((e) => e.kind === 'skip' || !set.has(e.s));
    for (const s of set) {
      this.bySeq.get(s)?.remove();
      this.bySeq.delete(s);
    }
  }

  clearUpTo(s: number): void {
    this.queue = this.queue.filter((e) => e.kind === 'skip' || e.s > s);
    for (const [seq, li] of this.bySeq) {
      if (seq <= s) {
        li.remove();
        this.bySeq.delete(seq);
      }
    }
    for (const li of [...this.list.querySelectorAll('li.skipped, li.empty')]) li.remove();
  }

  /** Re-colour an author's names (roster change) or every name (theme change). */
  recolor(author?: ChatAuthor): void {
    for (const nick of this.list.querySelectorAll<HTMLElement>('.nick[data-c]')) {
      if (author && nick.dataset.a !== author.a) continue;
      if (author) {
        nick.dataset.c = author.c;
        nick.textContent = author.n;
      }
      nick.style.setProperty('--nick', this.opts.nickColor(nick.dataset.c ?? ''));
    }
  }

  /** The viewer's own message, shown at once as "sending…" until the server acks it. */
  addPending(n: number, text: string, me: ChatAuthor, gif?: GifRef): void {
    const li = this.build({ kind: 'msg', s: 0, at: (this.opts.now ?? Date.now)(), author: me, ...(gif ? { gif } : { text }) });
    li.classList.add('pending');
    li.removeAttribute('data-seq');
    const state = el('span', 'state');
    state.textContent = t('chat.viewer.sending');
    li.append(state);
    this.list.querySelector('li.empty')?.remove();
    this.list.append(li);
    this.pending.set(n, { li });
    this.trim();
    this.scrollToEnd();
  }

  ack(n: number, s: number): void {
    const p = this.pending.get(n);
    if (!p) return;
    if (this.bySeq.has(s)) {
      p.li.remove();
      this.pending.delete(n);
      return;
    }
    p.s = s;
    p.timer = setTimeout(() => {
      p.li.classList.remove('pending');
      p.li.querySelector('.state')?.remove();
      this.pending.delete(n);
    }, ACKED_WAIT_MS);
  }

  /** The server refused it: the row stays, marked "not sent" (the text is not lost). */
  reject(n: number | undefined): void {
    if (n === undefined) return;
    const p = this.pending.get(n);
    if (!p) return;
    this.pending.delete(n);
    p.li.classList.remove('pending');
    p.li.classList.add('failed');
    const state = p.li.querySelector('.state');
    if (state) state.textContent = t('chat.viewer.notSent');
  }

  /** Render now if allowed (called when the chat is shown again or the tab comes back). */
  resume(): void {
    this.schedule();
  }

  scrollToEnd(): void {
    this.list.scrollTop = this.list.scrollHeight;
    this.stuck = true;
    this.setUnread(0);
  }

  private atEnd(): boolean {
    return this.list.scrollTop + this.list.clientHeight >= this.list.scrollHeight - 32;
  }

  private setUnread(n: number): void {
    this.unread = n;
    this.pill.hidden = n === 0;
    this.onUnread(n);
  }

  private dropOldestQueued(count: number): void {
    let dropped = 0;
    let n = 0;
    let i = 0;
    for (; i < this.queue.length && dropped < count; i++) {
      const e = this.queue[i]!;
      if (e.kind === 'skip') n += e.n;
      else {
        dropped++;
        n++;
      }
    }
    this.stats.skipped += dropped;
    this.queue = [{ kind: 'skip', n }, ...this.queue.slice(i)];
  }

  /**
   * Draw on the next animation frame, or from a timer when that frame is FRAME_FALLBACK_MS late:
   * frames pace the drawing, they must not decide whether a message shows at all.
   */
  private schedule(): void {
    if (this.scheduled || !this.opts.visible()) return;
    this.scheduled = true;
    let done = false;
    const draw = (late: boolean): void => {
      if (done) return;
      done = true;
      cancelTimer();
      this.scheduled = false;
      if (late) this.stats.late++;
      this.flush();
    };
    const cancelTimer = this.later(() => draw(true), FRAME_FALLBACK_MS);
    this.raf(() => draw(false));
  }

  private flush(): void {
    if (!this.opts.visible() || this.queue.length === 0) return;
    let batch = this.queue;
    this.queue = [];
    if (batch.length > RENDER_PER_FRAME) {
      const old = batch.slice(0, batch.length - RENDER_PER_FRAME + 1);
      const skipped = old.reduce((n, e) => n + (e.kind === 'skip' ? e.n : 1), 0);
      this.stats.skipped += old.filter((e) => e.kind !== 'skip').length;
      batch = [{ kind: 'skip', n: skipped }, ...batch.slice(batch.length - RENDER_PER_FRAME + 1)];
    }
    const wasStuck = this.stuck;
    const frag = document.createDocumentFragment();
    let added = 0;
    for (const e of batch) {
      if (e.kind === 'msg') {
        // Our own message came back: it replaces the "sending…" row.
        for (const [n, p] of this.pending) {
          if (p.s === e.s) {
            if (p.timer) clearTimeout(p.timer);
            p.li.remove();
            this.pending.delete(n);
          }
        }
        if (this.bySeq.has(e.s)) continue;
      }
      const li = this.buildSafe(e);
      if (e.kind !== 'skip') this.bySeq.set(e.s, li);
      frag.append(li);
      added++;
    }
    this.list.querySelector('li.empty')?.remove();
    this.list.append(frag);
    this.trim();
    if (wasStuck) this.scrollToEnd();
    else if (added) this.setUnread(this.unread + added);
    this.scheduleAnnounce();
  }

  private trim(): void {
    while (this.list.childElementCount > DOM_MAX) {
      const first = this.list.firstElementChild as HTMLLIElement | null;
      if (!first) break;
      const seq = Number(first.dataset.seq);
      if (seq) this.bySeq.delete(seq);
      first.remove();
    }
  }

  private scheduleAnnounce(): void {
    if (this.announceTimer || this.toAnnounce === 0) return;
    this.announceTimer = setTimeout(() => {
      this.announceTimer = null;
      if (this.toAnnounce > 0 && this.opts.visible()) this.live.textContent = t('chat.viewer.announce', { count: this.toAnnounce });
      this.toAnnounce = 0;
    }, ANNOUNCE_EVERY_MS);
  }

  private showEmpty(): void {
    if (this.list.childElementCount > 0) return;
    const li = el('li', 'empty muted');
    li.textContent = t('chat.viewer.empty');
    this.list.append(li);
  }

  /** One row, or a "Message hidden" row when this entry cannot be built: the rest of the batch still shows. */
  private buildSafe(e: ChatEntry): HTMLLIElement {
    try {
      return this.build(e);
    } catch {
      this.stats.failed++;
      const li = el('li', 'msg hidden-msg');
      if (e.kind !== 'skip' && Number.isSafeInteger(e.s)) li.dataset.seq = String(e.s);
      const text = el('span', 'text muted');
      text.textContent = t('chat.viewer.hidden');
      text.title = t('chat.viewer.hidden.tip');
      li.append(text);
      return li;
    }
  }

  /** One row. Exported for tests through buildEntry(). */
  build(e: ChatEntry): HTMLLIElement {
    if (e.kind === 'skip') {
      const li = el('li', 'skipped muted');
      li.textContent = t('chat.viewer.skipped', { count: e.n });
      li.title = t('chat.viewer.skipped.tip');
      return li;
    }
    const li = el('li', e.kind === 'sys' ? 'msg sys' : 'msg');
    li.dataset.seq = String(e.s);
    if (this.opts.showTimes() && e.at > 0) {
      const time = el('time', 'at');
      time.dateTime = new Date(e.at).toISOString();
      time.textContent = clock(e.at);
      li.append(time);
    }
    if (e.kind === 'sys') {
      const text = el('bdi', 'text');
      text.textContent = translateWire(e.code, e.params, 'chat.sys.unknown');
      li.append(text);
      this.stats.rendered++;
      return li;
    }
    // The streamer's name may be "" (the translated default is shown instead).
    const nickOk = (e.author.r === 'streamer' && e.author.n === '') || checkChatInvariants(e.author.n, { maxGraphemes: CHAT_NICKNAME_MAX, maxEmoji: CHAT_NICKNAME_MAX });
    const textOk = e.text === undefined || checkChatInvariants(e.text);
    if (!nickOk || !textOk) {
      li.classList.add('hidden-msg');
      const text = el('span', 'text muted');
      text.textContent = t('chat.viewer.hidden');
      text.title = t('chat.viewer.hidden.tip');
      li.append(text);
      this.stats.hidden++;
      return li;
    }
    if (e.author.r === 'streamer') {
      li.classList.add('from-streamer');
      const badge = el('span', 'badge');
      badge.textContent = t('chat.badge.streamer');
      li.append(badge);
    }
    const nick = el('bdi', 'nick');
    nick.textContent = e.author.n || (e.author.r === 'streamer' ? t('chat.streamer') : '…');
    if (e.author.r !== 'streamer') {
      const c = isHexColor(e.author.c) ? e.author.c.toLowerCase() : defaultNameColor(e.author.a);
      nick.dataset.c = c;
      nick.dataset.a = e.author.a;
      nick.style.setProperty('--nick', this.opts.nickColor(c));
    }
    if (e.author.tag) nick.title = `${e.author.n} #${e.author.tag}`;
    const sep = el('span', 'sep');
    sep.textContent = ': ';
    const text = el('bdi', 'text');
    text.setAttribute('dir', 'auto');
    if (e.gif) {
      li.classList.add('has-gif');
      text.append(this.gifNode(e.gif));
    } else {
      this.fillText(text, e.text ?? '');
    }
    li.append(nick, sep, text);
    this.stats.rendered++;
    return li;
  }

  /** A GIF in a message: a consent placeholder, a play button or the image (never fetched before consent). */
  private gifNode(ref: GifRef): HTMLElement {
    const box = el('span', 'gif');
    box.dataset.gif = ref.p;
    this.gifRefs.set(box, ref);
    this.fillGif(box, ref, false);
    return box;
  }

  private fillGif(box: HTMLElement, ref: GifRef, play: boolean): void {
    box.replaceChildren();
    const url = gifMediaUrl(ref);
    const provider = GIF_PROVIDER_NAMES[ref.p] ?? ref.p;
    if (!url) {
      const chip = el('span', 'gif-chip');
      chip.textContent = t('chat.viewer.gif');
      box.append(chip);
      return;
    }
    const st = this.opts.gifs?.() ?? { consented: false, animate: false };
    if (!st.consented) {
      const b = el('button', 'gif-consent');
      b.type = 'button';
      b.textContent = t('chat.viewer.gif.placeholder', { provider });
      b.addEventListener('click', () => this.opts.onGifConsent?.());
      box.append(b);
      return;
    }
    if (!st.animate && !play) {
      this.playButton(box, ref);
      return;
    }
    const img = el('img', 'gif-img');
    img.alt = t('chat.viewer.gif');
    img.width = ref.w;
    img.height = ref.h;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.style.setProperty('--ar', `${ref.w} / ${ref.h}`);
    img.src = url;
    box.append(img);
    // Still in the list (or in the fragment about to be added): its row has a parent.
    this.liveGifs = this.liveGifs.filter((b) => b !== box && !!b.closest('li')?.parentNode);
    this.liveGifs.push(box);
    while (this.liveGifs.length > LIVE_GIFS_MAX) {
      const old = this.liveGifs.shift()!;
      const oldRef = this.gifRefs.get(old);
      if (oldRef) this.playButton(old, oldRef);
    }
  }

  private playButton(box: HTMLElement, ref: GifRef): void {
    box.replaceChildren();
    const b = el('button', 'gif-play');
    b.type = 'button';
    b.textContent = t('chat.viewer.gif.play');
    b.addEventListener('click', () => this.fillGif(box, ref, true));
    box.append(b);
  }

  /** Consent or "animate" changed: redraw every GIF in the list. */
  refreshGifs(): void {
    this.liveGifs = [];
    for (const box of this.list.querySelectorAll<HTMLElement>('span.gif')) {
      const ref = this.gifRefs.get(box);
      if (ref) this.fillGif(box, ref, false);
    }
  }

  private fillText(target: HTMLElement, text: string): void {
    const emotes = this.opts.emotes();
    for (const tok of tokenizeChat(text, new Set(emotes.keys()))) {
      if (tok.k === 'e') {
        const em = emotes.get(tok.code);
        if (em) {
          const img = el('img', 'emote');
          img.src = em.url;
          if (em.url2x) img.srcset = `${em.url2x} 2x`;
          img.alt = `:${tok.code}:`;
          img.title = `:${tok.code}:`;
          img.width = 28;
          img.height = 28;
          img.decoding = 'async';
          img.loading = 'lazy';
          img.draggable = false;
          target.append(img);
          continue;
        }
        target.append(document.createTextNode(`:${tok.code}:`));
      } else {
        // Text and emoji runs alike: a text node (emoji are drawn by the system font).
        target.append(document.createTextNode(tok.v));
      }
    }
  }
}

/** "37/200" for the input counter. */
export function counterText(count: number, max: number): string {
  return `${formatNumber(count)}/${formatNumber(max)}`;
}
