import { useState } from 'preact/hooks';
import type { AdminChatState, AdminState, ChatProtect } from '@swarmcast/shared';
import { t } from '@swarmcast/shared/i18n';
import { chatApi, errorText } from '../api.js';
import { Info } from '../Info.js';
import { ChatFeed } from './ChatFeed.js';
import { ChatSettingsForm } from './ChatSettings.js';
import { useDark } from './hooks.js';
import { chatStatus } from './logic.js';
import type { ChatPanel } from './panel.js';
import './chat.css';

/** The id of the Chat settings card (the live chat's "Settings" button scrolls to it). */
const SETTINGS_CARD_ID = 'chat-settings-card';

function StatusPill({ chat, panel }: { chat: AdminChatState; panel: ChatPanel }) {
  const counters = panel.view.counters ?? chat.counters;
  const status = chatStatus(chat.settings.enabled, chat.effective, counters);
  return (
    <>
      <span class={`pill ${status.tone === 'ok' ? 'pill-ok' : status.tone === 'bad' ? 'pill-bad' : status.tone === 'wait' ? 'pill-wait' : ''}`} data-testid="chat-status">
        {t(status.key, status.params)}
      </span>
      <Info text={t('admin.chat.status.tip')} />
    </>
  );
}

/** A card's own action error: an action in one chat card never shows its error in the other. */
function useActionError(panel: ChatPanel): [unknown, (fn: () => Promise<unknown>) => Promise<void>] {
  const [err, setErr] = useState<unknown>(null);
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setErr(null);
    setErr(await panel.act(fn));
  };
  return [err, run];
}

function ChatError({ err }: { err: unknown }) {
  if (err === null) return null;
  return (
    <div class="err small" data-testid="chat-error">
      {errorText(err)}
    </div>
  );
}

/**
 * The live chat (plan chat-0.4.0 §5.3): status and counters, flood protection, the feed with
 * per-row moderation and "Send as …". Shown only while live with the chat on (chatColumnShown),
 * at the top of the panel: a column on the right on a wide window, under the status on a
 * narrow one, so the streamer reads the chat without scrolling.
 */
export function ChatLive({ panel }: { panel: ChatPanel }) {
  const dark = useDark();
  const [confirmClear, setConfirmClear] = useState(false);
  const [err, act] = useActionError(panel);
  const { chat, view, loadErr, busy } = panel;
  const title = (
    <h2 class="row-title">
      {t('admin.chat.live.title')} <Info text={t('admin.chat.live.tip')} />
    </h2>
  );

  if (!chat) {
    return (
      <aside class="card chat-live" data-testid="chat-live" aria-label={t('admin.chat.live.title')}>
        {title}
        {loadErr !== null ? <div class="err">{errorText(loadErr)}</div> : <p class="muted">{t('admin.loading')}</p>}
      </aside>
    );
  }

  const counters = view.counters ?? chat.counters;
  const protect: ChatProtect = counters.protect;

  return (
    <aside class="card chat-live" data-testid="chat-live" aria-label={t('admin.chat.live.title')}>
      <div class="chat-head">
        {title}
        <span class="spacer" />
        <button
          type="button"
          class="small"
          data-testid="chat-settings-link"
          title={t('admin.chat.live.settings.tip')}
          onClick={() => document.getElementById(SETTINGS_CARD_ID)?.scrollIntoView({ block: 'start' })}
        >
          {t('admin.chat.live.settings')}
        </button>
      </div>
      <div class="chat-head">
        <StatusPill chat={chat} panel={panel} />
        <span class="muted small" data-testid="chat-counters">
          {t('admin.chat.counters', { accepted: counters.acceptedPerMin, rejected: counters.rejectedPerMin })} <Info text={t('admin.chat.counters.tip')} />
        </span>
      </div>
      {counters.guard !== 'ok' && <div class="warn small">{t('admin.chat.guard.busy')}</div>}
      <ChatError err={err} />

      <div class="chat-protect" data-testid="chat-protect">
        <span class="small">
          <span class="strong">{t('admin.chat.protect')}</span> <Info text={t('admin.chat.protect.tip')} />{' '}
          <span data-testid="chat-protect-state">
            {t('admin.chat.protect.now', { modeKey: `chat.protect.${protect}` })}
            {counters.protectReason && <> · {t('admin.chat.protect.why', { reasonKey: counters.protectReason })}</>}
          </span>
        </span>
        <div class="row tight">
          <button type="button" class="small" data-testid="chat-protect-slow" disabled={busy || protect === 'slow'} onClick={() => void act(() => chatApi.protect('slow'))}>
            {t('admin.chat.protect.slow')}
          </button>
          <button type="button" class="small" data-testid="chat-protect-lockdown" disabled={busy || protect === 'lockdown'} onClick={() => void act(() => chatApi.protect('lockdown'))}>
            {t('admin.chat.protect.lockdown')}
          </button>
          <button type="button" class="small" data-testid="chat-protect-off" disabled={busy || protect === 'off'} onClick={() => void act(() => chatApi.protect('off'))}>
            {t('admin.chat.protect.off')}
          </button>
          {confirmClear ? (
            <span class="row tight chat-confirm">
              <span class="small">{t('admin.chat.clear.confirm')}</span>
              <button
                type="button"
                class="small danger"
                data-testid="chat-clear-yes"
                disabled={busy}
                onClick={() => {
                  setConfirmClear(false);
                  void act(() => chatApi.clear());
                }}
              >
                {t('admin.chat.clear.yes')}
              </button>
              <button type="button" class="small" onClick={() => setConfirmClear(false)}>
                {t('common.cancel')}
              </button>
            </span>
          ) : (
            <button type="button" class="small" data-testid="chat-clear" title={t('admin.chat.clear.tip')} disabled={busy} onClick={() => setConfirmClear(true)}>
              {t('admin.chat.clear')}
            </button>
          )}
        </div>
      </div>

      <ChatFeed view={view} dark={dark} maxGraphemes={chat.settings.maxGraphemes} streamerName={chat.effective.streamerName || chat.settings.streamerName} enabled={chat.settings.enabled} />
    </aside>
  );
}

/**
 * The "Chat" card further down the panel: the on/off switch, the status and the chat settings
 * (plan §5.2). The messages themselves are in the live chat at the top (ChatLive).
 */
export function ChatCard({ state, panel }: { state: AdminState; panel: ChatPanel }) {
  const [pending, setPending] = useState<boolean | null>(null);
  const [err, act] = useActionError(panel);
  const { chat, loadErr, busy, saveSettings } = panel;
  const live = state.phase === 'live';
  const title = (
    <h2 class="row-title">
      {t('admin.chat.title')} <Info text={t('admin.chat.tip')} />
    </h2>
  );

  if (!chat) {
    return (
      <section class="card mt chat-card" id={SETTINGS_CARD_ID} data-testid="chat-card">
        {title}
        {loadErr !== null ? <div class="err">{errorText(loadErr)}</div> : <p class="muted">{t('admin.loading')}</p>}
      </section>
    );
  }

  const enabled = chat.settings.enabled;
  // The switch shows the new position at once; it settles on the saved value (or back, on an error).
  const toggle = async (on: boolean): Promise<void> => {
    setPending(on);
    await act(() => saveSettings({ ...chat.settings, enabled: on }));
    setPending(null);
  };
  const switchOn = pending ?? enabled;

  return (
    <section class="card mt chat-card" id={SETTINGS_CARD_ID} data-testid="chat-card">
      <div class="chat-head">
        {title}
        <label class="switch" title={t('admin.chat.switch.tip')}>
          <input type="checkbox" role="switch" data-testid="chat-enabled" checked={switchOn} disabled={busy} onChange={(e) => void toggle((e.target as HTMLInputElement).checked)} />
          <span>{switchOn ? t('admin.chat.switch.on') : t('admin.chat.switch.off')}</span>
        </label>
        <Info text={t('admin.chat.switch.tip')} />
        <StatusPill chat={chat} panel={panel} />
      </div>
      {!enabled && <p class="muted small">{t('admin.chat.offNote')}</p>}
      {enabled && !live && <p class="muted small">{t('admin.chat.notLive')}</p>}
      {enabled && live && <p class="muted small">{t('admin.chat.liveAtTop')}</p>}
      <ChatError err={err} />
      <ChatSettingsForm settings={chat.settings} onSave={saveSettings} />
    </section>
  );
}
