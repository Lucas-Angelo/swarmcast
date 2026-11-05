// The viewer chat (plan §5.4). Loaded as its own chunk by loader.ts, only when the live has the
// chat on, so the player never depends on it. Builds the chat column inside <aside id="chat">
// and wires the session (protocol state), the list, the input, the picker and the settings.
import './chat.css';
import { t } from '@swarmcast/shared/i18n';
import { CHAT_BG_DARK, CHAT_BG_LIGHT, CHAT_REACTIONS, cutQuote, GIF_KEY_RE, mixHex, mentionKeys, type ChatAuthor, type ChatPublicSettings, type ChatServerMessage, type ChatSnapshot, type ChatYou, type GifRef } from './core/index.js';
import type { GifConfig } from './gif-api.js';
import { createGifPicker } from './gif-picker.js';
import { backgroundOf, onThemeChange, NameColors, tokenColorAt } from './color-ui.js';
import { emoteTable, type Emote } from './emotes.js';
import { loadEmojiData } from './emoji-load.js';
import { ChatInput } from './input.js';
import { createPicker, type EmojiData } from './picker.js';
import { PollCard, pollBadge } from './poll.js';
import { createReactPicker, ReactionLayer, ReactionSender } from './reactions.js';
import { ChatOverlay, OVERLAY_SCRIM } from './overlay.js';
import type { OverlayHost } from '../overlay-mode.js';
import { animateGifs, loadPrefs, savePrefs, type ChatPrefs } from './prefs.js';
import { ChatList, GIF_PROVIDER_NAMES, mentionCandidates, type MessageEntry } from './render.js';
import { ChatSession, type ChatEntry, type ClientFrame, type ReplyEntry } from './session.js';
import { createSettingsPopover } from './settings-popover.js';

export interface MountOptions {
  root: HTMLElement;
  /** "Show chat" button outside the column (in the info row under the player). */
  showButton: HTMLButtonElement;
  /** The player container: reactions float over the video inside it (absent: they are not drawn). */
  player?: HTMLElement;
  /** The chat over the video in full screen (overlay-mode.ts; absent: never drawn). */
  overlay?: OverlayHost;
  /** The viewer's nickname (for their own messages before the roster has them). */
  nickname: string;
  sendFrame(msg: ClientFrame): boolean;
  /** Test seam: emoji data loader. */
  loadEmoji?: () => Promise<EmojiData>;
}

export interface ChatController {
  hello(snapshot: ChatSnapshot | undefined): void;
  /** Highest chat seq shown (sent as /control?chatAfter= on reconnect to get only the delta). */
  lastSeq(): number;
  frame(msg: ChatServerMessage): void;
  connection(open: boolean): void;
}

function nonce(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return ((a[0] ?? 1) % 0x7ffffffe) + 1;
}

/** Authors remembered for the @ list (only people whose messages this page got: never everyone watching). */
const MENTIONABLE_MAX = 500;

/** What a reply shows of the message it answers, cut as the server will cut it. */
function replyTo(e: MessageEntry): ReplyEntry {
  if (e.gif) return { s: e.s, author: e.author, gif: true };
  const { q, cut } = cutQuote(e.text ?? '');
  return { s: e.s, author: e.author, ...(q ? { quote: q } : {}), ...(cut ? { cut } : {}) };
}

const button = (cls: string, label: string, text: string): HTMLButtonElement => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.setAttribute('aria-label', label);
  b.title = label;
  b.textContent = text;
  return b;
};

export function mountChat(opts: MountOptions): ChatController {
  const { root, showButton } = opts;
  root.classList.add('chat');
  root.replaceChildren();
  root.setAttribute('aria-label', t('chat.viewer.title'));

  const head = document.createElement('header');
  head.className = 'chat-head';
  const title = document.createElement('h2');
  title.textContent = t('chat.viewer.title');
  const mode = document.createElement('span');
  mode.className = 'chat-mode muted small';
  mode.dataset.testid = 'chat-mode';
  const gear = button('chat-tool gear', t('chat.viewer.settings'), '⚙');
  gear.dataset.testid = 'chat-settings-button';
  const hide = button('chat-tool hide', t('chat.viewer.hide'), '✕');
  hide.title = t('chat.viewer.hide.tip');
  hide.dataset.testid = 'chat-hide';
  head.append(title, mode, gear, hide);

  const body = document.createElement('div');
  body.className = 'chat-body';

  // Assigned below; the parts built before it only read it from callbacks (or see null).
  let session: ChatSession | null = null;
  let prefs: ChatPrefs = loadPrefs();
  let emotes: Map<string, Emote> = emoteTable(true);
  const colors: NameColors = new NameColors(() => list.list);
  // A highlighted row sits on --sc-accent-soft (chat.css): its names are checked against that.
  const highlightColors: NameColors = new NameColors(
    () => list.list,
    (el) => tokenColorAt(el, '--sc-accent-soft') ?? backgroundOf(el),
  );
  const visible = (): boolean => !prefs.hidden && document.visibilityState !== 'hidden';
  const list: ChatList = new ChatList(body, {
    emotes: () => emotes,
    nickColor: (c, highlighted): string => (highlighted ? highlightColors : colors).paint(c),
    showTimes: () => prefs.times,
    visible,
    gifs: () => ({ consented: prefs.gifs, animate: animateGifs(prefs) }),
    onGifConsent: () => consentGifs(),
    onReply: (e) => input.setReply(replyTo(e)),
    me: () => session?.you?.a ?? null,
  });

  /** Authors of the messages this page got, oldest first (the @ list shows the newest first). */
  const writers = new Map<string, true>();
  const noteWriters = (entries: readonly ChatEntry[]): void => {
    for (const e of entries) {
      if (e.kind !== 'msg') continue;
      writers.delete(e.author.a);
      writers.set(e.author.a, true);
    }
    while (writers.size > MENTIONABLE_MAX) writers.delete(writers.keys().next().value as string);
  };
  /** The people the @ list may offer: who wrote, newest first, never this viewer. */
  const mentionable = (): ChatAuthor[] => {
    const me = session?.you?.a;
    const out: ChatAuthor[] = [];
    for (const a of [...writers.keys()].reverse()) {
      const au = session?.roster.get(a);
      if (au && a !== me) out.push(au);
    }
    return out;
  };

  let connected = false;
  const input = new ChatInput({
    settings: () => session?.settings ?? null,
    you: () => session?.you ?? null,
    connected: () => connected,
    send: (text, reply) => {
      const you = session?.you;
      if (!session || !you) return null;
      const n = nonce();
      // The people this text mentions, by author key; the server checks every one of them again.
      const mn = mentionKeys(text, mentionCandidates(mentionable()), you.a);
      if (!session.send({ t: 'chat.send', n, text, ...(reply ? { re: reply.s } : {}), ...(mn.length ? { mn } : {}) })) return null;
      const me: ChatAuthor = session.roster.get(you.a) ?? { a: you.a, n: opts.nickname, c: you.color, r: 'viewer' };
      list.addPending(n, text, me, undefined, reply ?? undefined);
      return n;
    },
    mentionable,
  });

  const pickerButton = document.createElement('button');
  const picker = createPicker(pickerButton, {
    emotes: () => (session?.settings?.content.includes('emotes') ? [...emotes.values()] : []),
    emojiAllowed: () => !!session?.settings?.content.includes('emotes'),
    load: opts.loadEmoji ?? loadEmojiData,
    onPick: (text) => input.insert(text),
  });
  input.tools.append(pickerButton);

  /** The streamer's GIF settings while viewers may send GIFs (consent is always asked: no "auto"). */
  const gifConfig = (): GifConfig | null => {
    const s = session?.settings;
    const g = s?.gif;
    if (!s?.enabled || !s.content.includes('gifs') || !g || !GIF_KEY_RE.test(g.key)) return null;
    return { provider: g.provider, key: g.key, rating: g.rating };
  };
  const me = (): ChatAuthor | null => {
    const you = session?.you;
    return you ? (session?.roster.get(you.a) ?? { a: you.a, n: opts.nickname, c: you.color, r: 'viewer' }) : null;
  };
  const sendGif = (gif: GifRef): void => {
    const author = me();
    if (!session || !author) return;
    const n = nonce();
    const reply = input.replyingTo;
    if (!session.send({ t: 'chat.send', n, gif, ...(reply ? { re: reply.s } : {}) })) return;
    input.noteSent(n);
    input.setReply(null, false);
    list.addPending(n, '', author, gif, reply ?? undefined);
  };
  const consentGifs = (): void => {
    prefs = savePrefs({ gifs: true });
    list.refreshGifs();
    applyGifs();
  };
  const gifButton = document.createElement('button');
  const gifPicker = createGifPicker(gifButton, {
    config: gifConfig,
    consented: () => prefs.gifs,
    consent: () => consentGifs(),
    onPick: sendGif,
  });
  input.tools.append(gifButton);
  const applyGifs = (): void => {
    gifPicker.update();
    const cfg = gifConfig();
    settingsPop.setGifs(cfg ? { provider: GIF_PROVIDER_NAMES[cfg.provider], consented: prefs.gifs, animate: animateGifs(prefs) } : null);
  };

  // Reactions over the video (docs/CHAT.md, "Reactions"): the React button in the tools, the sender
  // of this page's taps, and the layer inside the player that draws everyone's reactions.
  const reduceMotion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const layer = opts.player ? new ReactionLayer(opts.player, { reduced: () => reduceMotion?.matches === true, pageVisible: () => document.visibilityState !== 'hidden' }) : null;
  const sender = new ReactionSender({ send: (c) => session?.send({ t: 'chat.react', c }) ?? false });
  const reactButton = document.createElement('button');
  const reactPicker = createReactPicker(reactButton, {
    onTap: (i) => {
      if (!reactAllowed() || !sender.tap(i)) return;
      // The page's own tap floats at once; the server's counts for this window leave it out.
      layer?.show(CHAT_REACTIONS.map((_, k) => (k === i ? 1 : 0)));
    },
  });
  input.tools.append(reactButton);
  /** This viewer may react now: the streamer has reactions on (and the chat on), and they are not muted or still waiting. */
  const reactAllowed = (): boolean => {
    const s = session?.settings;
    const you = session?.you;
    if (!layer || !s?.enabled || s.reactions !== true || !you || !connected) return false;
    if (you.mutedUntil === 'live' || (typeof you.mutedUntil === 'number' && you.mutedUntil > Date.now())) return false;
    return !(typeof you.waitUntil === 'number' && you.waitUntil > Date.now());
  };
  /** A timed mute or the new-viewer wait ends by itself: the React button comes back then. */
  let reactWait: ReturnType<typeof setTimeout> | null = null;
  const applyReactions = (): void => {
    const s = session?.settings;
    const allowed = reactAllowed();
    if (reactWait) clearTimeout(reactWait);
    reactWait = null;
    const you = session?.you;
    const until = Math.max(typeof you?.mutedUntil === 'number' ? you.mutedUntil : 0, you?.waitUntil ?? 0);
    if (!allowed && until > Date.now()) reactWait = setTimeout(applyReactions, Math.min(until - Date.now() + 50, 2 ** 31 - 1));
    reactButton.hidden = !allowed;
    if (!allowed) {
      reactPicker.popover.close();
      sender.reset();
    }
    settingsPop.setReactions(!!layer && s?.enabled === true && s.reactions === true);
    // Drawn while the viewer wants them and the chat is on and shown ("hide chat" means no chat).
    layer?.setEnabled(prefs.reactions && !prefs.hidden && s?.enabled === true && s.reactions === true);
  };

  const settingsPop = createSettingsPopover(gear, {
    onColor: (color) => {
      session?.send({ t: 'chat.color', color });
    },
    onPrefs: (p) => {
      const gifsChanged = p.gifs !== prefs.gifs || p.animate !== prefs.animate;
      prefs = p;
      applyPrefs();
      if (gifsChanged) {
        list.refreshGifs();
        applyGifs();
      }
    },
  });

  // The poll card (docs/CHAT.md, "Polls and predictions"): under the pinned bar, above the list.
  const pollCard = new PollCard({
    vote: (id, o) => {
      if (!session) return null;
      const n = nonce();
      return session.send({ t: 'chat.vote', n, id, o }) ? n : null;
    },
    you: () => session?.you ?? null,
    // The same width as chat.css's phone rules: the chat under the player has room for a few lines.
    compact: () => typeof matchMedia === 'function' && matchMedia('(max-width: 720px)').matches,
  });

  // The pinned bar sits between the header and the list, never over the list or the input; the
  // poll card under it.
  root.append(head, list.pinned, pollCard.root, body, input.form, picker.panel, gifPicker.panel, reactPicker.panel, settingsPop.popover.panel);

  // The chat over the video in full screen (docs/CHAT.md, "Chat over the video"): the latest lines
  // over the picture, and the chat's own message box moved there while the viewer writes. Names
  // are made readable against the lightest the lines' scrim gets (over a white picture).
  const overlayColors = new NameColors(
    () => opts.player ?? null,
    (el) => mixHex(tokenColorAt(el, '--video-bg') ?? CHAT_BG_DARK, tokenColorAt(el, '--on-video') ?? CHAT_BG_LIGHT, OVERLAY_SCRIM),
  );
  const overlay: ChatOverlay | null =
    opts.player && opts.overlay
      ? new ChatOverlay({
          player: opts.player,
          line: (e) => list.overlayLine(e, (c) => overlayColors.paint(c)),
          moveInput: (host) => {
            reactPicker.popover.close();
            if (host) host.append(input.form, reactPicker.panel);
            else {
              root.insertBefore(input.form, picker.panel);
              root.insertBefore(reactPicker.panel, settingsPop.popover.panel);
            }
          },
          focusInput: () => input.textarea.focus(),
        })
      : null;
  opts.overlay?.setInputOpener(() => overlay?.openInput() ?? false);
  opts.overlay?.subscribe(() => overlay?.setActive(opts.overlay?.active === true));

  const applyPrefs = (): void => {
    root.classList.toggle('large', prefs.large);
    list.setMentionHighlight(prefs.mentions);
    root.classList.toggle('times', prefs.times);
    const hidden = prefs.hidden;
    document.body.classList.toggle('chat-hidden', hidden);
    const active = session?.active ?? false;
    root.hidden = hidden || !active;
    showButton.hidden = !hidden || !active;
    if (!hidden) list.resume();
    applyReactions();
    overlay?.root.classList.toggle('mention-highlight', prefs.mentions);
    // Over the video only while there is a chat to show ("hide chat" means no chat there either).
    opts.overlay?.setAvailable(active && !hidden && session?.settings?.enabled === true);
    overlay?.setActive(opts.overlay?.active === true);
  };

  const applySettings = (s: ChatPublicSettings | null): void => {
    emotes = emoteTable(s?.builtinEmotes !== false);
    list.setPinAllowed(s?.enabled === true);
    pollCard.setAllowed(s?.enabled === true);
    pickerButton.hidden = !s?.content.includes('emotes');
    if (pickerButton.hidden) picker.popover.close();
    applyGifs();
    const secs = s ? t('time.secondsShort', { count: s.slowS }) : '';
    mode.textContent = s?.enabled && s.slowS > 0 ? t(s.autoSlow ? 'chat.viewer.mode.slowAuto' : 'chat.viewer.mode.slow', { seconds: secs }) : '';
    mode.title = s?.enabled && s.slowS > 0 ? t(s.autoSlow ? 'chat.viewer.slowAuto' : 'chat.viewer.slow', { seconds: secs }) : '';
    mode.hidden = mode.textContent === '';
    document.body.classList.toggle('has-chat', s !== null);
    applyYou(session?.you ?? null);
    applyPrefs();
    input.update();
  };

  const applyYou = (you: ChatYou | null): void => {
    const s = session?.settings;
    if (!you || !s || s.colors !== 'choose') settingsPop.setColor(null);
    else settingsPop.setColor({ color: you.color, nick: session?.roster.get(you.a)?.n ?? opts.nickname, locked: you.colorLocked });
    input.update();
    pollCard.update();
    applyReactions();
  };

  const chatSession: ChatSession = new ChatSession(
    {
      reset: (entries) => {
        writers.clear();
        noteWriters(entries);
        list.reset(entries);
        overlay?.reset(entries);
      },
      append: (entries) => {
        noteWriters(entries);
        list.append(entries);
        overlay?.add(entries);
      },
      remove: (seqs) => {
        input.dropReply((s) => seqs.includes(s));
        list.remove(seqs);
        overlay?.remove(seqs);
      },
      clearUpTo: (s) => {
        input.dropReply((r) => r <= s);
        list.clearUpTo(s);
        overlay?.clearUpTo(s);
      },
      highlight: (s, on) => list.highlight(s, on),
      pin: (p) => list.setPin(p),
      poll: (p) => pollCard.set(p),
      tally: (id, c) => pollCard.tally(id, c),
      voted: (n, id, o) => pollCard.voted(n, id, o),
      reactions: (c) => layer?.show(sender.others(c)),
      author: (a) => {
        list.recolor(a);
        if (a.a === chatSession.you?.a) applyYou(chatSession.you);
      },
      settings: (s) => applySettings(s),
      you: (y) => applyYou(y),
      ack: (n, s) => {
        list.ack(n, s);
        input.acked(n);
      },
      reject: (n, code, params, retryMs) => {
        // A refused vote is the poll card's (its own nonces); everything else is a message's.
        if (pollCard.rejected(n, code, params)) return;
        // Without `n` the server refused the frame before reading it: it is the oldest send.
        const nonce = n ?? input.oldestPending();
        list.reject(nonce);
        input.rejected(nonce, code, params, retryMs);
      },
      unsupported: () => {
        chatSession.settings = null;
        opts.overlay?.setAvailable(false);
        overlay?.setActive(false);
        pollCard.setAllowed(false);
        root.hidden = false;
        input.form.hidden = true;
        list.reset([]);
        const p = document.createElement('p');
        p.className = 'chat-status';
        p.textContent = t('chat.viewer.reload');
        body.replaceChildren(p);
      },
      connection: (open) => {
        connected = open;
        input.update();
        applyReactions();
      },
    },
    opts.sendFrame,
  );
  session = chatSession;

  hide.addEventListener('click', () => {
    prefs = savePrefs({ hidden: true });
    settingsPop.popover.close();
    picker.popover.close();
    applyPrefs();
    updateShowLabel();
    showButton.focus();
  });
  showButton.addEventListener('click', () => {
    prefs = savePrefs({ hidden: false });
    unseen = 0;
    mentionsUnseen = 0;
    pinUnseen = false;
    updateShowLabel();
    applyPrefs();
    list.scrollToEnd();
    input.textarea.focus();
  });
  list.onUnread = () => updateShowLabel();
  let unseen = 0;
  /** Messages that mention this viewer, come while the chat was hidden (no sound: only this count). */
  let mentionsUnseen = 0;
  /** A new pin came while the chat was hidden: "Show chat" says so until the chat is shown. */
  let pinUnseen = false;
  pollCard.onChange = () => updateShowLabel();
  list.onPin = (p, fresh) => {
    if (fresh && prefs.hidden) pinUnseen = true;
    if (!p) pinUnseen = false;
    updateShowLabel();
  };
  const updateShowLabel = (): void => {
    showButton.textContent = t('chat.viewer.show');
    // A poll or prediction is open: "Show chat" says so while the chat is hidden.
    const poll = prefs.hidden ? pollBadge(pollCard.current) : null;
    if (poll) {
      const badge = document.createElement('span');
      badge.className = 'chat-unread';
      badge.dataset.testid = 'chat-show-poll';
      badge.textContent = poll;
      showButton.append(' ', badge);
    }
    if (prefs.hidden && pinUnseen) {
      const badge = document.createElement('span');
      badge.className = 'chat-unread';
      badge.dataset.testid = 'chat-show-pinned';
      badge.textContent = t('chat.viewer.pinned.badge');
      showButton.append(' ', badge);
    }
    if (prefs.hidden && mentionsUnseen > 0 && prefs.mentions) {
      const badge = document.createElement('span');
      badge.className = 'chat-unread';
      badge.dataset.testid = 'chat-show-mentions';
      badge.textContent = t('chat.viewer.mentions', { count: mentionsUnseen > 99 ? 99 : mentionsUnseen });
      showButton.append(' ', badge);
    }
    if (prefs.hidden && unseen > 0) {
      const badge = document.createElement('span');
      badge.className = 'chat-unread';
      badge.textContent = t('chat.viewer.unread', { count: unseen > 99 ? 99 : unseen });
      showButton.append(' ', badge);
    }
  };
  updateShowLabel();
  document.addEventListener('visibilitychange', () => list.resume());
  onThemeChange(() => {
    colors.invalidate();
    highlightColors.invalidate();
    overlayColors.invalidate();
    list.recolor();
  });

  (window as unknown as { __swarmcastChat: unknown }).__swarmcastChat = {
    get stats() {
      return { ...list.stats, lastSeq: chatSession.lastSeq, reactions: { alive: layer?.alive ?? 0, spawned: layer?.spawned ?? 0, peak: layer?.peak ?? 0 }, overlay: { active: overlay?.active ?? false, lines: overlay?.count ?? 0, writing: overlay?.writing ?? false } };
    },
  };

  return {
    hello: (snapshot) => chatSession.hello(snapshot),
    lastSeq: () => chatSession.lastSeq,
    frame: (msg) => {
      if (msg.t === 'chat.batch' && prefs.hidden) {
        const me = chatSession.you?.a;
        unseen += msg.items.filter((i) => i.k === 'm').length;
        mentionsUnseen += msg.items.filter((i) => i.k === 'm' && me !== undefined && Array.isArray(i.mn) && i.mn.includes(me)).length;
        updateShowLabel();
      }
      chatSession.frame(msg);
    },
    connection: (open) => chatSession.connection(open),
  };
}

