import { useState } from 'preact/hooks';
import type { DesktopInfo, LivePhase } from '@swarmcast/shared';
import { t } from '@swarmcast/shared/i18n';
import { api, errorText, post } from './api.js';
import { checkView, setDesktop, updateBanner, useDesktop } from './desktop.js';
import { Info } from './Info.js';

/** Ask the shell to install the update; when the live is on, confirm first (it stops the live). */
async function installUpdate(phase: LivePhase): Promise<void> {
  if (phase !== 'off' && !window.confirm(t('desktop.update.confirmLive'))) return;
  setDesktop(await post<DesktopInfo>('/api/desktop/update/install'));
}

/**
 * Banner at the top of the panel (desktop app only): "SwarmCast X is available" with the notes
 * and "Update now", then download progress / installing / failure.
 */
export function UpdateBanner({ phase }: { phase: LivePhase }) {
  const d = useDesktop();
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const b = d ? updateBanner(d.update, phase) : null;
  if (!b) return null;

  const install = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      await installUpdate(phase);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class={b.kind === 'error' ? 'err update-banner' : 'warn update-banner'} role="status" data-testid="update-banner" data-kind={b.kind}>
      {b.kind === 'available' && (
        <>
          <div class="row">
            <b>{t('desktop.update.available', { version: b.version })}</b>
            {b.current && <span class="muted small">{t('desktop.update.current', { current: b.current })}</span>}
            <span class="spacer" />
            <button class="primary" data-testid="update-now" title={t('desktop.update.now.tip')} disabled={busy} onClick={() => void install()}>
              {t('desktop.update.now')}
            </button>
            <Info text={t('desktop.update.now.tip')} />
          </div>
          {b.liveOn && <p class="small strong danger-text">{t('desktop.update.liveWarn')}</p>}
          {b.notes && (
            <details class="update-notes">
              <summary>{t('desktop.update.notes')}</summary>
              <div class="update-notes-text small">{b.notes}</div>
            </details>
          )}
        </>
      )}
      {b.kind === 'downloading' && (
        <div class="row">
          <span>{b.percent === null ? t('desktop.update.downloadingNoPercent') : t('desktop.update.downloading', { percent: b.percent })}</span>
          {b.percent !== null && <progress max={100} value={b.percent} aria-label={t('desktop.update.downloadingNoPercent')} />}
        </div>
      )}
      {b.kind === 'installing' && <span>{t('desktop.update.installing')}</span>}
      {b.kind === 'error' && (
        <div class="row">
          <span>{b.error ? t('desktop.update.error', { error: b.error }) : t('desktop.update.errorNoDetail')}</span>
          <span class="spacer" />
          <button data-testid="update-retry" title={t('desktop.update.retry.tip')} disabled={busy} onClick={() => void install()}>
            {t('desktop.update.retry')}
          </button>
          <Info text={t('desktop.update.retry.tip')} />
        </div>
      )}
      {err !== null && <div class="err small">{errorText(err)}</div>}
    </div>
  );
}

/** "Desktop app" card: start with the computer, version, check for updates. Hidden in script mode. */
export function DesktopCard() {
  const d = useDesktop();
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  // The switch shows the new value while the OS entry is being written.
  const [wanted, setWanted] = useState<boolean | null>(null);
  if (!d) return null;

  const run = async (fn: () => Promise<DesktopInfo>): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      setDesktop(await fn());
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const setAutostart = async (enabled: boolean): Promise<void> => {
    setWanted(enabled);
    await run(() => api<DesktopInfo>('/api/desktop/autostart', 'PUT', { enabled }));
    setWanted(null);
  };
  const a = d.autostart;
  const check = checkView(d);

  return (
    <section class="card mt" data-testid="desktop-card">
      <h2 class="row-title">
        {t('desktop.title')} <Info text={t('desktop.title.tip')} />
      </h2>
      <div class="field">
        <label class="switch-label">
          <input
            type="checkbox"
            data-testid="autostart"
            checked={wanted ?? a.enabled}
            disabled={!a.supported || busy}
            onChange={(e) => void setAutostart((e.target as HTMLInputElement).checked)}
          />{' '}
          {t('desktop.autostart')}
        </label>{' '}
        <Info text={t('desktop.autostart.tip')} />
        {!a.supported && <p class="muted small">{t('desktop.autostart.unsupported')}</p>}
        {a.enabled && a.stale && (
          <p class="small warn-text">
            {t('desktop.autostart.stale')}{' '}
            <button class="small" title={t('desktop.autostart.fix.tip')} disabled={busy} onClick={() => void setAutostart(true)}>
              {t('desktop.autostart.fix')}
            </button>
          </p>
        )}
        {a.error && <p class="small danger-text">{t('desktop.autostart.readError', { error: a.error })}</p>}
      </div>
      <div class="row tight">
        <span data-testid="desktop-version">{t('desktop.version', { version: d.version })}</span>
        <Info text={t('desktop.version.tip')} />
      </div>
      <div class="row">
        <button data-testid="check-updates" title={t('desktop.check.tip')} disabled={busy || check === 'checking' || check === 'busy'} onClick={() => void run(() => post<DesktopInfo>('/api/desktop/update/check'))}>
          {check === 'checking' ? t('desktop.checking') : t('desktop.check')}
        </button>
        <Info text={t('desktop.check.tip')} />
        {check === 'upToDate' && <span class="small ok" data-testid="up-to-date">{t('desktop.upToDate')}</span>}
        {check === 'available' && d.update?.version && <span class="small accent-text strong">{t('desktop.update.available', { version: d.update.version })}</span>}
        {check === 'error' && !d.update?.version && (
          <span class="small danger-text">{d.update?.error ? t('desktop.update.error', { error: d.update.error }) : t('desktop.update.errorNoDetail')}</span>
        )}
      </div>
      {err !== null && <div class="err small">{errorText(err)}</div>}
    </section>
  );
}
