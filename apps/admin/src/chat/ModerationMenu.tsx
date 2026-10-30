import { useEffect, useRef, useState } from 'preact/hooks';
import type { ChatSessionInfo } from '@swarmcast/shared';
import { t } from '@swarmcast/shared/i18n';
import { chatApi, errorText } from '../api.js';
import { Info } from '../Info.js';
import { isMuted, MUTE_CHOICES } from './logic.js';

/**
 * The actions on one person (and, from the feed, on one message): delete, mute for a time or
 * until the stream ends, unmute, change the name colour (optionally locked). Shown inline under
 * the row it belongs to; Escape or Close hides it.
 */
export function ModerationMenu({
  nickname,
  sessionId,
  seq,
  info,
  onClose,
}: {
  nickname: string;
  /** Absent for the streamer's own messages and for someone who left. */
  sessionId?: string;
  /** Present when opened from a message (enables Delete). */
  seq?: number;
  info?: ChatSessionInfo;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [color, setColor] = useState(info?.color ?? '#46a758');
  const [lock, setLock] = useState(info?.colorLocked ?? false);
  const box = useRef<HTMLDivElement>(null);
  const muted = isMuted(info?.mutedUntil);

  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const run = async (fn: () => Promise<unknown>, close = true): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      if (close) onClose();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="chat-menu" ref={box} role="group" aria-label={t('admin.chat.menu.for', { nickname })} data-testid="chat-menu">
      <div class="row tight">
        {seq !== undefined && (
          <button type="button" class="small danger" data-testid="chat-delete" title={t('admin.chat.delete.tip')} disabled={busy} onClick={() => void run(() => chatApi.remove([seq]))}>
            {t('admin.chat.delete')}
          </button>
        )}
        {sessionId && muted && (
          <button type="button" class="small" data-testid="chat-unmute" title={t('admin.chat.unmute.tip')} disabled={busy} onClick={() => void run(() => chatApi.unmute(sessionId))}>
            {t('admin.chat.unmute')}
          </button>
        )}
        <span class="spacer" />
        <button type="button" class="small" onClick={onClose}>
          {t('admin.chat.close')}
        </button>
      </div>
      {sessionId && !muted && (
        <div class="chat-menu-group">
          <span class="small strong">
            {t('admin.chat.mute')} <Info text={t('admin.chat.mute.tip')} />
          </span>
          <div class="row tight">
            {MUTE_CHOICES.map((c) => (
              <button
                type="button"
                class="small"
                key={String(c.minutes)}
                data-testid={`chat-mute-${c.minutes ?? 'live'}`}
                disabled={busy}
                onClick={() => void run(() => chatApi.mute(sessionId, c.minutes))}
              >
                {t(c.key, c.params)}
              </button>
            ))}
            <Info text={t('admin.chat.muteLive.explain')} />
          </div>
        </div>
      )}
      {sessionId && (
        <div class="chat-menu-group">
          <span class="small strong">
            {t('admin.chat.color')} <Info text={t('admin.chat.color.tip')} />
          </span>
          <div class="row tight">
            <label class="row tight small">
              {t('admin.chat.color.pick')}
              <input type="color" data-testid="chat-color-input" value={color} onInput={(e) => setColor((e.target as HTMLInputElement).value)} />
            </label>
            <label class="row tight small">
              <input type="checkbox" data-testid="chat-color-lock" checked={lock} onChange={(e) => setLock((e.target as HTMLInputElement).checked)} />
              {t('admin.chat.color.lock')}
            </label>
            <button type="button" class="small primary" data-testid="chat-color-apply" disabled={busy} onClick={() => void run(() => chatApi.color(sessionId, color, lock))}>
              {t('admin.chat.color.apply')}
            </button>
            <button type="button" class="small" disabled={busy} onClick={() => void run(() => chatApi.color(sessionId, null, false))}>
              {t('admin.chat.color.reset')}
            </button>
          </div>
        </div>
      )}
      {err !== null && <div class="err small">{errorText(err)}</div>}
    </div>
  );
}
