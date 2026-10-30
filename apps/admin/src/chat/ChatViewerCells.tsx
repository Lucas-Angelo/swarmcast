import { useState } from 'preact/hooks';
import { t } from '@swarmcast/shared/i18n';
import { chatApi, errorText } from '../api.js';
import { clockOf, useChatView, useDark } from './hooks.js';
import { isMuted, MUTE_CHOICES, mutedText, readableName } from './logic.js';

/** Viewers table, nickname cell: the chat name colour and the "muted until …" badge. */
export function ChatViewerName({ sessionId }: { sessionId: string }) {
  const view = useChatView();
  const dark = useDark();
  const info = view.info.get(sessionId);
  if (!info) return null;
  const muted = mutedText(info.mutedUntil, clockOf);
  return (
    <>
      <span class="chat-swatch" title={t('admin.chat.color.swatch')} aria-label={t('admin.chat.color.swatch')} role="img" style={{ backgroundColor: readableName(info.color, dark) }} />
      {muted && (
        <span class="badge off chat-muted-badge" data-testid="viewer-muted">
          {t(muted.key, muted.params)}
        </span>
      )}
    </>
  );
}

/** Viewers table, actions cell: mute for a time or until the stream ends, or unmute. */
export function ChatViewerMute({ sessionId, busy }: { sessionId: string; busy: boolean }) {
  const view = useChatView();
  const [err, setErr] = useState<unknown>(null);
  const info = view.info.get(sessionId);
  if (!info) return null;
  const run = (fn: () => Promise<void>): void => {
    setErr(null);
    fn().catch((e: unknown) => setErr(e));
  };
  return (
    <>
      {isMuted(info.mutedUntil) ? (
        <button class="small" data-testid="viewer-unmute" title={t('admin.chat.unmute.tip')} disabled={busy} onClick={() => run(() => chatApi.unmute(sessionId))}>
          {t('admin.chat.unmute')}
        </button>
      ) : (
        <select
          class="small"
          data-testid="viewer-mute"
          aria-label={t('admin.chat.mute')}
          title={t('admin.chat.viewer.mute.tip')}
          disabled={busy}
          value=""
          onChange={(e) => {
            const el = e.target as HTMLSelectElement;
            const choice = MUTE_CHOICES[Number(el.value)];
            el.value = '';
            if (choice) run(() => chatApi.mute(sessionId, choice.minutes));
          }}
        >
          <option value="">{t('admin.chat.mute')}…</option>
          {MUTE_CHOICES.map((c, i) => (
            <option key={i} value={String(i)}>
              {t(c.key, c.params)}
            </option>
          ))}
        </select>
      )}
      {err !== null && <span class="small danger-text">{errorText(err)}</span>}
    </>
  );
}
