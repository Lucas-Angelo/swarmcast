import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { checkChatInvariants, CHAT_POLL_OPTION_MAX_GRAPHEMES, CHAT_POLL_OPTIONS_MAX, CHAT_POLL_OPTIONS_MIN, CHAT_POLL_QUESTION_MAX_GRAPHEMES, CHAT_POLL_SECONDS_DEFAULT, CHAT_POLL_SECONDS_PRESETS, type ChatPollKind, type ChatPollPublic } from '@swarmcast/shared';
import { t } from '@swarmcast/shared/i18n';
import { chatApi, errorText } from '../api.js';
import { Info } from '../Info.js';
import { pollPercents, pollRequest } from './logic.js';

/**
 * Polls and predictions in the panel (docs/CHAT.md, "Polls and predictions"): the form that starts
 * one (the slash commands /poll and /prediction fill the same request) and the card with the live
 * counts, the time left, End now, the right answer of a prediction, Cancel and Remove. Question and
 * options are the server's canonical text, checked with the shared invariants and shown in <bdi>.
 */

/** "1:42" (rounded up). */
function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function durationLabel(s: number): string {
  return s < 60 ? t('admin.chat.poll.seconds', { count: s }) : t('admin.chat.poll.minutes', { count: s / 60 });
}

/** Runs a poll call; its error stays on the card that made it. */
function useAction(): [boolean, unknown, (fn: () => Promise<unknown>) => Promise<boolean>] {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setErr(e);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return [busy, err, run];
}

export function PollForm({ kind: initialKind, onClose }: { kind: ChatPollKind; onClose: () => void }) {
  const [kind, setKind] = useState<ChatPollKind>(initialKind);
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [seconds, setSeconds] = useState<number>(CHAT_POLL_SECONDS_DEFAULT);
  const [newOnly, setNewOnly] = useState<boolean | null>(null);
  const [local, setLocal] = useState<string | null>(null);
  const [busy, err, run] = useAction();
  // A /poll or /prediction typed while the form is open switches it. In the commit, not in a
  // useEffect: Preact runs those after the next frame (or a 35 ms timer), and on the first render
  // that one put back the initial kind over a choice the streamer had clicked in the meantime.
  useLayoutEffect(() => setKind(initialKind), [initialKind]);
  // The question takes the focus in the commit too, not through `autofocus`: browsers apply that
  // at a later rendering update, and WebKit then moved the focus back to the question from a field
  // the streamer had already clicked, so what they typed there went into the question.
  const questionInput = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => questionInput.current?.focus(), []);
  // "Only people already watching": on by default for a prediction, off for a poll, until changed.
  const only = newOnly ?? kind === 'prediction';

  const start = async (): Promise<void> => {
    const r = pollRequest(kind, question, options, seconds, only);
    if (!r.ok) {
      setLocal(t(r.key, r.params));
      return;
    }
    setLocal(null);
    if (await run(() => chatApi.startPoll(r.body))) onClose();
  };

  return (
    <form
      class="chat-poll-form"
      data-testid="chat-poll-form"
      aria-label={t('admin.chat.poll.form')}
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div class="row tight">
        <strong class="small">{t('admin.chat.poll.form')}</strong>
        <span class="spacer" />
        <button type="button" class="small" aria-label={t('common.cancel')} title={t('common.cancel')} onClick={onClose}>
          ✕
        </button>
      </div>
      <fieldset class="row tight chat-poll-kind">
        <legend class="small">
          {t('admin.chat.poll.kind')} <Info text={t('admin.chat.poll.kind.tip')} />
        </legend>
        {(['poll', 'prediction'] as const).map((k) => (
          <label key={k} class="small">
            <input type="radio" name="chat-poll-kind" value={k} checked={kind === k} data-testid={`chat-poll-kind-${k}`} onChange={() => setKind(k)} /> {t(k === 'poll' ? 'admin.chat.poll.kind.poll' : 'admin.chat.poll.kind.prediction')}
          </label>
        ))}
      </fieldset>
      <label class="chat-poll-field small">
        <span>{t('admin.chat.poll.question')}</span>
        <input type="text" class="text-input" data-testid="chat-poll-question" maxLength={500} value={question} onInput={(e) => setQuestion((e.target as HTMLInputElement).value)} ref={questionInput} />
      </label>
      {options.map((o, i) => (
        <div class="row tight chat-poll-field" key={i}>
          <label class="small chat-poll-option">
            <span>{t('admin.chat.poll.option', { n: i + 1 })}</span>
            <input
              type="text"
              class="text-input"
              data-testid="chat-poll-option-input"
              maxLength={200}
              value={o}
              onInput={(e) => {
                const v = (e.target as HTMLInputElement).value;
                setOptions((list) => list.map((x, k) => (k === i ? v : x)));
              }}
            />
          </label>
          {options.length > CHAT_POLL_OPTIONS_MIN && (
            <button type="button" class="small" aria-label={t('admin.chat.poll.removeOption', { n: i + 1 })} title={t('admin.chat.poll.removeOption', { n: i + 1 })} onClick={() => setOptions((list) => list.filter((_, k) => k !== i))}>
              −
            </button>
          )}
        </div>
      ))}
      {options.length < CHAT_POLL_OPTIONS_MAX && (
        <button type="button" class="small" data-testid="chat-poll-add" onClick={() => setOptions((list) => [...list, ''])}>
          + {t('admin.chat.poll.addOption')}
        </button>
      )}
      <div class="row tight">
        <label class="small">
          {t('admin.chat.poll.duration')}{' '}
          <select class="text-input" data-testid="chat-poll-duration" value={String(seconds)} onChange={(e) => setSeconds(Number((e.target as HTMLSelectElement).value))}>
            {CHAT_POLL_SECONDS_PRESETS.map((s) => (
              <option key={s} value={String(s)}>
                {durationLabel(s)}
              </option>
            ))}
          </select>
        </label>
        <label class="small">
          <input type="checkbox" data-testid="chat-poll-newonly" checked={only} onChange={(e) => setNewOnly((e.target as HTMLInputElement).checked)} /> {t('admin.chat.poll.newOnly')}
        </label>
        <Info text={t('admin.chat.poll.newOnly.tip')} />
      </div>
      <div class="row tight chat-poll-actions">
        <button type="submit" class="primary small" data-testid="chat-poll-start" disabled={busy}>
          {t('admin.chat.poll.start')}
        </button>
        <span class="muted small">{t('admin.chat.poll.cmdTip', { usageKey: kind === 'poll' ? 'chat.cmd.poll.usage' : 'chat.cmd.prediction.usage' })}</span>
      </div>
      {(local !== null || err !== null) && (
        <div class="err small" role="alert" data-testid="chat-poll-form-error">
          {local ?? errorText(err)}
        </div>
      )}
    </form>
  );
}

/** The poll on top of the feed, with the live counts and the streamer's controls. */
export function PollCard({ poll, until, viewers }: { poll: ChatPollPublic; until: number | null; viewers: number }) {
  const [busy, err, run] = useAction();
  const [, setTick] = useState(0);
  useEffect(() => {
    if (poll.st !== 'open') return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [poll.id, poll.st]);
  const prediction = poll.kind === 'prediction';
  const textsOk = checkChatInvariants(poll.q, { maxGraphemes: CHAT_POLL_QUESTION_MAX_GRAPHEMES, maxEmoji: CHAT_POLL_QUESTION_MAX_GRAPHEMES }) && poll.o.every((o) => checkChatInvariants(o, { maxGraphemes: CHAT_POLL_OPTION_MAX_GRAPHEMES, maxEmoji: CHAT_POLL_OPTION_MAX_GRAPHEMES }));
  const pct = pollPercents(poll.c);
  const total = poll.c.reduce((a, b) => a + b, 0);
  const state = poll.st === 'open' ? 'admin.chat.poll.open' : poll.st === 'closed' ? 'admin.chat.poll.closed' : poll.st === 'locked' ? 'admin.chat.poll.locked' : 'admin.chat.poll.resolved';
  return (
    <section class={`chat-poll chat-poll-${poll.st}`} aria-label={t(prediction ? 'chat.prediction.title' : 'chat.poll.title')} data-testid="chat-poll" data-state={poll.st}>
      <div class="row tight chat-poll-head">
        <span class="small strong">{t(prediction ? 'chat.prediction.title' : 'chat.poll.title')}</span>
        <span class="muted small" data-testid="chat-poll-state">
          {t(state)}
        </span>
        {poll.st === 'open' && until !== null && (
          <span class="muted small" data-testid="chat-poll-time">
            {t('chat.poll.timeLeft', { time: clock(until - Date.now()) })}
          </span>
        )}
      </div>
      <div class="row tight chat-poll-actions-row">
        {poll.st === 'open' && (
          <button type="button" class="small" data-testid="chat-poll-end" disabled={busy} title={t(prediction ? 'admin.chat.poll.endGuesses.tip' : 'admin.chat.poll.end.tip')} onClick={() => void run(() => chatApi.endPoll())}>
            {t(prediction ? 'admin.chat.poll.endGuesses' : 'admin.chat.poll.end')}
          </button>
        )}
        {poll.st === 'open' || poll.st === 'locked' ? (
          <button type="button" class="small" data-testid="chat-poll-cancel" disabled={busy} title={t('admin.chat.poll.cancel.tip')} onClick={() => void run(() => chatApi.cancelPoll())}>
            {t('admin.chat.poll.cancel')}
          </button>
        ) : (
          <button type="button" class="small" data-testid="chat-poll-remove" disabled={busy} title={t('admin.chat.poll.remove.tip')} onClick={() => void run(() => chatApi.cancelPoll())}>
            {t('admin.chat.poll.remove')}
          </button>
        )}
      </div>
      <div class="chat-poll-body">
        <p class="chat-poll-q">
          {textsOk ? (
            <bdi dir="auto" data-testid="chat-poll-question-text">
              {poll.q}
            </bdi>
          ) : (
            <span class="muted">{t('chat.poll.hidden')}</span>
          )}
        </p>
        {textsOk && (
          <ol class="chat-poll-options">
            {poll.o.map((o, i) => (
              <li key={i} class={`chat-poll-row${poll.st === 'resolved' && poll.win === i ? ' win' : ''}`} data-testid="chat-poll-row">
                <span class="chat-poll-bar" aria-hidden="true" style={{ '--p': String(total > 0 ? (poll.c[i] ?? 0) / total : 0) }} />
                <bdi class="chat-poll-text" dir="auto">
                  {o}
                </bdi>
                {poll.st === 'resolved' && poll.win === i && <span class="chat-mark">{t('chat.poll.winner')}</span>}
                <span class="chat-poll-count small" data-testid="chat-poll-count">
                  {poll.c[i] ?? 0} · {pct[i] ?? 0}%
                </span>
                {poll.st === 'locked' && (
                  <button type="button" class="small" data-testid="chat-poll-answer" disabled={busy} aria-label={t('admin.chat.poll.answer.for', { option: o })} onClick={() => void run(() => chatApi.resolvePoll(i))}>
                    {t('admin.chat.poll.answer')}
                  </button>
                )}
              </li>
            ))}
          </ol>
        )}
        <div class="muted small" data-testid="chat-poll-voters">
          {poll.st === 'resolved' ? `${t('chat.prediction.gotIt', { count: poll.c[poll.win ?? -1] ?? 0 })} · ` : ''}
          {t('admin.chat.poll.voters', { count: total, viewers })}
        </div>
        {(poll.rn ?? 0) > 0 && (
          <div class="warn small" data-testid="chat-poll-refused">
            {t('admin.chat.poll.refused', { count: poll.rn ?? 0 })}
          </div>
        )}
      </div>
      {err !== null && <div class="err small">{errorText(err)}</div>}
    </section>
  );
}
