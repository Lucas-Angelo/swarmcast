import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  applyMention,
  checkChatInvariants,
  CHAT_NICKNAME_MAX,
  commandNames,
  mentionKeys,
  mentionQuery,
  parseCommand,
  suggestCommands,
  suggestMentions,
  type ChatAuthor,
  type ChatCommandDef,
  type ChatMessageItem,
  type ChatPin,
  type ChatPollKind,
  type ChatReplyRef,
  type ChatSettings,
  type ChatSystemItem,
  type ChatToken,
  type GifRef,
} from '@swarmcast/shared';
import { getLang, t } from '@swarmcast/shared/i18n';
import { chatApi, errorText } from '../api.js';
import { Info } from '../Info.js';
import { CommandHelp } from './CommandHelp.js';
import { clockOf } from './hooks.js';
import { draftLength, mentionableAuthors, mentionCandidates, messageParts, readableName, replyPreview, runCommand, streamerKey, systemText, type CommandApi } from './logic.js';
import { ModerationMenu } from './ModerationMenu.js';
import { PollCard, PollForm } from './Poll.js';

/** What the "Send as …" box needs to run slash commands besides the chat API (docs/CHAT.md, "Slash commands"). */
export interface FeedCommands {
  settings: ChatSettings;
  saveSettings: (s: ChatSettings) => Promise<void>;
  /** Ask the Clear question (as the Clear button does): /clear never clears by itself. */
  onClear: () => void;
}
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
 *
 * Polls and predictions (docs/CHAT.md, "Polls and predictions"): the card with the live counts sits
 * under the pinned message; the form opens above the box with the Poll button or /poll alone.
 * Slash commands (docs/CHAT.md, "Slash commands") are read here and run as the buttons' REST calls:
 * a list of matching commands shows while the text starts with "/", and "?" lists them all.
 */
export function ChatFeed({ view, dark, maxGraphemes, streamerName, enabled, commands }: { view: ChatView; dark: boolean; maxGraphemes: number; streamerName: string; enabled: boolean; commands?: FeedCommands }) {
  const [form, setForm] = useState<ChatPollKind | null>(null);
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
    <div class={`chat-feed${form !== null ? ' with-form' : ''}`}>
      {view.pin && <PinnedBar pin={view.pin} until={view.pinUntil} author={view.roster.get(view.pin.a)} dark={dark} />}
      {/* The form takes the card's place while it is open (the column's height is the window's). */}
      {view.poll && form === null && <PollCard poll={view.poll} until={view.pollUntil} viewers={view.info.size} />}
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
      {form !== null && <PollForm kind={form} onClose={() => setForm(null)} />}
      <SendBox maxGraphemes={maxGraphemes} streamerName={streamerName} enabled={enabled} view={view} replyTo={replyTo} onCancelReply={() => setReplyTo(null)} input={input} commands={commands} onPollForm={(k) => setForm(k)} />
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
          <span class="chat-quote-sep">: </span>
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
  commands,
  onPollForm,
}: {
  maxGraphemes: number;
  streamerName: string;
  enabled: boolean;
  view: ChatView;
  replyTo: ChatMessageItem | null;
  onCancelReply: () => void;
  input: { current: HTMLInputElement | null };
  commands?: FeedCommands | undefined;
  onPollForm: (kind: ChatPollKind) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  /** The last command's result line, or why it did not run. */
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [help, setHelp] = useState(false);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [closed, setClosed] = useState(false);
  const { count, over } = draftLength(text, maxGraphemes);
  const name = streamerName || t('chat.streamer');
  useEffect(() => setErr(null), [text]);
  const people = useMemo(() => mentionableAuthors(view.items, view.roster), [view.rev]);
  const query = mentionQuery(text, caret);
  // A command name being typed ("/enq"): the matching commands, with how to write them.
  const cmdPrefix = /^\/[^\s/]*$/.test(text) ? text.slice(1) : null;
  const cmdOffered: ChatCommandDef[] = cmdPrefix !== null && !closed ? suggestCommands(cmdPrefix, 'streamer') : [];
  const offered: Suggestion[] = cmdOffered.length > 0 ? [] : query && !closed ? suggestMentions(query.prefix, people.map((p): Suggestion => ({ a: p.a, n: p.n, ...(p.tag ? { tag: p.tag } : {}) }))).filter((o) => checkChatInvariants(o.n, { maxGraphemes: CHAT_NICKNAME_MAX, maxEmoji: CHAT_NICKNAME_MAX })) : [];
  const sel = offered.length ? Math.min(active, offered.length - 1) : 0;
  const replyAuthor = replyTo ? view.roster.get(replyTo.a) : undefined;
  const preview = replyTo ? replyPreview(replyTo) : null;
  // "Replying to {nickname}" around the name, which goes in a <bdi> of its own.
  const replyLabel = t('admin.chat.replyingTo', { nickname: '\u0000' }).split('\u0000');

  /** Put "/name " in the box (the name in the panel's language). */
  const pickCommand = (c: ChatCommandDef): void => {
    const el = input.current;
    const next = `/${commandNames(c, getLang()).main} `;
    setText(next);
    setCaret(next.length);
    setActive(0);
    setHelp(false);
    if (el) {
      el.value = next;
      el.focus();
      el.setSelectionRange(next.length, next.length);
    }
  };

  const cmdApi: CommandApi = {
    startPoll: (b) => chatApi.startPoll(b),
    endPoll: () => chatApi.endPoll(),
    resolvePoll: (o) => chatApi.resolvePoll(o),
    cancelPoll: () => chatApi.cancelPoll(),
    send: (x) => chatApi.send(x),
    pin: (s, m) => chatApi.pin(s, m),
    unpin: () => chatApi.unpin(),
    mute: (id, m) => chatApi.mute(id, m),
    unmute: (id) => chatApi.unmute(id),
    protect: (m) => chatApi.protect(m),
    slow: async (seconds) => {
      if (!commands) throw new Error(t('admin.loading'));
      await commands.saveSettings({ ...commands.settings, slowModeS: seconds });
    },
  };

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

  const clearBox = (): void => {
    setText('');
    setCaret(0);
    if (input.current) input.current.value = '';
  };

  /** A slash command: run as the buttons' calls (true), or not a command (false: send the text). */
  const command = async (body: string): Promise<string | null> => {
    const parsed = parseCommand(body, 'streamer');
    if (parsed === null) return body;
    if (!parsed.ok) {
      setNote({ ok: false, text: t(parsed.code, parsed.params) });
      return null;
    }
    const out = await runCommand(parsed.cmd, { sessions: view.info.values(), replyTo: replyTo?.s ?? null }, cmdApi);
    if ('say' in out) return out.say;
    if ('ui' in out) {
      clearBox();
      if (out.ui === 'help') setHelp(true);
      else if (out.ui === 'clear') commands?.onClear();
      else onPollForm(out.ui);
    } else if ('done' in out) {
      clearBox();
      if (parsed.cmd.id === 'pin') onCancelReply();
      setNote({ ok: true, text: t(out.done.key, out.done.params) });
    } else setNote({ ok: false, text: t(out.error.key, out.error.params) });
    return null;
  };

  const send = async (): Promise<void> => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const typed = await command(text.trim());
      if (typed === null) return;
      if (draftLength(typed, maxGraphemes).over) return;
      const body = typed;
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
  const cmdListId = 'chat-send-commands';
  // A command may be longer than a message (a poll's question and options): the length limit is the message's.
  const isCommand = parseCommand(text.trim(), 'streamer') !== null;
  const tooLong = over && !isCommand;
  const cmdSel = cmdOffered.length ? Math.min(active, cmdOffered.length - 1) : 0;
  const listShown = offered.length > 0 ? listId : cmdOffered.length > 0 ? cmdListId : undefined;
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
      {cmdOffered.length > 0 && (
        <ul class="chat-mentions chat-cmds" id={cmdListId} role="listbox" aria-label={t('admin.chat.cmd.list')} data-testid="chat-cmd-suggestions">
          {cmdOffered.map((c, i) => (
            <li
              key={c.id}
              id={`${cmdListId}-${i}`}
              role="option"
              aria-selected={i === cmdSel}
              data-testid="chat-cmd-option"
              data-cmd={c.id}
              onPointerDown={(e) => {
                e.preventDefault();
                pickCommand(c);
              }}
            >
              <code class="strong">{t(c.usage)}</code> <span class="muted small">{t(c.help)}</span>
            </li>
          ))}
        </ul>
      )}
      {help && <CommandHelp onPick={pickCommand} onClose={() => setHelp(false)} />}
      <div class="row tight">
        <input
          type="text"
          ref={input}
          class="text-input chat-input"
          data-testid="chat-input"
          placeholder={t('admin.chat.send.placeholder', { name })}
          aria-label={t('admin.chat.send.placeholder', { name })}
          aria-invalid={tooLong}
          aria-autocomplete="list"
          aria-controls={listShown}
          aria-activedescendant={offered.length ? `${listId}-${sel}` : cmdOffered.length ? `${cmdListId}-${cmdSel}` : undefined}
          value={text}
          disabled={!enabled}
          onInput={(e) => {
            const el = e.target as HTMLInputElement;
            // The last command's line goes as soon as the streamer types again (here, not in an
            // effect: an effect runs after the next frame, and could wipe the line of a command sent
            // right after typing).
            setNote(null);
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
            if (cmdOffered.length > 0) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((cmdSel + (e.key === 'ArrowDown' ? 1 : cmdOffered.length - 1)) % cmdOffered.length);
                return;
              }
              // Enter on a whole name ("/end") runs it; on a part ("/en"), or Tab, completes it.
              if ((e.key === 'Enter' && parseCommand(text, 'streamer') === null) || e.key === 'Tab') {
                e.preventDefault();
                pickCommand(cmdOffered[cmdSel]!);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setClosed(true);
                return;
              }
            }
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
        <button type="submit" class="primary" data-testid="chat-send" disabled={!enabled || busy || tooLong || !text.trim()} title={t('admin.chat.send.tip')}>
          {t('admin.chat.send')}
        </button>
        <button type="button" class="small chat-cmd-button" data-testid="chat-cmd-help-button" aria-expanded={help} aria-label={t('admin.chat.cmd.help')} title={t('admin.chat.cmd.help.tip')} onClick={() => setHelp(!help)}>
          ?
        </button>
        <Info text={t('admin.chat.send.tip')} />
      </div>
      <div class="row tight small">
        <button type="button" class="small" data-testid="chat-poll-new" disabled={!enabled} title={t('admin.chat.poll.new.tip')} onClick={() => onPollForm('poll')}>
          {t('admin.chat.poll.new')}
        </button>
        <span class={tooLong ? 'danger-text' : 'muted'} data-testid="chat-count">
          {t('admin.chat.send.counter', { count, max: maxGraphemes })}
        </span>
        {note !== null && (
          <span class={note.ok ? 'muted' : 'danger-text'} role={note.ok ? 'status' : 'alert'} data-testid="chat-cmd-result">
            {note.text}
          </span>
        )}
        {err !== null && (
          <span class="danger-text" role="alert" data-testid="chat-send-error">
            {errorText(err)}
          </span>
        )}
      </div>
    </form>
  );
}
