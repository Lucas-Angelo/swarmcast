import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ChatAuthor, ChatMessageItem, ChatSystemItem } from '@swarmcast/shared';
import { t } from '@swarmcast/shared/i18n';
import { chatApi, errorText } from '../api.js';
import { Info } from '../Info.js';
import { clockOf } from './hooks.js';
import { draftLength, messageTokens, readableName, systemText } from './logic.js';
import { ModerationMenu } from './ModerationMenu.js';
import type { ChatView } from './store.js';

/**
 * The chat as the streamer sees it: every message (also those skipped for slow viewers), the
 * same safety rules as the viewer's renderer (plan §2.4: text nodes only, `<bdi>` around names
 * and text, clipped boxes, links never clickable, the badge from the role and never the name),
 * a menu per row and the "Send as …" box.
 */
export function ChatFeed({ view, dark, maxGraphemes, streamerName, enabled }: { view: ChatView; dark: boolean; maxGraphemes: number; streamerName: string; enabled: boolean }) {
  const list = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  const [below, setBelow] = useState(false);
  const [open, setOpen] = useState<number | null>(null);

  // Follow new messages unless the streamer scrolled up to read.
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else setBelow(true);
  }, [view.rev]);

  const onScroll = (): void => {
    const el = list.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (stick.current) setBelow(false);
  };

  return (
    <div class="chat-feed">
      <ol class="chat-list" ref={list} onScroll={onScroll} aria-live="polite" aria-label={t('admin.chat.feed')} data-testid="chat-feed">
        {view.items.length === 0 && <li class="chat-empty muted small">{t('admin.chat.feed.empty')}</li>}
        {view.items.map((it) =>
          it.k === 'sys' ? (
            <SystemLine key={`s${it.s}`} item={it} />
          ) : (
            <MessageRow
              key={`m${it.s}`}
              item={it}
              author={view.roster.get(it.a)}
              sessionId={view.sessions.get(it.a)}
              view={view}
              dark={dark}
              open={open === it.s}
              onToggle={() => setOpen(open === it.s ? null : it.s)}
            />
          ),
        )}
      </ol>
      {below && (
        <button
          type="button"
          class="small chat-below"
          onClick={() => {
            stick.current = true;
            setBelow(false);
            if (list.current) list.current.scrollTop = list.current.scrollHeight;
          }}
        >
          {t('admin.chat.feed.newBelow')}
        </button>
      )}
      <SendBox maxGraphemes={maxGraphemes} streamerName={streamerName} enabled={enabled} />
    </div>
  );
}

function SystemLine({ item }: { item: ChatSystemItem }) {
  return (
    <li class="chat-sys muted small" data-seq={item.s} data-testid="chat-sys">
      <span class="chat-time">{clockOf(item.at)}</span> {systemText(item)}
    </li>
  );
}

function MessageRow({
  item,
  author,
  sessionId,
  view,
  dark,
  open,
  onToggle,
}: {
  item: ChatMessageItem;
  author: ChatAuthor | undefined;
  sessionId: string | undefined;
  view: ChatView;
  dark: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const streamer = author?.r === 'streamer';
  const nickname = author?.n ?? '?';
  const info = sessionId ? view.info.get(sessionId) : undefined;
  const tokens = item.x === undefined ? null : messageTokens(item.x);
  return (
    <li class={`chat-msg${streamer ? ' chat-msg-streamer' : ''}`} data-seq={item.s} data-testid="chat-msg">
      {/* The menu button sits next to the clipped text, never inside it: a long name or message cannot push it out of reach. */}
      <div class="chat-row">
        <div class="chat-line">
          <span class="chat-time muted small">{clockOf(item.at)}</span>
          {/* The badge comes from the role the server assigned, never from the nickname. */}
          {streamer && (
            <span class="chat-badge" data-testid="chat-badge">
              {t('chat.badge.streamer')}
            </span>
          )}
          {/* The look-alike tag tells apart two similar names: shown on hover, not in every row. */}
          <bdi class="chat-nick" title={author?.tag && !streamer ? `#${author.tag}` : undefined} style={author ? { color: readableName(author.c, dark) } : undefined}>
            {nickname}
          </bdi>
          <span class="chat-sep">: </span>
          <bdi class="chat-text" dir="auto">
            {item.g ? (
              <span class="chat-gif" title={t('admin.chat.msg.gif.tip')}>
                {t('admin.chat.msg.gif')}
              </span>
            ) : tokens === null ? (
              <span class="muted">{t('admin.chat.msg.hidden')}</span>
            ) : (
              tokens.map((tk, i) =>
                tk.k === 'e' ? (
                  <span key={i} class="chat-emote" title={t('admin.chat.msg.emote.tip', { code: tk.code })}>
                    :{tk.code}:
                  </span>
                ) : (
                  tk.v
                ),
              )
            )}
          </bdi>
        </div>
        <button type="button" class="small chat-more" aria-expanded={open} aria-label={t('admin.chat.menu.for', { nickname })} title={t('admin.chat.menu.tip')} data-testid="chat-more" onClick={onToggle}>
          ⋯
        </button>
      </div>
      {open && <ModerationMenu nickname={nickname} sessionId={streamer ? undefined : sessionId} seq={item.s} info={info} onClose={onToggle} />}
    </li>
  );
}

function SendBox({ maxGraphemes, streamerName, enabled }: { maxGraphemes: number; streamerName: string; enabled: boolean }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const { count, over } = draftLength(text, maxGraphemes);
  const name = streamerName || t('chat.streamer');
  useEffect(() => setErr(null), [text]);

  const send = async (): Promise<void> => {
    if (!text.trim() || over || busy) return;
    setBusy(true);
    try {
      await chatApi.send(text);
      setText('');
    } catch (e) {
      // The text stays in the box so it can be fixed and sent again.
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      class="chat-send"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <div class="row tight">
        <input
          type="text"
          class="text-input chat-input"
          data-testid="chat-input"
          placeholder={t('admin.chat.send.placeholder', { name })}
          aria-label={t('admin.chat.send.placeholder', { name })}
          aria-invalid={over}
          value={text}
          disabled={!enabled}
          onInput={(e) => setText((e.target as HTMLInputElement).value)}
        />
        <button type="submit" class="primary" data-testid="chat-send" disabled={!enabled || busy || over || !text.trim()} title={t('admin.chat.send.tip')}>
          {t('admin.chat.send')}
        </button>
        <Info text={t('admin.chat.send.tip')} />
      </div>
      <div class="row tight small">
        <span class={over ? 'danger-text' : 'muted'} data-testid="chat-count">
          {t('admin.chat.send.counter', { count, max: maxGraphemes })}
        </span>
        {err !== null && (
          <span class="danger-text" role="alert" data-testid="chat-send-error">
            {errorText(err)}
          </span>
        )}
      </div>
    </form>
  );
}
