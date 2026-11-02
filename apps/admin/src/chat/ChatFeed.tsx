import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ChatAuthor, ChatMessageItem, ChatPin, ChatSystemItem, GifRef } from '@swarmcast/shared';
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
  /** The newest seq the feed has followed to (or flagged as "New messages below"). */
  const followed = useRef(view.lastSeq);

  // Follow new messages unless the streamer scrolled up to read, or has a ⋯ menu open: scrolling
  // then would move the menu's buttons under the pointer between aiming and clicking (a click on
  // "Remove highlight" could land on another button). The feed holds still and says there is more
  // below; it follows again when the menu closes.
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    if (open !== null) {
      if (view.lastSeq !== followed.current) setBelow(true);
      return;
    }
    followed.current = view.lastSeq;
    if (stick.current) {
      el.scrollTop = el.scrollHeight;
      setBelow(false);
    } else setBelow(true);
  }, [view.rev, open]);

  const onScroll = (): void => {
    const el = list.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (stick.current) setBelow(false);
  };

  return (
    <div class="chat-feed">
      {view.pin && <PinnedBar pin={view.pin} until={view.pinUntil} author={view.roster.get(view.pin.a)} dark={dark} />}
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

/**
 * Badge, name and text of a message (a feed row or the pinned bar), with the viewer's safety rules:
 * the badge from the role, never the name; name and text in `<bdi>`; text that fails the shared
 * invariants is not shown.
 */
function MessageBody({ body, author, dark }: { body: { x?: string; g?: GifRef }; author: ChatAuthor | undefined; dark: boolean }) {
  const streamer = author?.r === 'streamer';
  const nickname = author?.n ?? '?';
  const tokens = body.x === undefined ? null : messageTokens(body.x);
  return (
    <>
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
        {body.g ? (
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
    </>
  );
}

/** The pinned message on top of the feed, as viewers see it on top of their chat, with Unpin. */
function PinnedBar({ pin, until, author, dark }: { pin: ChatPin; until: number | null; author: ChatAuthor | undefined; dark: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const unpin = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      await chatApi.unpin();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="chat-pinned" aria-label={t('admin.chat.pinned')} data-testid="chat-pinned" data-seq={pin.s}>
      <div class="row tight chat-pinned-head">
        <span class="sc-ico-pin" aria-hidden="true" />
        <span class="small strong">{t('admin.chat.pinned')}</span>
        {until !== null && <span class="muted small">{t('admin.chat.pinned.until', { clock: clockOf(until) })}</span>}
        <span class="spacer" />
        <button type="button" class="small" data-testid="chat-pinned-unpin" title={t('admin.chat.unpin.tip')} disabled={busy} onClick={() => void unpin()}>
          {t('admin.chat.unpin')}
        </button>
      </div>
      <div class="chat-line">
        <MessageBody body={pin} author={author} dark={dark} />
      </div>
      {err !== null && <div class="err small">{errorText(err)}</div>}
    </section>
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
  const highlighted = item.h === 1;
  const pinned = view.pin?.s === item.s;
  return (
    <li class={`chat-msg${streamer ? ' chat-msg-streamer' : ''}${highlighted ? ' chat-msg-highlighted' : ''}`} data-seq={item.s} data-testid="chat-msg">
      {/* The menu button sits next to the clipped text, never inside it: a long name or message cannot push it out of reach. */}
      <div class="chat-row">
        <div class="chat-line">
          <span class="chat-time muted small">{clockOf(item.at)}</span>
          {highlighted && (
            <span class="chat-mark" data-testid="chat-highlighted">
              {t('admin.chat.highlighted')}
            </span>
          )}
          {pinned && (
            <span class="chat-mark" data-testid="chat-pinned-mark">
              <span class="sc-ico-pin" aria-hidden="true" /> {t('admin.chat.pinned')}
            </span>
          )}
          <MessageBody body={item} author={author} dark={dark} />
        </div>
        <button type="button" class="small chat-more" aria-expanded={open} aria-label={t('admin.chat.menu.for', { nickname })} title={t('admin.chat.menu.tip')} data-testid="chat-more" onClick={onToggle}>
          ⋯
        </button>
      </div>
      {open && <ModerationMenu nickname={nickname} sessionId={streamer ? undefined : sessionId} seq={item.s} highlighted={highlighted} pinned={pinned} info={info} onClose={onToggle} />}
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
