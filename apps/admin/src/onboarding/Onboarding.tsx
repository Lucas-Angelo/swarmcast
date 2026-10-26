// First-run setup tutorial: a modal wizard that opens by itself until finished or skipped
// (stored server-side), and again from the "Redo setup tutorial" button.
// CSP-safe: no inline styles or scripts; all styling lives in onboarding.css.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { AdminState } from '@swarmcast/shared';
import { t, type MessageKey } from '@swarmcast/shared/i18n';
import { api, post } from '../api.js';
import { clampStep, isLastStep, loadDone, nextStep, OPEN_EVENT, prevStep, saveDone, shouldAutoOpen, STEPS, type Route, type StepId } from './logic.js';
import { ChooseStep, ConnectStep, FinishStep, OutputStep, PcStep, ShareStep, TestStep, TourStep, WelcomeStep } from './steps.js';
import type { AreaId } from './tour.js';
import { clearSpot } from './tour.js';
import './onboarding.css';

const TITLES: Record<StepId, (route: Route) => MessageKey> = {
  welcome: () => 'onb.welcome.title',
  pc: () => 'onb.pc.title',
  output: () => 'onb.output.title',
  choose: () => 'onb.choose.title',
  connect: (r) => (r === 'both' ? 'onb.plugin.title' : 'onb.custom.title'),
  test: () => 'onb.test.title',
  share: () => 'onb.share.title',
  tour: () => 'onb.tour.title',
  finish: () => 'onb.finish.title',
};

/** Reopen the tutorial from anywhere (the Redo button). */
export function openOnboarding(): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

export function RedoTutorialButton() {
  return (
    <button type="button" data-testid="redo-tutorial" title={t('onb.redo.tip')} onClick={openOnboarding}>
      {t('onb.redo')}
    </button>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Onboarding({ state }: { state: AdminState }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [route, setRoute] = useState<Route>('both');
  const [area, setArea] = useState<AreaId | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  // Auto-open on first run.
  useEffect(() => {
    let stopped = false;
    void loadDone((p, m) => api(p, m)).then((done) => {
      if (!stopped && shouldAutoOpen(done)) {
        returnFocus.current = document.activeElement as HTMLElement | null;
        setStep(0);
        setOpen(true);
      }
    });
    return () => {
      stopped = true;
    };
  }, []);

  // "Redo setup tutorial".
  useEffect(() => {
    const onOpen = (): void => {
      returnFocus.current = document.activeElement as HTMLElement | null;
      setStep(0);
      setArea(null);
      setOpen(true);
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  // Move focus to the step title on open and on every step change (screen readers announce it).
  useLayoutEffect(() => {
    if (open) headingRef.current?.focus({ preventScroll: true });
  }, [open, step]);

  const id = STEPS[step]!;
  useEffect(() => {
    if (id !== 'tour') {
      setArea(null);
      clearSpot();
    }
  }, [id]);

  const close = (): void => {
    clearSpot();
    setArea(null);
    setOpen(false);
    void saveDone((p, b) => post(p, b), true);
    const back = returnFocus.current;
    if (back && document.contains(back)) back.focus();
  };

  const askClose = (): void => {
    if (window.confirm(t('onb.confirmClose'))) close();
    else headingRef.current?.focus({ preventScroll: true });
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      // Let an open tooltip close first.
      if (document.querySelector('.tip-bubble.open')) return;
      e.preventDefault();
      askClose();
      return;
    }
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const items = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === headingRef.current || !dialogRef.current.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !dialogRef.current.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  // Listen on the document (not the dialog) so Escape and the focus trap still work after focus
  // was lost, e.g. when the confirm box closes or the user clicked the page during the tour.
  const keyHandler = useRef(onKeyDown);
  keyHandler.current = onKeyDown;
  useLayoutEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent): void => keyHandler.current(e);
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [open]);

  if (!open) return null;

  const go = (i: number): void => setStep(clampStep(i));
  const last = isLastStep(step);
  const title = t(TITLES[id](route));
  const docked = id === 'tour' && area !== null;

  return (
    <div class={`onb-bg ${docked ? 'onb-docked' : ''}`}>
      <div
        class="onb"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onb-heading"
        data-testid="onboarding"
        data-step={id}
        ref={dialogRef}
      >
        <header class="onb-head">
          <div class="onb-head-text">
            <span class="onb-kicker">
              {t('onb.title')} · <span data-testid="onb-progress">{t('onb.progress', { n: step + 1, total: STEPS.length })}</span>
            </span>
            <h2 id="onb-heading" tabIndex={-1} ref={headingRef}>
              {title}
            </h2>
          </div>
          <button type="button" class="onb-x" aria-label={t('onb.close')} title={t('onb.close')} data-testid="onb-close" onClick={askClose}>
            ×
          </button>
        </header>

        <div class="onb-body" data-testid={`onb-step-${id}`}>
          {id === 'welcome' && <WelcomeStep />}
          {id === 'pc' && <PcStep s={state} />}
          {id === 'output' && <OutputStep />}
          {id === 'choose' && <ChooseStep route={route} onRoute={setRoute} />}
          {id === 'connect' && <ConnectStep s={state} route={route} />}
          {id === 'test' && <TestStep s={state} route={route} onFixKeyframes={() => go(STEPS.indexOf('output'))} />}
          {id === 'share' && <ShareStep s={state} />}
          {id === 'tour' && <TourStep area={area} onArea={setArea} />}
          {id === 'finish' && <FinishStep s={state} />}
        </div>

        <footer class="onb-foot">
          <button type="button" class="onb-skip" data-testid="onb-skip" onClick={askClose}>
            {t('onb.skip')}
          </button>
          <ol class="onb-dots">
            {STEPS.map((sid, i) => (
              <li key={sid}>
                <button
                  type="button"
                  class={`onb-dot ${i === step ? 'current' : i < step ? 'done' : ''}`}
                  aria-label={t('onb.dot', { n: i + 1, title: t(TITLES[sid](route)) })}
                  aria-current={i === step ? 'step' : undefined}
                  onClick={() => go(i)}
                />
              </li>
            ))}
          </ol>
          <div class="onb-nav">
            {step > 0 && (
              <button type="button" data-testid="onb-back" onClick={() => go(prevStep(step))}>
                {t('onb.back')}
              </button>
            )}
            {last ? (
              <button type="button" class="primary" data-testid="onb-finish" onClick={close}>
                {t('onb.finish')}
              </button>
            ) : (
              <button type="button" class="primary" data-testid="onb-next" onClick={() => go(nextStep(step))}>
                {t('onb.next')}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
