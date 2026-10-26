// Content of each tutorial step. Short texts, one idea per step, live data from the panel state.
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { AdminState, QualityState } from '@swarmcast/shared';
import { formatNumber, getLang, t, tc } from '@swarmcast/shared/i18n';
import { api, post } from '../api.js';
import { Info } from '../Info.js';
import { keyframeProblem, testStatus, videoSupport, type Route, type VideoSupport } from './logic.js';
import { belowMinimum, checkRows, loadSystemCheck, type SystemCheck } from './systemcheck.js';
import { AREAS, clearSpot, findArea, spotlight, type AreaId } from './tour.js';
import imgDocksMenu from './img/obs-docks-menu.png';
import imgMultiDock from './img/obs-multi-dock.png';
import imgOutput from './img/obs-output.png';
import imgStart from './img/obs-start-streaming.png';
import imgStreamCustom from './img/obs-stream-custom.png';
import imgTarget from './img/obs-target.png';

export const PLUGIN_FORUM_URL = 'https://obsproject.com/forum/resources/multiple-rtmp-outputs-plugin.964/';
export const PLUGIN_GITHUB_URL = 'https://github.com/sorayuki/obs-multi-rtmp/releases';

function mbps(kbps: number): string {
  return formatNumber(Math.round(kbps / 100) / 10);
}

function useCopy(): [string | null, (key: string, text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (key: string, text: string): void => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(key);
        setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
      },
      () => {},
    );
  };
  return [copied, copy];
}

/** Screenshot with numbered highlights; click toggles a larger view. */
function Figure({ src, alt, wide }: { src: string; alt: string; wide?: boolean }) {
  const [zoomed, setZoomed] = useState(false);
  return (
    <figure class={`onb-fig ${wide ? 'onb-fig-wide' : 'onb-fig-narrow'} ${zoomed ? 'zoomed' : ''}`}>
      <button type="button" class="onb-fig-btn" aria-pressed={zoomed} title={t('onb.zoom')} onClick={() => setZoomed(!zoomed)}>
        <img src={src} alt={alt} loading="lazy" decoding="async" />
      </button>
      <figcaption class="muted small">{alt}</figcaption>
    </figure>
  );
}

function CopyField({ label, value, secret, id }: { label: string; value: string; secret?: boolean; id: string }) {
  const [copied, copy] = useCopy();
  const [show, setShow] = useState(false);
  return (
    <div class="onb-field">
      <span class="onb-field-label">{label}</span>
      <code class="value" data-testid={`onb-${id}-value`}>{secret && !show ? '•'.repeat(18) : value}</code>
      {secret && (
        <button type="button" class="small" title={t('admin.obs.show.tip')} onClick={() => setShow(!show)}>
          {show ? t('admin.obs.hide') : t('admin.obs.show')}
        </button>
      )}
      <button type="button" class="small primary" data-testid={`onb-copy-${id}`} onClick={() => copy(id, value)}>
        {copied === id ? t('onb.copied') : t('common.copy')}
      </button>
    </div>
  );
}

function Status({ kind, children, testid }: { kind: 'ok' | 'wait' | 'warn' | 'off'; children: ComponentChildren; testid?: string }) {
  return (
    <div class={`onb-status onb-status-${kind}`} role="status" data-testid={testid} data-status={kind}>
      <span class="onb-status-dot" aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

// ---- 1. Welcome ----
export function WelcomeStep() {
  return (
    <>
      <ul class="onb-lines">
        <li>{t('onb.welcome.l1')}</li>
        <li>{t('onb.welcome.l2')}</li>
        <li>{t('onb.welcome.l3')}</li>
      </ul>
      <p class="onb-callout">{t('onb.welcome.plan')}</p>
      <p class="muted small">{t('onb.welcome.twitch')}</p>
    </>
  );
}

// ---- 2. PC check ----
type QualityLike = Partial<QualityState> | null;

function videoText(v: VideoSupport): string {
  switch (v) {
    case 'hardware':
      return t('onb.pc.videoHardware');
    case 'software':
      return t('onb.pc.videoSoftware');
    case 'none':
      return t('onb.pc.videoNone');
    case 'noFfmpeg':
      return t('onb.pc.videoNoFfmpeg');
    case 'checking':
      return t('onb.pc.videoChecking');
    default:
      return t('onb.pc.videoUnknown');
  }
}

export function PcStep({ s }: { s: AdminState }) {
  // undefined = loading; null = not available (older server or error): the row is hidden.
  const [q, setQ] = useState<QualityLike | undefined>(undefined);
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const load = (): void => {
      api<QualityState>('/api/quality', 'GET').then(
        (r) => {
          if (stopped) return;
          setQ(r);
          if (r?.probing) timer = window.setTimeout(load, 2000);
        },
        () => !stopped && setQ(null),
      );
    };
    load();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, []);
  // Installer check (start scripts); null = none -> live panel data only.
  const [sys, setSys] = useState<SystemCheck | null | undefined>(undefined);
  useEffect(() => {
    let stopped = false;
    void loadSystemCheck((p, m) => api(p, m)).then((r) => !stopped && setSys(r));
    return () => {
      stopped = true;
    };
  }, []);
  const video = videoSupport(q ?? null);
  const cap = s.capacity;
  return (
    <>
      <p>{t('onb.pc.intro')}</p>
      {sys && <SystemCheckView c={sys} />}
      {sys && <h3 class="onb-sub">{t('onb.sys.now')}</h3>}
      <dl class="onb-checks" data-testid="onb-pc">
        <div class="onb-check">
          <dt>{t('onb.pc.obs')}</dt>
          <dd>
            {s.obsConnected ? <Status kind="ok">{t('onb.pc.obsOk')}</Status> : <Status kind="off">{t('onb.pc.obsNo')}</Status>}
          </dd>
        </div>
        {!sys && (
          <div class="onb-check">
            <dt>{t('onb.pc.net')}</dt>
            <dd>
              {s.speedTest ? (
                <Status kind="ok">{t('onb.pc.netResult', { up: s.speedTest.uploadMbps, down: s.speedTest.downloadMbps })}</Status>
              ) : (
                <div class="row tight">
                  <Status kind={s.speedTestRunning ? 'wait' : 'off'}>{s.speedTestRunning ? t('onb.pc.netTesting') : t('onb.pc.netNone')}</Status>
                  {!s.speedTestRunning && (
                    <button type="button" class="small" title={t('admin.net.test.tip')} onClick={() => void post('/api/speedtest').catch(() => {})}>
                      {t('onb.pc.netTest')}
                    </button>
                  )}
                </div>
              )}
            </dd>
          </div>
        )}
        {cap && (!sys || s.speedTest) && (
          <div class="onb-check">
            <dt>{t('onb.pc.viewers')}</dt>
            <dd>
              <Status kind={cap.level === 'over' ? 'warn' : cap.level === 'near' ? 'warn' : s.speedTest ? 'ok' : 'off'}>
                {tc(cap, cap.message)} <Info text={t('admin.capacity.tip')} />
              </Status>
            </dd>
          </div>
        )}
        {q !== null && (
          <div class="onb-check">
            <dt>{t('onb.pc.video')}</dt>
            <dd>
              <Status kind={video === 'hardware' || video === 'software' ? 'ok' : video === 'checking' || q === undefined ? 'wait' : 'off'}>
                {q === undefined ? t('onb.pc.videoChecking') : videoText(video)}
              </Status>
            </dd>
          </div>
        )}
      </dl>
      <p class="muted small">{t('onb.pc.note')}</p>
    </>
  );
}

function checkedAt(at: string | number): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? String(at) : d.toLocaleString(getLang(), { dateStyle: 'short', timeStyle: 'short' });
}

/** The start script's system check: one row per item, value vs minimum/recommended, what to do. */
export function SystemCheckView({ c }: { c: SystemCheck }) {
  const rows = checkRows(c);
  return (
    <section class="onb-sys" data-testid="onb-syscheck" aria-labelledby="onb-sys-title">
      {belowMinimum(c) && (
        <div class="warn onb-sys-banner" role="note" data-testid="onb-sys-below">
          <b>{t('onb.sys.below.title')}</b> {t('onb.sys.below.text')}
        </div>
      )}
      <h3 class="onb-sub" id="onb-sys-title">
        {t('onb.sys.title', { when: checkedAt(c.at) })} <span class="muted small">{t('onb.sys.system', { os: c.os, arch: c.arch })}</span>
      </h3>
      <ul class="onb-sys-list">
        {rows.map((r) => (
          <li key={r.id} class={`onb-sys-row onb-sys-${r.status}`} data-testid={`onb-sys-${r.id}`} data-status={r.status}>
            <span class="onb-sys-icon" aria-hidden="true">{r.icon}</span>
            <span class="onb-sys-main">
              <span class="onb-sys-label">{r.label}</span>
              {r.value && <span class="onb-sys-value">{r.value}</span>}
              {r.target && <span class="muted small">({r.target})</span>}
              {r.detail && <span class="muted small onb-sys-detail">{r.detail}</span>}
              {r.advice && <span class="onb-sys-advice small">→ {r.advice}</span>}
            </span>
          </li>
        ))}
      </ul>
      {typeof c.viewerEstimate === 'number' && c.viewerEstimate >= 0 && <p class="small">{t('onb.sys.viewers', { count: Math.floor(c.viewerEstimate) })}</p>}
    </section>
  );
}

// ---- 3. OBS output settings ----
export function OutputStep() {
  return (
    <>
      <p>{t('onb.output.intro')}</p>
      <ol class="onb-steps">
        <li>{t('onb.output.s1')}</li>
        <li>{t('onb.output.s2')}</li>
        <li>{t('onb.output.s3')}</li>
        <li>
          <b>{t('onb.output.s4')}</b>
        </li>
      </ol>
      <Figure src={imgOutput} alt={t('onb.output.alt')} wide />
      <p class="onb-why small">{t('onb.output.why')}</p>
    </>
  );
}

// ---- 4. Choose the route ----
export function ChooseStep({ route, onRoute }: { route: Route; onRoute: (r: Route) => void }) {
  const opt = (r: Route, title: string, desc: string, badge?: string) => (
    <label class={`onb-choice ${route === r ? 'selected' : ''}`} data-testid={`onb-route-${r}`}>
      <input type="radio" name="onb-route" value={r} checked={route === r} onChange={() => onRoute(r)} />
      <span class="onb-choice-text">
        <span class="onb-choice-title">
          {title} {badge && <span class="badge on">{badge}</span>}
        </span>
        <span class="muted small">{desc}</span>
      </span>
    </label>
  );
  return (
    <fieldset class="onb-choices">
      <legend class="sr-only">{t('onb.choose.title')}</legend>
      {opt('both', t('onb.choose.both'), t('onb.choose.bothDesc'), t('onb.choose.recommended'))}
      {opt('only', t('onb.choose.only'), t('onb.choose.onlyDesc'))}
    </fieldset>
  );
}

// ---- 5. Connect OBS (plugin or custom service) ----
export function ConnectStep({ s, route }: { s: AdminState; route: Route }) {
  if (route === 'only') {
    return (
      <>
        <ol class="onb-steps">
          <li>{t('onb.custom.s1')}</li>
          <li>{t('onb.custom.s2')}</li>
          <li>
            {t('onb.custom.s3')}
            <CopyField label={t('admin.obs.server')} value={s.rtmpUrl} id="server" />
          </li>
          <li>
            {t('onb.custom.s4')}
            <CopyField label={t('admin.obs.key')} value={s.streamKey} id="key" secret />
            <p class="muted small">{t('onb.keySecret')}</p>
          </li>
        </ol>
        <Figure src={imgStreamCustom} alt={t('onb.custom.alt')} wide />
        <p class="muted small">{t('onb.custom.note')}</p>
      </>
    );
  }
  return (
    <>
      <ol class="onb-steps">
        <li>
          {t('onb.plugin.s1')}
          <span class="onb-links">
            <a href={PLUGIN_FORUM_URL} target="_blank" rel="noopener noreferrer" data-testid="onb-plugin-forum">
              {t('onb.plugin.linkForum')} ↗
            </a>
            <a href={PLUGIN_GITHUB_URL} target="_blank" rel="noopener noreferrer" data-testid="onb-plugin-github">
              {t('onb.plugin.linkGithub')} ↗
            </a>
          </span>
        </li>
        <li>
          {t('onb.plugin.s2')}
          <Figure src={imgDocksMenu} alt={t('onb.plugin.altMenu')} />
        </li>
        <li>
          {t('onb.plugin.s3')}
          <CopyField label={t('onb.plugin.name')} value="SwarmCast" id="name" />
          <CopyField label={t('onb.plugin.server')} value={s.rtmpUrl} id="server" />
          <CopyField label={t('onb.plugin.key')} value={s.streamKey} id="key" secret />
          <p class="muted small">{t('onb.keySecret')}</p>
        </li>
        <li>{t('onb.plugin.encoder')}</li>
        <li>{t('onb.plugin.sync')}</li>
        <li>{t('onb.plugin.ok')}</li>
      </ol>
      <Figure src={imgTarget} alt={t('onb.plugin.altTarget')} wide />
      <p class="onb-callout small">{t('onb.plugin.twitch')}</p>
    </>
  );
}

// ---- 6. Test it ----
export function TestStep({ s, route, onFixKeyframes }: { s: AdminState; route: Route; onFixKeyframes: () => void }) {
  const [busy, setBusy] = useState(false);
  const status = testStatus(s);
  const kf = keyframeProblem(s);
  const start = async (): Promise<void> => {
    setBusy(true);
    try {
      await post('/api/live/start');
    } catch {
      /* the panel shows the error in its start steps */
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <ol class="onb-steps">
        <li>
          <span class="row tight">
            {t('onb.test.s1')}{' '}
            {status === 'off' ? (
              <button type="button" class="primary" data-testid="onb-turn-on" disabled={busy || s.phase === 'stopping'} onClick={() => void start()}>
                {t('admin.turnOn')}
              </button>
            ) : status === 'starting' ? (
              <span class="muted">{t('onb.test.starting')}</span>
            ) : (
              <span class="ok strong">✓ {t('onb.test.isOn')}</span>
            )}
          </span>
        </li>
        <li>
          {route === 'both' ? t('onb.test.s2plugin') : t('onb.test.s2')}
          <div class="onb-figs">
            <Figure src={imgStart} alt={t('onb.test.altStart')} />
            {route === 'both' && <Figure src={imgMultiDock} alt={t('onb.test.altDock')} />}
          </div>
        </li>
      </ol>
      {status === 'ok' ? (
        <Status kind="ok" testid="onb-test-status">
          {s.obsBitrateKbps > 0 ? t('onb.test.ok', { mbps: mbps(s.obsBitrateKbps) }) : t('onb.test.okNoRate')}
        </Status>
      ) : status === 'receiving' ? (
        <Status kind="wait" testid="onb-test-status">{t('onb.test.receiving')}</Status>
      ) : status === 'waiting' ? (
        <Status kind="wait" testid="onb-test-status">{t('onb.test.waiting')}</Status>
      ) : (
        <Status kind="off" testid="onb-test-status">{status === 'starting' ? t('onb.test.starting') : t('onb.test.off')}</Status>
      )}
      {kf && (
        <div class="warn" data-testid="onb-keyframes">
          {kf.seconds ? t('onb.test.keyframes', { seconds: Math.round(kf.seconds) }) : t('onb.test.keyframesUnknown')}{' '}
          <button type="button" class="small" onClick={onFixKeyframes}>{t('onb.test.fixKeyframes')}</button>
        </div>
      )}
      {status === 'waiting' && <p class="muted small">{t('onb.test.trouble')}</p>}
      {status !== 'ok' && <p class="muted small">{t('onb.test.later')}</p>}
    </>
  );
}

// ---- 7. Share the link ----
export function ShareStep({ s }: { s: AdminState }) {
  const [copied, copy] = useCopy();
  return (
    <>
      <p>{t('onb.share.where', { titleKey: 'admin.link.title' })}</p>
      {s.liveLink ? (
        <div class="onb-field">
          <code class="value" data-testid="onb-live-link">{s.liveLink}</code>
          <button type="button" class="primary" data-testid="onb-copy-link" onClick={() => copy('link', s.liveLink!)}>
            {copied === 'link' ? t('onb.copied') : t('admin.link.copy')}
          </button>
        </div>
      ) : (
        <p class="muted">{t('onb.share.none')}</p>
      )}
      <ul class="onb-lines">
        <li>
          <b>{t('onb.share.subs')}</b>
        </li>
        <li>{t('onb.share.viewers')}</li>
        <li>
          <span class="row tight">
            {t('onb.share.p2p', { p2pKey: 'watch.p2p' })} <Info text={t('onb.share.p2p.tip')} />
          </span>
        </li>
      </ul>
    </>
  );
}

// ---- 8. Panel tour ----
const AREA_TEXT: Record<AreaId, { title: Parameters<typeof t>[0]; desc: Parameters<typeof t>[0] }> = {
  top: { title: 'onb.tour.top', desc: 'onb.tour.top.desc' },
  link: { title: 'onb.tour.link', desc: 'onb.tour.link.desc' },
  p2p: { title: 'onb.tour.p2p', desc: 'onb.tour.p2p.desc' },
  quality: { title: 'onb.tour.quality', desc: 'onb.tour.quality.desc' },
  mode: { title: 'onb.tour.mode', desc: 'onb.tour.mode.desc' },
  security: { title: 'onb.tour.security', desc: 'onb.tour.security.desc' },
  viewers: { title: 'onb.tour.viewers', desc: 'onb.tour.viewers.desc' },
  activity: { title: 'onb.tour.activity', desc: 'onb.tour.activity.desc' },
};

export function TourStep({ area, onArea }: { area: AreaId | null; onArea: (a: AreaId | null) => void }) {
  const [found, setFound] = useState(true);
  useEffect(() => {
    if (area) setFound(spotlight(area));
    else clearSpot();
  }, [area]);
  useEffect(() => () => clearSpot(), []);
  return (
    <>
      {/* The description sits above the map so it stays visible in the docked (smaller) dialog. */}
      <div class="onb-area-desc" aria-live="polite">
        {area ? (
          <>
            <b>{t(AREA_TEXT[area].title)}:</b> {t(AREA_TEXT[area].desc)}
            {!found && <span class="muted small"> {t('onb.tour.missing')}</span>}
          </>
        ) : (
          t('onb.tour.intro')
        )}
      </div>
      <div class="onb-map" role="group" aria-label={t('onb.tour.map')}>
        {AREAS.map((a) => (
          <button
            key={a}
            type="button"
            class={`onb-map-${a} ${area === a ? 'active' : ''} ${findArea(a) ? '' : 'absent'}`}
            aria-pressed={area === a}
            data-testid={`onb-area-${a}`}
            onClick={() => onArea(area === a ? null : a)}
          >
            {t(AREA_TEXT[a].title)}
          </button>
        ))}
      </div>
    </>
  );
}

// ---- 9. Finish ----
export function FinishStep({ s }: { s: AdminState }) {
  return (
    <>
      <ul class="onb-lines">
        <li>
          <b>{t('onb.finish.stop', { stopKey: 'admin.stopAll' })}</b>
        </li>
        <li>{t('onb.finish.close', { minutes: s.settings.autoStopMinutes })}</li>
        <li>{t('onb.finish.again')}</li>
      </ul>
    </>
  );
}
