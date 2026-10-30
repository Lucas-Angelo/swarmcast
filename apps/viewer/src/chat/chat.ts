// The viewer chat (plan §5.4). Loaded as its own chunk by loader.ts, only when the live has the
// chat on, so the player never depends on it. Builds the chat column inside <aside id="chat">
// and wires the session (protocol state), the list, the input, the picker and the settings.
import './chat.css';
import { t } from '@swarmcast/shared/i18n';
import { GIF_KEY_RE, type ChatAuthor, type ChatPublicSettings, type ChatServerMessage, type ChatSnapshot, type ChatYou, type GifRef } from './core/index.js';
import type { GifConfig } from './gif-api.js';
import { createGifPicker } from './gif-picker.js';
import { onThemeChange, NameColors } from './color-ui.js';
import { emoteTable, type Emote } from './emotes.js';
import { loadEmojiData } from './emoji-load.js';
import { ChatInput } from './input.js';
import { createPicker, type EmojiData } from './picker.js';
import { animateGifs, loadPrefs, savePrefs, type ChatPrefs } from './prefs.js';
import { ChatList, GIF_PROVIDER_NAMES } from './render.js';
import { ChatSession, type ClientFrame } from './session.js';
import { createSettingsPopover } from './settings-popover.js';

export interface MountOptions {
  root: HTMLElement;
  /** "Show chat" button outside the column (in the bar under the player). */
  showButton: HTMLButtonElement;
  /** The viewer's nickname (for their own messages before the roster has them). */
  nickname: string;
  sendFrame(msg: ClientFrame): boolean;
  /** Test seam: emoji data loader. */
  loadEmoji?: () => Promise<EmojiData>;
}

export interface ChatController {
  hello(snapshot: ChatSnapshot | undefined): void;
  frame(msg: ChatServerMessage): void;
  connection(open: boolean): void;
}

function nonce(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return ((a[0] ?? 1) % 0x7ffffffe) + 1;
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
  const visible = (): boolean => !prefs.hidden && document.visibilityState !== 'hidden';
  const list: ChatList = new ChatList(body, {
    emotes: () => emotes,
    nickColor: (c): string => colors.paint(c),
    showTimes: () => prefs.times,
    visible,
    gifs: () => ({ consented: prefs.gifs, animate: animateGifs(prefs) }),
    onGifConsent: () => consentGifs(),
  });

  let connected = false;
  const input = new ChatInput({
    settings: () => session?.settings ?? null,
    you: () => session?.you ?? null,
    connected: () => connected,
    send: (text) => {
      const you = session?.you;
      if (!session || !you) return null;
      const n = nonce();
      if (!session.send({ t: 'chat.send', n, text })) return null;
      const me: ChatAuthor = session.roster.get(you.a) ?? { a: you.a, n: opts.nickname, c: you.color, r: 'viewer' };
      list.addPending(n, text, me);
      return n;
    },
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
    if (!session.send({ t: 'chat.send', n, gif })) return;
    input.noteSent(n);
    list.addPending(n, '', author, gif);
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

  root.append(head, body, input.form, picker.panel, gifPicker.panel, settingsPop.popover.panel);

  const applyPrefs = (): void => {
    root.classList.toggle('large', prefs.large);
    root.classList.toggle('times', prefs.times);
    const hidden = prefs.hidden;
    document.body.classList.toggle('chat-hidden', hidden);
    const active = session?.active ?? false;
    root.hidden = hidden || !active;
    showButton.hidden = !hidden || !active;
    if (!hidden) list.resume();
  };

  const applySettings = (s: ChatPublicSettings | null): void => {
    emotes = emoteTable(s?.builtinEmotes !== false);
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
  };

  const chatSession: ChatSession = new ChatSession(
    {
      reset: (entries) => list.reset(entries),
      append: (entries) => list.append(entries),
      remove: (seqs) => list.remove(seqs),
      clearUpTo: (s) => list.clearUpTo(s),
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
        // Without `n` the server refused the frame before reading it: it is the oldest send.
        const nonce = n ?? input.oldestPending();
        list.reject(nonce);
        input.rejected(nonce, code, params, retryMs);
      },
      unsupported: () => {
        chatSession.settings = null;
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
    showButton.focus();
  });
  showButton.addEventListener('click', () => {
    prefs = savePrefs({ hidden: false });
    unseen = 0;
    updateShowLabel();
    applyPrefs();
    list.scrollToEnd();
    input.textarea.focus();
  });
  list.onUnread = () => updateShowLabel();
  let unseen = 0;
  const updateShowLabel = (): void => {
    showButton.textContent = t('chat.viewer.show');
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
    list.recolor();
  });

  (window as unknown as { __swarmcastChat: unknown }).__swarmcastChat = {
    get stats() {
      return { ...list.stats, lastSeq: chatSession.lastSeq };
    },
  };

  return {
    hello: (snapshot) => chatSession.hello(snapshot),
    frame: (msg) => {
      if (msg.t === 'chat.batch' && prefs.hidden) {
        unseen += msg.items.filter((i) => i.k === 'm').length;
        updateShowLabel();
      }
      chatSession.frame(msg);
    },
    connection: (open) => chatSession.connection(open),
  };
}

