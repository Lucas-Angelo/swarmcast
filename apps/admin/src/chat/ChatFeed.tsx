import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { applyMention, checkChatInvariants, CHAT_NICKNAME_MAX, mentionKeys, mentionQuery, suggestMentions, type ChatAuthor, type ChatMessageItem, type ChatPin, type ChatReplyRef, type ChatSystemItem, type ChatToken, type GifRef } from '@swarmcast/shared';
import { t } from '@swarmcast/shared/i18n';
import { chatApi, errorText } from '../api.js';
import { Info } from '../Info.js';
import { clockOf } from './hooks.js';
import { draftLength, mentionableAuthors, mentionCandidates, messageParts, readableName, replyPreview, streamerKey, systemText } from './logic.js';
import { ModerationMenu } from './ModerationMenu.js';
import type { ChatView } from './store.js';

/**
 * The chat as the streamer sees it: every message (also those skipped for slow viewers), the
 * same safety rules as the viewer's renderer (plan §2.4: text nodes only, `<bdi>` around names
 * and text, clipped boxes, links never clickable, the badge from the role and never the name),
 * a menu per row and the "Send as …" box.
 *
 * Replies and mentions (docs/CHAT.md, "Replies and mentions"): a reply shows the quote the server
 * sent above it; Reply in the ⋯ menu puts "Replying to …" over the box; "@" in the box lists the
 * people who wrote in the chat (with their tag, to tell look-alike names apart); a message that
 * mentions the streamer is marked.
 */
export function ChatFeed({ view, dark, maxGraphemes, streamerName, enabled }: { view: ChatView; dark: boolean; maxGraphemes: number; streamerName: string; enabled: boolean }) {
  const list = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  const [below, setBelow] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [replyTo, setReplyTo] = useState<ChatMessageItem | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const me = streamerKey(view.roster);
  // The message being answered left the feed (deleted, cleared): the reply is cancelled.
  useEffect(() => {
    if (replyTo && !view.items.some((x) => x.k === 'm' && x.s === replyTo.s)) setReplyTo(null);
  }, [view.rev]);
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
              me={me}
              open={open === it.s}
              onToggle={() => setOpen(open === it.s ? null : it.s)}
              onReply={() => {
                setReplyTo(it);
                setOpen(null);
                input.current?.focus();
              }}
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
      <SendBox maxGraphemes={maxGraphemes} streamerName={streamerName} enabled={enabled} view={view} replyTo={replyTo} onCancelReply={() => setReplyTo(null)} input={input} />
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
function MessageBody({ body, author, dark, mentioned = [], me }: { body: { x?: string; g?: GifRef }; author: ChatAuthor | undefined; dark: boolean; mentioned?: readonly ChatAuthor[]; me?: string | undefined }) {
  const streamer = author?.r === 'streamer';
  const nickname = author?.n ?? '?';
  const parts = body.x === undefined ? null : messageParts(body.x, mentioned);
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
        ) : parts === null ? (
          <span class="muted">{t('admin.chat.msg.hidden')}</span>
        ) : (
          parts.map((p, i) =>
            p.mention ? (
              <span key={i} class={`chat-mention${p.mention === me ? ' me' : ''}`}>
                <Tokens tokens={p.tokens} />
              </span>
            ) : (
              <Tokens key={i} tokens={p.tokens} />
            ),
          )
        )}
      </bdi>
    </>
  );
}

function Tokens({ tokens }: { tokens: readonly ChatToken[] }) {
  return (
    <>
      {tokens.map((tk, i) =>
        tk.k === 'e' ? (
          <span key={i} class="chat-emote" title={t('admin.chat.msg.emote.tip', { code: tk.code })}>
            :{tk.code}:
          </span>
        ) : (
          tk.v
        ),
      )}
    </>
  );
}

/**
 * The quote line of a reply: whom it answers and the server's quote (or "Original message deleted"),
 * name and quote each in a <bdi>, the quote checked like any text.
 */
function ReplyQuote({ re, author }: { re: ChatReplyRef; author: ChatAuthor | undefined }) {
  const nickname = author?.n || (author?.r === 'streamer' ? t('chat.streamer') : '?');
  const quote = re.gone === 1 ? t('admin.chat.reply.gone') : re.gif === 1 ? t('admin.chat.msg.gif') : typeof re.q === 'string' && checkChatInvariants(re.q, { maxGraphemes: 40, maxEmoji: 40 }) ? `${re.q}${re.cut === 1 ? '…' : ''}` : null;
  return (
    <div class={`chat-quote muted small${re.gone === 1 ? ' gone' : ''}`} data-testid="chat-reply-quote" aria-label={t('admin.chat.reply.quote', { nickname, text: quote ?? '' })}>
      <span class="sc-ico-reply" aria-hidden="true" />
      <bdi class="chat-quote-nick">{nickname}</bdi>
      {quote !== null && (
        <>
          <span>: </span>
          <bdi class="chat-quote-text" dir="auto">
            {quote}
          </bdi>
        </>
      )}
    </div>
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
  me,
  open,
  onToggle,
  onReply,
}: {
  item: ChatMessageItem;
  author: ChatAuthor | undefined;
  sessionId: string | undefined;
  view: ChatView;
  dark: boolean;
  /** The streamer's author key (a mention of it marks the row). */
  me: string | undefined;
  open: boolean;
  onToggle: () => void;
  onReply: () => void;
}) {
  const streamer = author?.r === 'streamer';
  const nickname = author?.n ?? '?';
  const info = sessionId ? view.info.get(sessionId) : undefined;
  const highlighted = item.h === 1;
  const pinned = view.pin?.s === item.s;
  const mentioned = Array.isArray(item.mn) ? item.mn.map((a) => view.roster.get(a)).filter((a): a is ChatAuthor => a !== undefined) : [];
  const mentionsMe = me !== undefined && Array.isArray(item.mn) && item.mn.includes(me);
  return (
    <li class={`chat-msg${streamer ? ' chat-msg-streamer' : ''}${highlighted ? ' chat-msg-highlighted' : ''}${mentionsMe ? ' chat-msg-mentions-me' : ''}`} data-seq={item.s} data-testid="chat-msg">
      {item.re && <ReplyQuote re={item.re} author={view.roster.get(item.re.a)} />}
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
          {mentionsMe && (
            <span class="chat-mark chat-mark-mention" data-testid="chat-mentions-you">
              {t('admin.chat.mentionsYou')}
            </span>
          )}
          <MessageBody body={item} author={author} dark={dark} mentioned={mentioned} me={me} />
        </div>
        <button type="button" class="small chat-more" aria-expanded={open} aria-label={t('admin.chat.menu.for', { nickname })} title={t('admin.chat.menu.tip')} data-testid="chat-more" onClick={onToggle}>
          ⋯
        </button>
      </div>
      {open && <ModerationMenu nickname={nickname} sessionId={streamer ? undefined : sessionId} seq={item.s} highlighted={highlighted} pinned={pinned} info={info} onClose={onToggle} onReply={onReply} />}
    </li>
  );
}

interface Suggestion {
  a: string;
  n: string;
  tag?: string;
}

function SendBox({
  maxGraphemes,
  streamerName,
  enabled,
  view,
  replyTo,
  onCancelReply,
  input,
}: {
  maxGraphemes: number;
  streamerName: string;
  enabled: boolean;
  view: ChatView;
  replyTo: ChatMessageItem | null;
  onCancelReply: () => void;
  input: { current: HTMLInputElement | null };
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [closed, setClosed] = useState(false);
  const { count, over } = draftLength(text, maxGraphemes);
  const name = streamerName || t('chat.streamer');
  useEffect(() => setErr(null), [text]);
  const people = useMemo(() => mentionableAuthors(view.items, view.roster), [view.rev]);
  const query = mentionQuery(text, caret);
  const offered: Suggestion[] = query && !closed ? suggestMentions(query.prefix, people.map((p): Suggestion => ({ a: p.a, n: p.n, ...(p.tag ? { tag: p.tag } : {}) }))).filter((o) => checkChatInvariants(o.n, { maxGraphemes: CHAT_NICKNAME_MAX, maxEmoji: CHAT_NICKNAME_MAX })) : [];
  const sel = offered.length ? Math.min(active, offered.length - 1) : 0;
  const replyAuthor = replyTo ? view.roster.get(replyTo.a) : undefined;
  const preview = replyTo ? replyPreview(replyTo) : null;
  // "Replying to {nickname}" around the name, which goes in a <bdi> of its own.
  const replyLabel = t('admin.chat.replyingTo', { nickname: '\u0000' }).split('\u0000');

  const pick = (i: number): void => {
    const o = offered[i];
    const el = input.current;
    if (!o || !query || !el) return;
    const next = applyMention(text, query.start, caret, o.n);
    setText(next.text);
    setCaret(next.caret);
    setActive(0);
    el.value = next.text;
    el.setSelectionRange(next.caret, next.caret);
  };

  const send = async (): Promise<void> => {
    if (!text.trim() || over || busy) return;
    setBusy(true);
    try {
      const body = text.trim();
      const mn = mentionKeys(body, mentionCandidates(people));
      await chatApi.send(body, { ...(replyTo ? { re: replyTo.s } : {}), ...(mn.length ? { mn } : {}) });
      setText('');
      setCaret(0);
      onCancelReply();
    } catch (e) {
      // The text (and the reply) stay so it can be fixed and sent again.
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const listId = 'chat-send-mentions';
  return (
    <form
      class="chat-send"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      {replyTo && (
        <div class="row tight small chat-replying" data-testid="chat-replying">
          <span class="sc-ico-reply" aria-hidden="true" />
          <span class="chat-replying-label">
            {replyLabel[0]}
            <bdi class="strong">{replyAuthor?.n || (replyAuthor?.r === 'streamer' ? t('chat.streamer') : '?')}</bdi>
            {replyLabel[1]}
          </span>
          {preview && (preview.gif || preview.text) && (
            <bdi class="muted chat-replying-quote" dir="auto">
              {preview.gif ? t('admin.chat.msg.gif') : preview.text}
            </bdi>
          )}
          <span class="spacer" />
          <button type="button" class="small" data-testid="chat-reply-cancel" aria-label={t('admin.chat.reply.cancel')} title={t('admin.chat.reply.cancel')} onClick={onCancelReply}>
            ✕
          </button>
        </div>
      )}
      {offered.length > 0 && (
        <ul class="chat-mentions" id={listId} role="listbox" aria-label={t('admin.chat.mention.list')} data-testid="chat-mentions">
          {offered.map((o, i) => (
            <li
              key={o.a}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === sel}
              data-testid="chat-mention-option"
              onPointerDown={(e) => {
                e.preventDefault();
                pick(i);
              }}
            >
              <bdi class="strong">{o.n}</bdi>
              {o.tag && <span class="muted small"> #{o.tag}</span>}
            </li>
          ))}
        </ul>
      )}
      <div class="row tight">
        <input
          type="text"
          ref={input}
          class="text-input chat-input"
          data-testid="chat-input"
          placeholder={t('admin.chat.send.placeholder', { name })}
          aria-label={t('admin.chat.send.placeholder', { name })}
          aria-invalid={over}
          aria-autocomplete="list"
          aria-controls={offered.length ? listId : undefined}
          aria-activedescendant={offered.length ? `${listId}-${sel}` : undefined}
          value={text}
          disabled={!enabled}
          onInput={(e) => {
            const el = e.target as HTMLInputElement;
            setText(el.value);
            setCaret(el.selectionStart ?? el.value.length);
            setClosed(false);
          }}
          onClick={(e) => setCaret((e.target as HTMLInputElement).selectionStart ?? 0)}
          onKeyUp={(e) => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) setCaret((e.target as HTMLInputElement).selectionStart ?? 0);
          }}
          onBlur={() => setClosed(true)}
          onFocus={() => setClosed(false)}
          onKeyDown={(e) => {
            if (offered.length > 0) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((sel + (e.key === 'ArrowDown' ? 1 : offered.length - 1)) % offered.length);
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                pick(sel);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setClosed(true);
                return;
              }
            }
            if (e.key === 'Escape' && replyTo) {
              e.preventDefault();
              onCancelReply();
            }
          }}
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
