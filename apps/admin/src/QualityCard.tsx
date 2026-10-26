import { useEffect, useState } from 'preact/hooks';
import type { QualitySettingsUpdate, QualityState, TranscodeHeight } from '@swarmcast/shared';
import { ENCODER_IDS, TRANSCODE_HEIGHTS, encoderLabelKey } from '@swarmcast/shared';
import { formatNumber, t, tc, type MessageKey } from '@swarmcast/shared/i18n';
import { api, errorText, post } from './api.js';
import { Info } from './Info.js';

type Install = { phase: string; receivedBytes: number; totalBytes?: number; message?: string } | null;
type State = QualityState & { install: Install };

const PHASE_KEY: Record<QualityState['upload']['phase'], MessageKey> = {
  manual: 'quality.upload.phase.manual',
  starting: 'quality.upload.phase.starting',
  increasing: 'quality.upload.phase.increasing',
  holding: 'quality.upload.phase.holding',
  'backing-off': 'quality.upload.phase.backingOff',
};

const TRANSCODER_KEY: Record<QualityState['transcoder']['status'], MessageKey> = {
  off: 'quality.converter.off',
  'waiting-source': 'quality.converter.waiting',
  starting: 'quality.converter.starting',
  running: 'quality.converter.running',
  restarting: 'quality.converter.restarting',
  failed: 'quality.converter.failed',
};

const OTHER_SOURCE_KEY: Record<QualityState['upload']['otherStreamSource'], MessageKey> = {
  'obs-websocket': 'quality.upload.other.fromObs',
  'obs-bitrate': 'quality.upload.other.fromBitrate',
  manual: 'quality.upload.other.manual',
  none: 'quality.upload.other.none',
};

const mb = (n: number): string => formatNumber(Math.round(n / 1e5) / 10);

function Mark({ kind }: { kind: 'ok' | 'warn' | 'bad' | 'wait' }) {
  const sym = kind === 'ok' ? '✓' : kind === 'warn' ? '⚠' : kind === 'bad' ? '✗' : '…';
  return <span class={`mark mark-${kind}`} aria-hidden="true">{sym}</span>;
}

/**
 * "Quality for viewers": what this PC can do (ffmpeg, graphics-chip encoder or CPU fallback,
 * cost, renditions, upload budget), the "Stream in multiple qualities" switch with the
 * renditions to offer, the adaptive upload cap and obs-websocket. Polls GET /api/quality.
 */
export function QualityCard({ live = false }: { live?: boolean }) {
  const [q, setQ] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');

  useEffect(() => {
    let stopped = false;
    const load = (): void => {
      api<State>('/api/quality', 'GET').then(
        (s) => {
          if (!stopped) setQ(s);
        },
        (e: unknown) => {
          if (!stopped) setError(errorText(e));
        },
      );
    };
    load();
    const timer = window.setInterval(load, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  if (!q) {
    return (
      <section class="card mt" data-testid="quality-card">
        <h2 class="row-title">{t('quality.title')}</h2>
        <p class="muted">{error ?? t('admin.loading')}</p>
      </section>
    );
  }

  const save = async (patch: (s: QualitySettingsUpdate) => void): Promise<void> => {
    const next = JSON.parse(JSON.stringify({ ...q.settings, obsWebsocket: { enabled: q.settings.obsWebsocket.enabled, url: q.settings.obsWebsocket.url } })) as QualitySettingsUpdate;
    patch(next);
    setBusy(true);
    setError(null);
    try {
      setQ(await api<State>('/api/quality', 'PUT', next));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const run = async (path: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setQ(await post<State>(path));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const s = q.settings;
  const u = q.upload;
  const pc = q.pc;
  const installing = !!q.install && !['done', 'error'].includes(q.install.phase);
  const srcHeight = q.source?.height ?? 1080;
  const manual = s.ladder.mode === 'manual';
  const supported = q.supportedHeights;
  // What the switch and the boxes show: the streamer's choice, or what auto mode picked.
  const on = manual ? s.ladder.enabled : q.ffmpeg.available && supported.length > 0;
  const selected: TranscodeHeight[] = manual ? s.ladder.heights : supported;
  const working = q.encoders.filter((e) => e.ok);
  const softPick = pc.software?.pick ?? null;

  const choose = (enabled: boolean, heights: TranscodeHeight[]): Promise<void> =>
    save((x) => {
      x.ladder.mode = 'manual';
      x.ladder.enabled = enabled;
      x.ladder.heights = [...new Set(heights)].sort((a, b) => b - a);
    });

  const whyDisabled = (h: TranscodeHeight): string | null => {
    if (!q.ffmpeg.available) return t('quality.rendition.needsFfmpeg');
    if (h > srcHeight - 120) return t('quality.rendition.notBelowSource', { height: srcHeight });
    if (supported.includes(h)) return null;
    if (q.probing) return t('quality.pc.probing');
    if (softPick) return t('quality.rendition.cpuOnlyOne', { height: softPick.height });
    return t('quality.rendition.unsupported');
  };

  const encoderName = pc.hardware ? t(encoderLabelKey(pc.hardware)) : null;

  return (
    <section class="card mt" data-testid="quality-card">
      <h2 class="row-title">
        {t('quality.title')} <Info text={t('quality.title.tip')} />
      </h2>

      <div class="quality-cols">
        <div>
          <h3 class="subhead row-title">
            {t('quality.pc.title')} <Info text={t('quality.pc.tip')} />
          </h3>
          <ul class="pc-list" data-testid="quality-pc">
            <li>
              <Mark kind={q.ffmpeg.available ? 'ok' : 'bad'} /> {q.ffmpeg.available ? t('quality.pc.ffmpegOk') : t('quality.pc.ffmpegMissing')}{' '}
              <Info text={t('quality.pc.ffmpeg.tip')} />
              {!q.ffmpeg.available && (
                <div class="pc-detail">
                  <p class="muted small">{t('quality.pc.ffmpegInstallerNote')}</p>
                  <div class="row tight">
                    <button class="small primary" disabled={busy || installing} onClick={() => void run('/api/quality/ffmpeg/install')} data-testid="install-ffmpeg">
                      {installing
                        ? q.install!.totalBytes
                          ? t('quality.install.progressOf', { mb: mb(q.install!.receivedBytes), total: mb(q.install!.totalBytes) })
                          : t('quality.install.progress', { mb: mb(q.install!.receivedBytes) })
                        : t('quality.install.button')}
                    </button>
                    <Info text={t('quality.install.tip')} />
                  </div>
                  {q.install?.phase === 'error' && <div class="err small">{t('quality.install.failed', { error: q.install.message ?? '?' })}</div>}
                </div>
              )}
            </li>
            {q.ffmpeg.available && (
              <li data-testid="quality-encoder">
                {q.encoders.length === 0 ? (
                  <>
                    <Mark kind="wait" /> {q.probing ? t('quality.pc.probing') : tc(pc.reason, pc.reason.text)}
                  </>
                ) : encoderName ? (
                  <>
                    <Mark kind="ok" /> {t('quality.pc.hardwareOk', { name: encoderName })} <Info text={t('quality.pc.hardware.tip')} />
                  </>
                ) : (
                  <>
                    <Mark kind="warn" /> {t('quality.pc.hardwareNone')} <Info text={t('quality.pc.hardware.tip')} />
                    <div class="pc-detail">
                      <Mark kind={softPick ? 'ok' : q.probing ? 'wait' : 'bad'} /> {tc(pc.reason, pc.reason.text)} <Info text={t('quality.pc.cpu.tip')} />
                    </div>
                  </>
                )}
              </li>
            )}
            {q.ffmpeg.available && pc.costCores !== undefined && (
              <li>
                <Mark kind={pc.hardware ? 'ok' : 'warn'} />{' '}
                {pc.hardware
                  ? t('quality.pc.costGpu', { percent: pc.costPercent ?? 1 })
                  : t('quality.pc.costCpu', { cores: pc.costCores, percent: pc.costPercent ?? 1 })}{' '}
                <Info text={t('quality.pc.cost.tip')} />
              </li>
            )}
            {(!q.ffmpeg.available || q.encoders.length > 0) && (
              <li data-testid="quality-can-make">
                <Mark kind={supported.length ? 'ok' : 'bad'} />{' '}
                {supported.length ? t('quality.pc.canMake', { heights: supported.map((h) => `${h}p`).join(', ') }) : t('quality.pc.canMakeNone')}{' '}
                <Info text={t('quality.pc.canMake.tip')} />
              </li>
            )}
            <li>
              <Mark kind={u.capMbps > 0 ? 'ok' : 'warn'} /> {t('quality.pc.budget', { mbps: formatNumber(u.capMbps) })} <Info text={t('quality.pc.budget.tip')} />
              <div class="pc-detail small">
                {q.renditionCosts.map((r) => (
                  <span key={`${r.height}-${r.source}`} class="budget-item">
                    {t(r.source ? 'quality.pc.budgetSource' : 'quality.pc.budgetItem', { height: r.height, mbps: formatNumber(Math.round(r.kbps / 100) / 10), count: r.viewers })}
                  </span>
                ))}
              </div>
            </li>
          </ul>
          {q.ffmpeg.available && (
            <div class="row tight">
              <button class="small" disabled={busy || q.probing || live} onClick={() => void run('/api/quality/probe')} data-testid="quality-recheck">
                {q.probing ? t('quality.pc.checking') : t('quality.pc.recheck')}
              </button>
              <Info text={live ? t('quality.pc.recheckLive') : t('quality.pc.recheck.tip')} />
            </div>
          )}
        </div>

        <div>
          <div class="row">
            <label class="switch-label">
              <input
                type="checkbox"
                role="switch"
                checked={on}
                disabled={busy || !q.ffmpeg.available}
                data-testid="quality-switch"
                onChange={(e) => {
                  const enable = (e.target as HTMLInputElement).checked;
                  void choose(enable, enable && selected.length === 0 ? supported : selected);
                }}
              />{' '}
              <b>{t('quality.switch')}</b>
            </label>
            <Info text={t('quality.switch.tip')} />
            <span class="badge">{manual ? t('quality.mode.manual') : t('quality.mode.auto')}</span>
            <Info text={manual ? t('quality.mode.manual.tip') : t('quality.mode.auto.tip')} />
          </div>
          {manual && (
            <div class="row tight">
              <button class="small" disabled={busy} onClick={() => void save((x) => (x.ladder.mode = 'auto'))} data-testid="quality-auto">
                {t('quality.mode.useAuto')}
              </button>
              <Info text={t('quality.mode.useAuto.tip')} />
            </div>
          )}
          <ul class="rendition-list" data-testid="quality-renditions">
            <li>
              <label>
                <input type="checkbox" checked disabled /> {t('quality.rendition.source', { height: srcHeight })}
              </label>{' '}
              <Info text={t('quality.rendition.source.tip')} />
            </li>
            {TRANSCODE_HEIGHTS.map((h) => {
              const why = whyDisabled(h);
              return (
                <li key={h}>
                  <label title={why ?? ''}>
                    <input
                      type="checkbox"
                      data-testid={`rendition-${h}`}
                      checked={on && selected.includes(h) && !why}
                      disabled={busy || !on || !!why}
                      onChange={(e) => {
                        const checked = (e.target as HTMLInputElement).checked;
                        const base = selected.filter((x) => supported.includes(x));
                        // With the CPU fallback only one rendition fits: picking one replaces the other.
                        const next = checked ? (pc.hardware ? [...base, h] : [h]) : base.filter((x) => x !== h);
                        void choose(true, next);
                      }}
                    />{' '}
                    {h}p
                  </label>{' '}
                  <Info text={t(`quality.rendition.${h}.tip` as MessageKey)} />
                  {why && <span class="muted small"> — {why}</span>}
                </li>
              );
            })}
          </ul>
          <p class="small now-line">
            {t('quality.now')} <b data-testid="quality-now">{(q.variants.length ? q.variants.map((v) => v.height) : q.plan.rungs.map((r) => r.height)).map((h) => `${h}p`).join(' · ')}</b>{' '}
            <Info text={t('quality.now.tip')} />
            {q.transcoder.status !== 'off' && (
              <span class="muted">
                {' '}
                · {t('quality.converter')} {t(TRANSCODER_KEY[q.transcoder.status])}
                {q.transcoder.speed !== undefined ? ` (${formatNumber(q.transcoder.speed)}×)` : ''}
              </span>
            )}
          </p>
          {q.plan.reasons.map((r) => (
            <p key={r.code + JSON.stringify(r.params ?? {})} class="muted small reason">
              {tc(r, r.text)}
            </p>
          ))}
          {q.shed && (
            <div class="warn small" data-testid="quality-shed">
              {t(q.shed.reason === 'behind' ? 'quality.shed.behind' : 'quality.shed.cpu', { heights: q.shed.heights.map((h) => `${h}p`).join(', ') })} <Info text={t('quality.shed.tip')} />
            </div>
          )}
          {q.transcoder.message && <div class="warn small">{tc(q.transcoder.message, q.transcoder.message.text)}</div>}
          {!on && <p class="muted small">{t('quality.offStable')}</p>}

          {q.ffmpeg.available && (
            <details class="mt-s">
              <summary class="small">{t('quality.advanced')}</summary>
              <div class="row small">
                {t('quality.encoder.label')}
                <select
                  value={s.ladder.encoder}
                  disabled={busy}
                  onChange={(e) =>
                    void save((x) => {
                      x.ladder.mode = 'manual';
                      x.ladder.enabled = on;
                      x.ladder.heights = selected;
                      x.ladder.encoder = (e.target as HTMLSelectElement).value as QualitySettingsUpdate['ladder']['encoder'];
                    })
                  }
                >
                  <option value="auto">{t('quality.encoder.best')}</option>
                  {ENCODER_IDS.map((id) => (
                    <option key={id} value={id} disabled={!working.some((w) => w.id === id)}>
                      {t(encoderLabelKey(id))}
                    </option>
                  ))}
                </select>
                <Info text={t('quality.encoder.tip')} />
              </div>
              <p class="muted small">
                {t('quality.encoder.tested')}{' '}
                {working.length ? working.map((e) => `${t(encoderLabelKey(e.id))}${e.fps ? ` ${e.fps} fps` : ''}`).join(', ') : t('quality.encoder.noneWork')}
              </p>
            </details>
          )}
        </div>
      </div>

      <h3 class="subhead row-title mt">
        {t('quality.upload.title')} <Info text={t('quality.upload.tip')} />
      </h3>
      <div class="row">
        <label>
          <input type="radio" name="upload-mode" checked={u.mode === 'auto'} disabled={busy} onChange={() => void save((x) => (x.upload.mode = 'auto'))} /> {t('quality.upload.auto')}
        </label>
        <Info text={t('quality.upload.auto.tip')} />
        <label>
          <input type="radio" name="upload-mode" checked={u.mode === 'manual'} disabled={busy} onChange={() => void save((x) => (x.upload.mode = 'manual'))} /> {t('quality.upload.fixed')}
        </label>
        <Info text={t('quality.upload.fixed.tip')} />
      </div>
      <div class="stats stats-4">
        <div class="stat">
          <span class="muted small stat-label">
            {t('quality.upload.cap')} <Info text={t('quality.upload.cap.tip')} />
          </span>
          <b>{formatNumber(u.capMbps)} Mbps</b>
          <span class="muted small">{t(PHASE_KEY[u.phase])}</span>
        </div>
        <div class="stat">
          <span class="muted small stat-label">
            {t('quality.upload.used')} <Info text={t('quality.upload.used.tip')} />
          </span>
          <b>{formatNumber(u.signals.usedMbps)} Mbps</b>
        </div>
        <div class="stat">
          <span class="muted small stat-label">
            {t('quality.upload.ceiling')} <Info text={t('quality.upload.ceiling.tip')} />
          </span>
          <b>{u.ceilingMbps !== undefined ? `${formatNumber(u.ceilingMbps)} Mbps` : '—'}</b>
          <span class="muted small">
            {u.measuredUploadMbps !== undefined
              ? t('quality.upload.ceilingFormula', { up: formatNumber(u.measuredUploadMbps), headroom: s.upload.headroomPercent })
              : t('quality.upload.runSpeedTest')}
          </span>
        </div>
        <div class="stat">
          <span class="muted small stat-label">
            {t('quality.upload.ping')} <Info text={t('quality.upload.ping.tip')} />
          </span>
          <b>{u.signals.queueDelayMs !== undefined ? `+${u.signals.queueDelayMs} ms` : '—'}</b>
          {u.signals.baseRttMs !== undefined && <span class="muted small">{t('quality.upload.pingBase', { ms: u.signals.baseRttMs })}</span>}
        </div>
      </div>
      {u.lastBackoff && (
        <p class="small muted">
          {t('quality.upload.lastBackoff', {
            clock: new Date(u.lastBackoff.at).toLocaleTimeString(),
            reason: tc(u.lastBackoff.code ? { code: u.lastBackoff.code, params: u.lastBackoff.params ?? null } : null, u.lastBackoff.reason),
            from: formatNumber(u.lastBackoff.fromMbps),
            to: formatNumber(u.lastBackoff.toMbps),
          })}
        </p>
      )}
      <label class="field small">
        {t('quality.upload.twitch')}{' '}
        <input
          type="number"
          min={0}
          max={100000}
          placeholder={t('quality.upload.twitchAuto', { kbps: u.otherStreamKbps })}
          value={s.upload.otherStreamKbps ?? ''}
          disabled={busy}
          onChange={(e) => {
            const v = (e.target as HTMLInputElement).value.trim();
            void save((x) => (x.upload.otherStreamKbps = v === '' ? null : Math.max(0, Math.round(Number(v)))));
          }}
        />{' '}
        <Info text={t('quality.upload.twitch.tip')} />{' '}
        <span class="muted">{s.upload.otherStreamKbps === null ? t(OTHER_SOURCE_KEY[u.otherStreamSource]) : t('quality.upload.other.manual')}</span>
      </label>
      <label class="field small">
        {t('quality.upload.headroom')}{' '}
        <input
          type="number"
          min={5}
          max={60}
          value={s.upload.headroomPercent}
          disabled={busy}
          onChange={(e) => void save((x) => (x.upload.headroomPercent = Math.min(60, Math.max(5, Number((e.target as HTMLInputElement).value) || 15))))}
        />{' '}
        <Info text={t('quality.upload.headroom.tip')} />
      </label>

      <details class="mt-s">
        <summary class="small">{t('quality.obs.title')}</summary>
        <p class="muted small">{t('quality.obs.help')}</p>
        <label class="field small">
          <input type="checkbox" checked={s.obsWebsocket.enabled} disabled={busy} onChange={(e) => void save((x) => (x.obsWebsocket.enabled = (e.target as HTMLInputElement).checked))} />{' '}
          {t('quality.obs.use')} <Info text={t('quality.obs.use.tip')} />
        </label>
        <div class="row small">
          <input class="text-input" value={s.obsWebsocket.url} disabled={busy} size={22} aria-label={t('quality.obs.url')} onChange={(e) => void save((x) => (x.obsWebsocket.url = (e.target as HTMLInputElement).value.trim()))} />
          <input
            class="text-input"
            type="password"
            aria-label={t('quality.obs.password')}
            placeholder={s.obsWebsocket.hasPassword ? t('quality.obs.passwordSaved') : t('quality.obs.password')}
            value={password}
            disabled={busy}
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
          />
          <button class="small" disabled={busy || !password} onClick={() => void save((x) => (x.obsWebsocket.password = password)).then(() => setPassword(''))}>
            {t('quality.obs.savePassword')}
          </button>
          <Info text={t('quality.obs.password.tip')} />
        </div>
        <p class="small">
          {u.obsWebsocket.connected ? (
            <span class="ok">
              {t('quality.obs.connected')}
              {u.signals.obsCongestion !== undefined ? ` · ${t('quality.obs.congestion', { percent: Math.round(u.signals.obsCongestion * 100) })}` : ''}
            </span>
          ) : s.obsWebsocket.enabled ? (
            <span class="muted">{u.obsWebsocket.error ?? t('quality.obs.connectsLive')}</span>
          ) : null}
        </p>
      </details>
      {error && <div class="err">{error}</div>}
    </section>
  );
}
