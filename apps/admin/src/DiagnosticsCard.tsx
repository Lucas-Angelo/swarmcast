import { useEffect, useState } from 'preact/hooks';
import { LOG_RETENTION_RANGE, type DiagnosticsSettings, type LogExportResult } from '@swarmcast/shared';
import { t } from '@swarmcast/shared/i18n';
import { api, errorText, post } from './api.js';
import { Info } from './Info.js';

const clampDays = (n: number): number => Math.min(LOG_RETENTION_RANGE.max, Math.max(LOG_RETENTION_RANGE.min, Math.round(n) || LOG_RETENTION_RANGE.default));

/**
 * "Problem report" card: Export logs (an anonymised ZIP the server writes to the Downloads
 * folder, so it works the same in a browser and in the desktop app's webview), Show in folder,
 * and how long log files are kept.
 */
export function DiagnosticsCard() {
  const [busy, setBusy] = useState(false);
  const [fullIps, setFullIps] = useState(false);
  const [result, setResult] = useState<LogExportResult | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [revealFailed, setRevealFailed] = useState(false);
  const [days, setDays] = useState<number | null>(null);
  const [savedDays, setSavedDays] = useState<number | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api<DiagnosticsSettings>('/api/diagnostics', 'GET').then(
      (s) => {
        setDays(s.logRetentionDays);
        setSavedDays(s.logRetentionDays);
      },
      () => {},
    );
  }, []);

  const exportLogs = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    setRevealFailed(false);
    try {
      setResult(await post<LogExportResult>('/api/diagnostics/export', { includeFullIps: fullIps }));
    } catch (e) {
      setResult(null);
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const reveal = async (): Promise<void> => {
    if (!result) return;
    try {
      const r = await post<{ ok: boolean }>('/api/diagnostics/reveal', { path: result.path });
      setRevealFailed(!r.ok);
    } catch {
      setRevealFailed(true);
    }
  };

  const saveDays = async (): Promise<void> => {
    if (days === null) return;
    setErr(null);
    try {
      const s = await api<DiagnosticsSettings>('/api/diagnostics', 'PUT', { logRetentionDays: clampDays(days) });
      setDays(s.logRetentionDays);
      setSavedDays(s.logRetentionDays);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr(e);
    }
  };

  return (
    <section class="card mt" data-testid="diagnostics">
      <h2 class="row-title">
        {t('diag.title')} <Info text={t('diag.title.tip')} />
      </h2>
      <div class="row">
        <button class="primary" data-testid="export-logs" title={t('diag.export.tip')} disabled={busy} onClick={() => void exportLogs()}>
          {busy ? t('diag.exporting') : t('diag.export')}
        </button>
        <Info text={t('diag.export.tip')} />
      </div>
      {result && (
        <div class="mt-s" data-testid="export-result">
          <p class="small ok">
            <span data-testid="export-path">{result.fallback ? t('diag.savedFallback', { path: result.path }) : t('diag.saved', { path: result.path })}</span>{' '}
            <button class="small" data-testid="export-reveal" title={t('diag.show.tip')} onClick={() => void reveal()}>
              {t('diag.show')}
            </button>
          </p>
          <p class="small muted">{t('diag.next')}</p>
          {revealFailed && <p class="small warn-text">{t('diag.showFailed', { path: result.path })}</p>}
        </div>
      )}
      <details class="mt-s">
        <summary class="small">{t('diag.advanced')}</summary>
        <label class="field small">
          <input type="checkbox" data-testid="export-full-ips" checked={fullIps} onChange={(e) => setFullIps((e.target as HTMLInputElement).checked)} />{' '}
          {t('diag.fullIps')} <Info text={t('diag.fullIps.tip')} />
        </label>
        {days !== null && (
          <form
            class="field small"
            onSubmit={(e) => {
              e.preventDefault();
              void saveDays();
            }}
          >
            <label>
              {t('diag.retention')}{' '}
              <input
                type="number"
                data-testid="log-retention"
                min={LOG_RETENTION_RANGE.min}
                max={LOG_RETENTION_RANGE.max}
                value={days}
                onInput={(e) => setDays(Number((e.target as HTMLInputElement).value))}
              />{' '}
              {t('diag.retention.days')}
            </label>{' '}
            <Info text={t('diag.retention.tip')} />{' '}
            <button type="submit" class="small" data-testid="log-retention-save" disabled={days === savedDays}>
              {t('diag.retention.save')}
            </button>{' '}
            {saved && <span class="ok">{t('diag.retention.saved')}</span>}
          </form>
        )}
      </details>
      {err !== null && <div class="err small" role="alert">{errorText(err)}</div>}
    </section>
  );
}
