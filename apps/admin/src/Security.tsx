import { useEffect, useState } from 'preact/hooks';
import type { AdminState, SecuritySettings } from '@swarmcast/shared';
import { getLang, t, type MessageKey } from '@swarmcast/shared/i18n';
import { api, post } from './api.js';
import { Info } from './Info.js';

type Act = (key: string, fn: () => Promise<unknown>) => Promise<void>;

const CHECK_KEYS: Record<0 | 1 | 2, MessageKey> = { 0: 'security.check.off', 1: 'security.check.light', 2: 'security.check.strong' };

const SWITCHES: Array<{ key: keyof SecuritySettings; label: MessageKey; tip: MessageKey }> = [
  { key: 'blockKnownBadIps', label: 'admin.sec.blockLists', tip: 'admin.sec.blockLists.tip' },
  { key: 'requireBrowserCheck', label: 'admin.sec.requireCheck', tip: 'admin.sec.requireCheck.tip' },
  { key: 'autoBrowserCheck', label: 'admin.sec.autoCheck', tip: 'admin.sec.autoCheck.tip' },
  { key: 'autoTighten', label: 'admin.sec.autoTighten', tip: 'admin.sec.autoTighten.tip' },
  { key: 'autoNewLink', label: 'admin.sec.autoNewLink', tip: 'admin.sec.autoNewLink.tip' },
  { key: 'autoSecureFromDirect', label: 'admin.sec.autoSecure', tip: 'admin.sec.autoSecure.tip' },
  { key: 'autoStopIfDirectFails', label: 'admin.sec.autoStopDirect', tip: 'admin.sec.autoStopDirect.tip' },
  { key: 'stopOnAttack', label: 'admin.sec.stopOnAttack', tip: 'admin.sec.stopOnAttack.tip' },
];

function clock(at: number): string {
  return new Date(at).toLocaleTimeString(getLang(), { hour: '2-digit', minute: '2-digit' });
}

function day(at: number): string {
  return new Date(at).toLocaleString(getLang(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** "Protection" card: attack detection status, automatic reactions and public blocklists. */
export function SecurityCard({ s, busy, act }: { s: AdminState; busy: boolean; act: Act }) {
  const sec = s.security;
  const [v, setV] = useState<SecuritySettings>(sec.settings);
  const saved = JSON.stringify(sec.settings);
  useEffect(() => setV(sec.settings), [saved]);
  const pill = sec.threat === 'normal' ? 'pill-ok' : sec.threat === 'suspicious' ? 'pill-wait' : 'pill-bad';
  const configured = s.settings;
  return (
    <section class={`card card-security ${sec.threat === 'attack' ? 'alert' : ''}`} data-testid="security">
      <h2 class="row-title">
        {t('admin.sec.title')} <Info text={t('admin.sec.tip')} />
      </h2>
      <div class="row tight">
        <span class={`pill ${pill}`} data-testid="threat" data-threat={sec.threat}>
          {t(`admin.sec.state.${sec.threat}`)}
        </span>
        {sec.threatSince && <span class="muted small">{t('admin.sec.since', { clock: clock(sec.threatSince) })}</span>}
        <Info text={t('admin.sec.state.tip')} />
        {sec.threat !== 'normal' && (
          <button class="small" data-testid="end-alert" title={t('admin.sec.clear.tip')} disabled={busy} onClick={() => act('sec-clear', () => post('/api/security/clear'))}>
            {t('admin.sec.clear')}
          </button>
        )}
      </div>
      {sec.reasonCode && <p class="small">{t('admin.sec.reason', { reasonKey: sec.reasonCode })}</p>}
      <div class="row tight small">
        <span data-testid="browser-check" data-level={sec.browserCheck}>{t('admin.sec.check', { levelKey: CHECK_KEYS[sec.browserCheck] })}</span>
        <Info text={t('admin.sec.check.tip')} />
      </div>
      {sec.tightened && (
        <div class="warn small row tight">
          <span>
            {t('admin.sec.tightened', {
              viewers: sec.effectiveMaxViewers,
              configured: configured.maxViewers ?? sec.effectiveMaxViewers,
              perDevice: configured.maxSessionsPerDevice ?? sec.effectiveMaxSessionsPerDevice,
            })}
          </span>
          <Info text={t('admin.sec.tightened.tip')} />
        </div>
      )}
      <div class="row tight small">
        <span data-testid="blocked-count">{t('admin.sec.blocked', { count: sec.blockedByLists })}</span>
        <Info text={t('admin.sec.blocked.tip')} />
      </div>
      {sec.settings.blockKnownBadIps && (
        <div class="row tight small muted">
          <span>
            {sec.blocklists.updatedAt && sec.blocklists.networks > 0
              ? t('admin.sec.lists', { networks: sec.blocklists.networks, date: day(sec.blocklists.updatedAt) })
              : t('admin.sec.listsNone')}
            {sec.blocklists.failedLists > 0 && <> {t('admin.sec.listsFailed', { count: sec.blocklists.failedLists })}</>}
          </span>
          <Info text={t('admin.sec.lists.tip')} />
        </div>
      )}
      <form
        class="mt"
        onSubmit={(e) => {
          e.preventDefault();
          void act('sec-save', () => api('/api/security', 'PUT', v));
        }}
      >
        {SWITCHES.map((sw) => (
          <div class="field" key={sw.key}>
            <label>
              <input
                type="checkbox"
                data-testid={`sec-${sw.key}`}
                checked={v[sw.key]}
                onChange={(e) => setV({ ...v, [sw.key]: (e.target as HTMLInputElement).checked })}
              />{' '}
              {t(sw.label)}
            </label>{' '}
            <Info text={t(sw.tip)} />
          </div>
        ))}
        <button type="submit" data-testid="sec-save" title={t('admin.sec.save.tip')} disabled={busy}>
          {t('admin.sec.save')}
        </button>
      </form>
    </section>
  );
}
