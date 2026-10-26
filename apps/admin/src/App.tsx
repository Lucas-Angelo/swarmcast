import { useEffect, useState } from 'preact/hooks';
import { HASH_FAILURE_THRESHOLD } from '@swarmcast/shared/constants';
import type { ActivityEntry, AdminLogMessage, AdminState, DirectCheckResponse, Settings, ViewerInfo } from '@swarmcast/shared';
import { formatNumber, getLang, guideUrl, humanDuration, LANGS, t, tc, toLang, translate, type Lang } from '@swarmcast/shared/i18n';
import { applyLang, rememberLang } from '@swarmcast/shared/i18n/browser';
import { ActivityConsole } from './Activity.js';
import { api, errorText, post, subscribe } from './api.js';
import { DesktopCard, UpdateBanner } from './DesktopCard.js';
import { DiagnosticsCard } from './DiagnosticsCard.js';
import { loadDesktop, setDesktop } from './desktop.js';
import { Info } from './Info.js';
import { Onboarding, RedoTutorialButton } from './onboarding/Onboarding.js';
import { QualityCard } from './QualityCard.js';
import { SecurityCard } from './Security.js';

const ACTIVITY_KEEP = 500;

function useCopy(): [string | null, (key: string, text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (key: string, text: string): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    });
  };
  return [copied, copy];
}

function mb(bytes: number): string {
  return `${formatNumber(Math.round(bytes / 1e5) / 10)} MB`;
}

function mbps(kbps: number): string {
  return formatNumber(Math.round(kbps / 100) / 10);
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString(getLang(), { hour: '2-digit', minute: '2-digit' });
}

type Act = (key: string, fn: () => Promise<unknown>) => Promise<void>;

export function App() {
  const [s, setS] = useState<AdminState | null>(null);
  const [down, setDown] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [copied, copy] = useCopy();
  const [showKey, setShowKey] = useState(false);
  const [directOpen, setDirectOpen] = useState(false);
  const [lang, setLangState] = useState<Lang>(getLang());
  const [activity, setActivity] = useState<ActivityEntry[]>([]);

  useEffect(
    () =>
      subscribe(
        setS,
        setDown,
        (m: AdminLogMessage) => setActivity((prev) => (m.reset ? m.entries : [...prev, ...m.entries]).slice(-ACTIVITY_KEEP)),
        setDesktop,
      ),
    [],
  );
  // Desktop app only (null in script mode: its card and banner stay hidden).
  useEffect(() => {
    void loadDesktop((p, m) => api(p, m)).then((d) => {
      if (d) setDesktop(d);
    });
  }, []);

  const changeLang = (l: Lang): void => {
    applyLang(l);
    rememberLang(l);
    document.title = t('admin.title');
    setLangState(l);
  };

  const act: Act = async (key, fn) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  if (!s) return <div class="wrap"><p>{down ? t('admin.unreachable') : t('admin.loading')}</p></div>;

  const on = s.phase !== 'off';
  const live = s.phase === 'live';
  const statusText =
    s.phase === 'off'
      ? t('admin.status.off')
      : s.phase === 'starting'
        ? t('admin.status.starting')
        : s.phase === 'stopping'
          ? t('admin.status.stopping')
          : s.phase === 'waiting-obs'
            ? t('admin.status.waiting')
            : t('admin.status.live', { count: s.stats.viewersConnected });
  const dotClass = live ? 'live' : on ? 'waiting' : '';
  const linkFresh = s.tunnelUrlChangedAt && Date.now() - s.tunnelUrlChangedAt < 5 * 60_000;
  const running = s.phase === 'waiting-obs' || s.phase === 'live';
  const autoStopLeft = s.autoStopAt && !live ? s.autoStopAt - Date.now() : null;
  const autoStopText =
    s.autoStopAt && autoStopLeft !== null && running ? t('admin.autoStop', { time: humanDuration(Math.max(0, autoStopLeft)), clock: clock(s.autoStopAt) }) : null;
  const autoStopTip = t('admin.autoStop.tip', { minutes: s.settings.autoStopMinutes });

  return (
    <div class="wrap" lang={lang}>
      <header class="top">
        <div class="top-main">
          <div class="brand sc-brand">
            <span class="sc-symbol" aria-hidden="true" />
            <span class="sc-wordmark">SwarmCast</span>
          </div>
          <div class="row tight">
            <div class="state" data-testid="status">
              <span class={`dot ${dotClass}`} /> {statusText}
            </div>
            <Info text={t('admin.status.tip')} />
          </div>
          {running && (
            <div class="row tight">
              <span class={`pill ${s.obsConnected ? 'pill-ok' : 'pill-wait'}`} data-testid="obs-status">
                {s.obsConnected
                  ? s.obsBitrateKbps > 0
                    ? t('admin.obs.pillSending', { mbps: mbps(s.obsBitrateKbps) })
                    : t('admin.obs.pillSendingNoRate')
                  : t('admin.obs.pillWaiting')}
              </span>
              <Info text={t('admin.obs.pill.tip')} />
            </div>
          )}
          {s.phase === 'waiting-obs' && <p class="hint">{s.obsConnected ? t('admin.obs.preparing') : t('admin.obs.hint')}</p>}
          {autoStopText && (
            <div class="row tight">
              <span class="muted small" data-testid="auto-stop">{autoStopText}</span>
              <Info text={autoStopTip} />
            </div>
          )}
          {s.mode === 'direct' && (
            <div class="row tight">
              <span class="small danger-text strong">{t('admin.directBanner')}</span>
              <Info text={t('admin.directBanner.tip')} />
            </div>
          )}
        </div>
        <div class="top-action">
          {on ? (
            <button class="danger big" data-testid="stop" title={t('admin.stopAll.tip')} disabled={busy !== null || s.phase === 'stopping'} onClick={() => act('stop', () => post('/api/live/stop'))}>
              {t('admin.stopAll')}
            </button>
          ) : (
            <button class="primary big" data-testid="start" title={t('admin.turnOn.tip')} disabled={busy !== null} onClick={() => act('start', () => post('/api/live/start'))}>
              {t('admin.turnOn')}
            </button>
          )}
          <Info text={on ? t('admin.stopAll.tip') : t('admin.turnOn.tip')} />
        </div>
      </header>

      {down && <div class="err">{t('admin.lostConnection')}</div>}
      {error !== null && <div class="err" data-testid="error">{errorText(error)}</div>}
      <UpdateBanner phase={s.phase} />
      {s.warnings.map((w, i) => (
        <div class="warn" key={w}>{tc(s.warningCodes?.[i], w)}</div>
      ))}
      {s.direct.staleMappingWarning && (
        <div class="warn">
          {t('admin.stale')}{' '}
          <button class="small" title={t('admin.stale.close.tip')} onClick={() => act('stale', () => post('/api/direct/cleanup-stale'))}>{t('admin.stale.close')}</button>
        </div>
      )}

      {s.steps.length > 0 && (s.phase === 'starting' || s.phase === 'stopping' || s.steps.some((x) => x.status === 'error')) && (
        <div class="card mt">
          <h2 class="row-title">
            {s.phase === 'stopping' || s.steps[0]?.id === 'viewers' ? t('admin.steps.stopping') : t('admin.steps.starting')} <Info text={t('admin.steps.tip')} />
          </h2>
          <ul class="steps" data-testid="steps">
            {s.steps.map((st) => (
              <li key={st.id}>
                {st.status === 'ok' ? '✓' : st.status === 'error' ? '✗' : st.status === 'running' ? '…' : '○'} {tc({ code: st.labelKey }, st.label)}
                {st.error && <span class="error">{tc({ code: st.errorCode, params: st.errorParams }, st.error)}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div class="grid">
        <section class={`card ${linkFresh ? 'highlight' : ''}`}>
          <h2 class="row-title">
            {t('admin.link.title')} <Info text={t('admin.link.tip')} />
          </h2>
          {s.liveLink ? (
            <>
              {linkFresh && <p class="small accent-text strong">{t('admin.link.new')}</p>}
              <div class="row">
                <code class="value" data-testid="live-link">{s.liveLink}</code>
              </div>
              <div class="row">
                <button class="primary" title={t('admin.link.copy.tip')} onClick={() => copy('link', s.liveLink!)}>{copied === 'link' ? t('common.copied') : t('admin.link.copy')}</button>
              </div>
              <div class="row">
                <button data-testid="rotate" title={t('admin.link.rotate.tip')} disabled={busy !== null} onClick={() => act('rotate', () => post('/api/link/rotate'))}>{t('admin.link.rotate')}</button>
                <Info text={t('admin.link.rotate.tip')} />
                <button title={t('admin.link.disconnectAll.tip')} disabled={busy !== null} onClick={() => act('dc', () => post('/api/viewers/disconnect-all'))}>{t('admin.link.disconnectAll')}</button>
                <Info text={t('admin.link.disconnectAll.tip')} />
              </div>
              <p class="muted small">{t('admin.link.note')}</p>
            </>
          ) : (
            <p class="muted">{on ? t('admin.link.preparing') : t('admin.link.off')}</p>
          )}
        </section>

        <section class="card">
          <h2 class="row-title">
            {t('admin.obs.title')} <Info text={t('admin.obs.help.tip')} />
          </h2>
          <p class="muted small">{t('admin.obs.help')}</p>
          <div class="row">
            <span class="label-w">{t('admin.obs.server')} <Info text={t('admin.obs.server.tip')} /></span>
            <code class="value" data-testid="rtmp-url">{s.rtmpUrl}</code>
            <button class="small" title={t('admin.obs.copyServer.tip')} onClick={() => copy('rtmp', s.rtmpUrl)}>{copied === 'rtmp' ? t('common.copiedShort') : t('common.copy')}</button>
          </div>
          <div class="row">
            <span class="label-w">{t('admin.obs.key')} <Info text={t('admin.obs.key.tip')} /></span>
            <code class="value">{showKey ? s.streamKey : '•'.repeat(18)}</code>
            <button class="small" title={t('admin.obs.show.tip')} onClick={() => setShowKey(!showKey)}>{showKey ? t('admin.obs.hide') : t('admin.obs.show')}</button>
            <button class="small" title={t('admin.obs.copyKey.tip')} onClick={() => copy('key', s.streamKey)}>{copied === 'key' ? t('common.copiedShort') : t('common.copy')}</button>
          </div>
          <div class="row tight small">
            {s.obsConnected ? <span class="ok ok-dot">{t('admin.obs.sending', { mbps: mbps(s.obsBitrateKbps) })}</span> : <span class="muted">{t('admin.obs.none')}</span>}
            <Info text={t('admin.obs.pill.tip')} />
          </div>
          {autoStopText && (
            <div class="row tight">
              <span class="muted small">{autoStopText}</span>
              <Info text={autoStopTip} />
            </div>
          )}
        </section>

        <section class="card">
          <h2 class="row-title">
            {t('admin.p2p.title')} <Info text={t('admin.p2p.tip')} />
          </h2>
          <div class="stats">
            <Stat label={t('admin.stat.watching')} tip={t('admin.stat.watching.tip')} value={String(s.stats.viewersConnected)} testid="viewer-count" />
            <Stat label={t('admin.stat.helping')} tip={t('admin.stat.helping.tip')} value={String(s.stats.viewersHelping)} />
            <Stat label={t('admin.stat.fromPeers')} tip={t('admin.stat.fromPeers.tip')} value={`${s.stats.p2pSharePercent}%`} />
            <Stat label={t('admin.stat.upload')} tip={t('admin.stat.upload.tip')} value={`${formatNumber(s.stats.originUploadMbps)} Mbps`} />
          </div>
          <div class={`row tight ${s.capacity.level === 'over' ? 'err' : s.capacity.level === 'near' ? 'warn' : 'small'}`}>
            <span>
              {tc(s.capacity, s.capacity.message)} <Info text={t('admin.capacity.tip')} />
            </span>
          </div>
          {s.capacity.withP2PViewers > s.capacity.directViewers && (
            <p class="muted small">{t('admin.capacity.withP2P', { count: s.capacity.withP2PViewers })}</p>
          )}
        </section>

        <section class="card">
          <h2 class="row-title">
            {t('admin.net.title')} <Info text={t('admin.net.tip')} />
          </h2>
          {s.speedTest ? (
            <div>
              <div class="row tight">
                {t('admin.net.upload')} <b>{formatNumber(s.speedTest.uploadMbps)} Mbps</b> <Info text={t('admin.net.upload.tip')} /> ·{' '}
                {t('admin.net.download')} <b>{formatNumber(s.speedTest.downloadMbps)} Mbps</b> <Info text={t('admin.net.download.tip')} /> ·{' '}
                {t('admin.net.ping')} {Math.round(s.speedTest.latencyMs)} ms <Info text={t('admin.net.ping.tip')} />
              </div>
              <div class="row tight">
                <span class="muted small">{t('admin.net.measured', { clock: clock(s.speedTest.at) })}</span>
                <Info text={t('admin.net.measured.tip', { source: s.speedTest.source })} />
              </div>
            </div>
          ) : (
            <p class="muted">{s.speedTestRunning ? t('admin.net.testing') : t('admin.net.none')}</p>
          )}
          <button disabled={s.speedTestRunning} title={t('admin.net.test.tip')} onClick={() => act('speed', () => post('/api/speedtest'))}>
            {s.speedTestRunning ? t('admin.net.testingBtn') : t('admin.net.test')}
          </button>
          {on && <p class="muted small">{t('admin.net.duringStream')}</p>}
          <SettingsForm
            settings={s.settings}
            recommended={s.capacity.recommendedLimitMbps}
            effective={{ maxViewers: s.security.effectiveMaxViewers, maxSessionsPerDevice: s.security.effectiveMaxSessionsPerDevice }}
            onSave={(v) => act('settings', () => api('/api/settings', 'PUT', v))}
          />
        </section>

        <section class="card">
          <h2 class="row-title">
            {t('admin.mode.title')} <Info text={t('admin.mode.tip')} />
          </h2>
          {s.mode === 'secure' ? (
            <>
              <p>
                <b>{t('admin.mode.secureName')}</b> {t('admin.mode.secureDesc')}
              </p>
              <p class="muted small">{t('admin.mode.secureNote')}</p>
              {s.direct.suggestion && <div class="warn">{tc({ code: s.direct.suggestionCode }, s.direct.suggestion)}</div>}
              <div class="row tight">
                <button disabled={!on || busy !== null} title={on ? t('admin.mode.useDirect.tip') : t('admin.mode.useDirect.off')} onClick={() => setDirectOpen(true)} data-testid="direct-open">
                  {t('admin.mode.useDirect')}
                </button>
                <Info text={t('admin.mode.useDirect.tip')} />
              </div>
            </>
          ) : (
            <>
              <p class="danger-text">
                <b>{t('admin.mode.directOn')}</b> {t('admin.mode.directDesc', { ip: s.direct.publicIp ?? '?', port: s.direct.externalPort ?? '?' })}
              </p>
              <div class="row tight small">
                {t('admin.mode.seen')} <b>{s.direct.viewersSeen}</b> <Info text={t('admin.mode.seen.tip')} />
              </div>
              <div class="row tight small">
                {t('admin.mode.cert')} {s.direct.certificate === 'letsencrypt' ? t('admin.mode.certLe') : t('admin.mode.certSelf')} <Info text={t('admin.mode.cert.tip')} />
              </div>
              <button class="primary" title={t('admin.mode.backSecure.tip')} disabled={busy !== null} onClick={() => act('secure', () => post('/api/direct/disable'))}>
                {t('admin.mode.backSecure')}
              </button>
            </>
          )}
          {s.direct.lastExposedIp && s.mode === 'secure' && (
            <p class="small muted">
              {s.direct.ipChangedSinceLastDirect === true && t('direct.ipChanged')}
              {s.direct.ipChangedSinceLastDirect === false && t('admin.mode.ipSameLong')}
            </p>
          )}
        </section>

        <SecurityCard s={s} busy={busy !== null} act={act} />
      </div>

      <QualityCard live={s.phase === 'live'} />

      <DesktopCard />

      <section class="card mt">
        <h2 class="row-title">
          {t('admin.viewers.title')} <Info text={t('admin.viewers.tip')} />
          {s.bannedCount > 0 && (
            <>
              <span class="muted small">· {t('admin.viewers.removed', { count: s.bannedCount })}</span>
              <Info text={t('admin.viewers.removed.tip')} />
              <button class="small" title={t('admin.viewers.unban.tip')} onClick={() => act('bans', () => post('/api/bans/clear'))}>{t('admin.viewers.unban')}</button>
            </>
          )}
        </h2>
        {s.viewers.length === 0 ? (
          <div class="empty">
            <span class="sc-mascot sc-mascot-sleep" aria-hidden="true" />
            <p class="muted">{t('admin.viewers.nobody')}</p>
          </div>
        ) : (
          <div class="table-wrap">
            <table data-testid="viewers">
              <thead>
                <tr>
                  <Th label={t('admin.col.nick')} tip={t('admin.col.nick.tip')} />
                  <Th label={t('admin.col.device')} tip={t('admin.col.device.tip')} />
                  <Th label={t('admin.col.p2p')} tip={t('admin.col.p2p.tip')} />
                  <Th label={t('admin.col.shared')} tip={t('admin.col.shared.tip')} />
                  <Th label={t('admin.col.bad')} tip={t('admin.col.bad.tip', { count: HASH_FAILURE_THRESHOLD })} />
                  <Th label={t('admin.col.actions')} tip={t('admin.col.actions.tip')} />
                </tr>
              </thead>
              <tbody>
                {s.viewers.map((v) => (
                  <ViewerRow key={v.sessionId} v={v} busy={busy !== null} act={act} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ActivityConsole
        entries={activity}
        copied={copied === 'activity'}
        onCopy={(text) => copy('activity', text)}
        onClear={() => void act('clear-log', () => post('/api/activity/clear'))}
      />

      <DiagnosticsCard />

      <footer>
        <span class="muted small">{t('admin.version', { version: s.version })}</span>
        <span class="row tight">
          <select class="lang-select" aria-label={t('admin.lang')} title={t('admin.lang.tip')} data-testid="ui-lang" value={lang} onChange={(e) => changeLang(toLang((e.target as HTMLSelectElement).value) ?? 'en')}>
            {LANGS.map((l) => (
              <option key={l} value={l}>
                {translate(l, 'lang.name')}
              </option>
            ))}
          </select>
          <Info text={t('admin.lang.tip')} />
          <a class="button" href={guideUrl(lang)} target="_blank" rel="noopener noreferrer" title={t('admin.help.tip')} data-testid="help-link">
            {t('admin.help')}
          </a>
          <RedoTutorialButton />
          <button title={t('admin.quit.tip')} onClick={() => act('quit', () => post('/api/app/quit'))}>{t('admin.quit')}</button>
        </span>
      </footer>

      {directOpen && <DirectModal onClose={() => setDirectOpen(false)} />}
      <Onboarding state={s} />
    </div>
  );
}

function Stat({ label, tip, value, testid }: { label: string; tip: string; value: string; testid?: string }) {
  return (
    <div class="stat">
      <span class="muted small stat-label">
        {label} <Info text={tip} />
      </span>
      <b data-testid={testid}>{value}</b>
    </div>
  );
}

function Th({ label, tip }: { label: string; tip: string }) {
  return (
    <th>
      <span class="th-inner">
        {label} <Info text={tip} />
      </span>
    </th>
  );
}

function ViewerRow({ v, busy, act }: { v: ViewerInfo; busy: boolean; act: Act }) {
  const p2p = !v.p2pAllowed ? (
    v.autoRemovedFromP2P ? (
      <span class="badge off" title={t('admin.badge.removedBad.tip')}>{t('admin.badge.removedBad')}</span>
    ) : (
      <span class="badge off" title={t('admin.badge.removed.tip')}>{t('admin.badge.removed')}</span>
    )
  ) : v.p2pEnabled ? (
    <span class="badge on" title={t('admin.badge.on.tip')}>{t('admin.badge.on')}</span>
  ) : (
    <span class="badge" title={t('admin.badge.off.tip')}>{t('admin.badge.off')}</span>
  );
  return (
    <tr data-testid={`viewer-${v.nickname}`}>
      <td>
        {v.nickname} {!v.connected && <span class="muted small">{t('admin.viewer.away')}</span>}
      </td>
      <td>{v.device === 'mobile' ? t('admin.viewer.phone') : t('admin.viewer.pc')}</td>
      <td>{p2p}</td>
      <td>{mb(v.p2pUpBytes)}</td>
      <td>{v.hashFailures}</td>
      <td class="actions">
        {v.p2pAllowed ? (
          <button class="small" title={t('admin.viewer.removeP2P.tip')} disabled={busy} onClick={() => act('p2p', () => post(`/api/viewers/${v.sessionId}/p2p`, { allowed: false }))}>
            {t('admin.viewer.removeP2P')}
          </button>
        ) : (
          <button class="small" title={t('admin.viewer.allowP2P.tip')} disabled={busy} onClick={() => act('p2p', () => post(`/api/viewers/${v.sessionId}/p2p`, { allowed: true }))}>
            {t('admin.viewer.allowP2P')}
          </button>
        )}
        <button class="small danger" title={t('admin.viewer.kick.tip')} disabled={busy} onClick={() => act('kick', () => post(`/api/viewers/${v.sessionId}/kick`))}>
          {t('admin.viewer.kick')}
        </button>
      </td>
    </tr>
  );
}

function SettingsForm({
  settings,
  recommended,
  effective,
  onSave,
}: {
  settings: Settings;
  recommended: number;
  /** Limits in force right now (lower than the settings while attack protection tightens them). */
  effective: { maxViewers: number; maxSessionsPerDevice: number };
  onSave: (s: Settings) => void;
}) {
  const [v, setV] = useState(settings);
  useEffect(
    () => setV(settings),
    [settings.uploadLimitMbps, settings.autoStopMinutes, settings.alsoStreamingElsewhere, settings.showViewerCount, settings.maxViewers, settings.maxSessionsPerDevice],
  );
  return (
    <form
      class="mt"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(v);
      }}
    >
      <div class="field">
        <label>
          {t('admin.set.maxUpload')}{' '}
          <input type="number" min={1} max={10000} value={v.uploadLimitMbps} onInput={(e) => setV({ ...v, uploadLimitMbps: Number((e.target as HTMLInputElement).value) })} /> Mbps
        </label>
        {recommended > 0 && <span class="muted small"> {t('admin.set.recommended', { value: recommended })}</span>} <Info text={t('admin.set.maxUpload.tip')} />
      </div>
      <div class="field">
        <label>
          {t('admin.set.autoStop')}{' '}
          <input type="number" min={1} max={1440} value={v.autoStopMinutes} onInput={(e) => setV({ ...v, autoStopMinutes: Number((e.target as HTMLInputElement).value) })} />{' '}
          {t('admin.set.autoStopUnit')}
        </label>{' '}
        <Info text={t('admin.set.autoStop.tip')} />
      </div>
      <div class="field">
        <label>
          <input type="checkbox" checked={v.alsoStreamingElsewhere} onChange={(e) => setV({ ...v, alsoStreamingElsewhere: (e.target as HTMLInputElement).checked })} /> {t('admin.set.elsewhere')}
        </label>{' '}
        <Info text={t('admin.set.elsewhere.tip')} />
      </div>
      <div class="field">
        <label>
          <input
            type="checkbox"
            data-testid="show-viewer-count"
            checked={v.showViewerCount}
            onChange={(e) => setV({ ...v, showViewerCount: (e.target as HTMLInputElement).checked })}
          />{' '}
          {t('admin.set.showCount')}
        </label>{' '}
        <Info text={t('admin.set.showCount.tip')} />
      </div>
      <div class="field">
        <label>
          {t('admin.set.maxViewers')}{' '}
          <input
            type="number"
            data-testid="max-viewers"
            min={1}
            max={100000}
            value={v.maxViewers}
            onInput={(e) => setV({ ...v, maxViewers: Number((e.target as HTMLInputElement).value) })}
          />
        </label>
        {settings.maxViewers !== undefined && effective.maxViewers < settings.maxViewers && (
          <span class="small warn-text"> {t('admin.set.effectiveNow', { value: effective.maxViewers })}</span>
        )}{' '}
        <Info text={t('admin.set.maxViewers.tip')} />
      </div>
      <div class="field">
        <label>
          {t('admin.set.maxPerDevice')}{' '}
          <input
            type="number"
            data-testid="max-per-device"
            min={1}
            max={20}
            value={v.maxSessionsPerDevice}
            onInput={(e) => setV({ ...v, maxSessionsPerDevice: Number((e.target as HTMLInputElement).value) })}
          />
        </label>
        {settings.maxSessionsPerDevice !== undefined && effective.maxSessionsPerDevice < settings.maxSessionsPerDevice && (
          <span class="small warn-text"> {t('admin.set.effectiveNow', { value: effective.maxSessionsPerDevice })}</span>
        )}{' '}
        <Info text={t('admin.set.maxPerDevice.tip')} />
      </div>
      <button type="submit" title={t('admin.set.save.tip')}>{t('admin.set.save')}</button>
    </form>
  );
}

function DirectModal({ onClose }: { onClose: () => void }) {
  const [check, setCheck] = useState<DirectCheckResponse | null>(null);
  const [ack, setAck] = useState(false);
  const [manual, setManual] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    post<DirectCheckResponse>('/api/direct/check').then(setCheck, (e: unknown) => setErr(e));
  }, []);

  const enable = async (): Promise<void> => {
    setWorking(true);
    setErr(null);
    try {
      await post('/api/direct/enable', { acknowledgeRisks: true, manualPortForward: manual || undefined });
      onClose();
    } catch (e) {
      setErr(e);
    } finally {
      setWorking(false);
    }
  };

  const checkText = check ? tc(check, check.message) : '';
  return (
    <div class="modal-bg" role="dialog" aria-modal="true" aria-labelledby="direct-title">
      <div class="modal">
        <h2 id="direct-title">{t('direct.title')}</h2>
        <div class="err">
          <b>{t('direct.riskBold')}</b> {t('direct.risk')}
        </div>
        <p class="small">{t('direct.when')}</p>
        {!check && err === null && <p class="muted">{t('direct.checking')}</p>}
        {check && !check.ok && <div class="err" data-testid="direct-check">{checkText}</div>}
        {check && check.ok && (
          <>
            <p class="small" data-testid="direct-check">{checkText}</p>
            {check.needsManualForward && (
              <div class="warn small">
                {t('direct.manual')}
                <label class="field">
                  <input type="checkbox" checked={manual} onChange={(e) => setManual((e.target as HTMLInputElement).checked)} /> {t('direct.manualAck')}
                </label>
              </div>
            )}
            <div class="field">
              <label>
                <input type="checkbox" data-testid="ack" checked={ack} onChange={(e) => setAck((e.target as HTMLInputElement).checked)} /> {t('direct.ack')}
              </label>{' '}
              <Info text={t('direct.ack.tip')} />
            </div>
          </>
        )}
        {err !== null && <div class="err">{errorText(err)}</div>}
        <div class="row end mt">
          <button onClick={onClose}>{t('common.cancel')}</button>
          <button
            class="danger"
            data-testid="direct-enable"
            title={t('direct.enable.tip')}
            disabled={!check?.ok || !ack || working || (check.needsManualForward && !manual)}
            onClick={() => void enable()}
          >
            {working ? t('direct.enabling') : t('direct.enable')}
          </button>
        </div>
      </div>
    </div>
  );
}
