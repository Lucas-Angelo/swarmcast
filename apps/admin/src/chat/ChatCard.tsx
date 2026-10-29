import { useEffect, useState } from 'preact/hooks';
import type { AdminChatState, AdminState, ChatProtect, ChatSettings } from '@swarmcast/shared';
import { t } from '@swarmcast/shared/i18n';
import { chatApi, errorText } from '../api.js';
import { Info } from '../Info.js';
import { ChatFeed } from './ChatFeed.js';
import { ChatSettingsForm } from './ChatSettings.js';
import { useChatView, useDark } from './hooks.js';
import { chatStatus } from './logic.js';
import './chat.css';

/** Sessions (mutes, colours) and effective settings are refreshed this often while live; messages come over /ws. */
const REFRESH_MS = 10_000;

/**
 * The panel's "Chat" card (plan chat-0.4.0 §5.3): on/off, status and counters, flood
 * protection, the feed with per-row moderation, "Send as …", and the settings.
 */
export function ChatCard({ state }: { state: AdminState }) {
  const view = useChatView();
  const dark = useDark();
  const [chat, setChat] = useState<AdminChatState | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const live = state.phase === 'live';
  const viewerKey = state.viewers.map((v) => v.sessionId).join(',');

  const reload = async (full = false): Promise<void> => {
    try {
      setChat(full ? await chatApi.load() : await chatApi.refreshSessions());
    } catch (e) {
      setErr(e);
    }
  };
  useEffect(() => void reload(true), []);
  // Someone joined or left: their mute and colour state changes with them.
  useEffect(() => void reload(), [viewerKey, state.phase]);
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => void reload(), REFRESH_MS);
    return () => clearInterval(id);
  }, [live]);

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const saveSettings = async (s: ChatSettings): Promise<void> => {
    const r = await chatApi.saveSettings(s);
    setChat((c) => (c ? { ...c, settings: r.settings, effective: r.effective } : c));
  };

  if (!chat) {
    return (
      <section class="card mt chat-card" data-testid="chat-card">
        <h2 class="row-title">
          {t('admin.chat.title')} <Info text={t('admin.chat.tip')} />
        </h2>
        {err !== null ? <div class="err">{errorText(err)}</div> : <p class="muted">{t('admin.loading')}</p>}
      </section>
    );
  }

  const enabled = chat.settings.enabled;
  const counters = view.counters ?? chat.counters;
  const status = chatStatus(enabled, chat.effective, counters);
  const protect: ChatProtect = counters.protect;
  const toggle = (on: boolean): Promise<void> => act(() => saveSettings({ ...chat.settings, enabled: on }));

  return (
    <section class="card mt chat-card" data-testid="chat-card">
      <div class="chat-head">
        <h2 class="row-title">
          {t('admin.chat.title')} <Info text={t('admin.chat.tip')} />
        </h2>
        <label class="switch" title={t('admin.chat.switch.tip')}>
          <input type="checkbox" role="switch" data-testid="chat-enabled" checked={enabled} disabled={busy} onChange={(e) => void toggle((e.target as HTMLInputElement).checked)} />
          <span>{enabled ? t('admin.chat.switch.on') : t('admin.chat.switch.off')}</span>
        </label>
        <Info text={t('admin.chat.switch.tip')} />
        <span class={`pill ${status.tone === 'ok' ? 'pill-ok' : status.tone === 'bad' ? 'pill-bad' : status.tone === 'wait' ? 'pill-wait' : ''}`} data-testid="chat-status">
          {t(status.key, status.params)}
        </span>
        <Info text={t('admin.chat.status.tip')} />
        {enabled && (
          <span class="muted small" data-testid="chat-counters">
            {t('admin.chat.counters', { accepted: counters.acceptedPerMin, rejected: counters.rejectedPerMin })} <Info text={t('admin.chat.counters.tip')} />
          </span>
        )}
      </div>
      {!enabled && <p class="muted small">{t('admin.chat.offNote')}</p>}
      {enabled && !live && <p class="muted small">{t('admin.chat.notLive')}</p>}
      {counters.guard !== 'ok' && <div class="warn small">{t('admin.chat.guard.busy')}</div>}
      {err !== null && (
        <div class="err small" data-testid="chat-error">
          {errorText(err)}
        </div>
      )}

      {enabled && (
        <div class="chat-protect" data-testid="chat-protect">
          <span class="small strong">
            {t('admin.chat.protect')} <Info text={t('admin.chat.protect.tip')} />
          </span>
          <span class="small" data-testid="chat-protect-state">
            {t('admin.chat.protect.now', { modeKey: `chat.protect.${protect}` })}
            {counters.protectReason && <> · {t('admin.chat.protect.why', { reasonKey: counters.protectReason })}</>}
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
            <span class="spacer" />
            {confirmClear ? (
              <>
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
              </>
            ) : (
              <button type="button" class="small" data-testid="chat-clear" title={t('admin.chat.clear.tip')} disabled={busy} onClick={() => setConfirmClear(true)}>
                {t('admin.chat.clear')}
              </button>
            )}
          </div>
        </div>
      )}

      <div class="chat-body">
        <ChatFeed view={view} dark={dark} maxGraphemes={chat.settings.maxGraphemes} streamerName={chat.effective.streamerName || chat.settings.streamerName} enabled={enabled} />
        <ChatSettingsForm settings={chat.settings} onSave={saveSettings} />
      </div>
    </section>
  );
}
