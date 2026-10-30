// The join form (join.html): nickname feedback while the viewer types, the browser check
// (proof-of-work) started on load, and POST /api/join. The page, the network, the solver and
// the navigation come in as arguments (join.ts wires the real ones), so the whole flow runs in
// unit tests without a browser.
import type { Challenge, Payload } from 'altcha-lib';
import type { ApiErrorBody, JoinChallengeResponse } from '@swarmcast/shared';
import { validateNickname } from '@swarmcast/shared/chat/nickname';
import { t, tc } from '@swarmcast/shared/i18n';
import type { PowProgress } from './pow.js';

export interface JoinFormElements {
  form: HTMLFormElement;
  input: HTMLInputElement;
  /** "Watch": disabled in the markup until this form handles it (a click before that would reload the page). */
  button: HTMLButtonElement;
  error: HTMLElement;
  /** "Checking your browser…": below the button, so showing or hiding it never moves the button. */
  check: HTMLElement;
  progress: HTMLProgressElement | null;
}

export interface JoinFormDeps {
  fetch: typeof fetch;
  /** Solve a browser-check challenge (pow.ts solvePow). */
  solve(challenge: Challenge, onProgress: PowProgress): Promise<Payload>;
  /** Leave for the page the server names (location.replace). */
  go(url: string): void;
  /** Milliseconds, for how long the check line has been up (performance.now). */
  now?: () => number;
  /**
   * Settles once the page is visible and takes clicks: the join page stays invisible and
   * untouchable until its branding is known (style.css, branding/loader.ts). "Watch" stays
   * disabled until then, so it never looks clickable to anyone or anything while a click on it
   * would land nowhere. Without it, "Watch" is enabled as soon as the form handles it.
   */
  shown?: Promise<void>;
}

export interface JoinForm {
  /** Settles once the browser-check question asked on load has its answer (and a needed check started). */
  readonly ready: Promise<void>;
}

/** Keep "Checking your browser…" up at least this long, so a fast check does not just flicker. */
export const CHECK_MIN_VISIBLE_MS = 600;

type JoinResponse = { redirect?: string; pow?: Challenge } & Partial<ApiErrorBody>;

export function startJoinForm(el: JoinFormElements, d: JoinFormDeps): JoinForm {
  const now = d.now ?? (() => performance.now());

  const showError = (msg: string): void => {
    el.error.textContent = msg;
    el.error.hidden = false;
  };

  /** Browser check in progress or solved, when the streamer's protection asks for it. */
  let pow: Promise<Payload> | null = null;
  /** The check the status line is showing (a retry may start a newer one). */
  let shown: Promise<Payload> | null = null;

  const startCheck = (challenge: Challenge): Promise<Payload> => {
    el.check.hidden = false;
    const shownAt = now();
    if (el.progress) el.progress.value = 0;
    const p = d
      .solve(challenge, (f) => {
        if (el.progress) el.progress.value = f;
      })
      .finally(() => {
        // Hiding waits; the proof itself is available right away.
        setTimeout(
          () => {
            if (shown === p) el.check.hidden = true;
          },
          Math.max(0, CHECK_MIN_VISIBLE_MS - (now() - shownAt)),
        );
      });
    p.catch(() => {});
    shown = p;
    pow = p;
    return p;
  };

  // Start solving right away, while the viewer types a nickname.
  const ready = (async () => {
    try {
      const res = await d.fetch('/api/join/challenge', { credentials: 'same-origin' });
      if (!res.ok) return;
      const body = (await res.json()) as JoinChallengeResponse;
      if (body.required) startCheck(body.challenge as Challenge);
    } catch {
      /* the join request will ask again if needed */
    }
  })();

  // Instant nickname feedback with the server's own rules (packages/shared/src/chat/nickname.ts);
  // the server checks again and also refuses names already taken in the live.
  let typed = false;
  el.input.addEventListener('input', () => {
    const value = el.input.value;
    const r = value.trim() ? validateNickname(value) : null;
    if (value.trim().length >= 2) typed = true;
    // "Too short" waits until the viewer has typed a second character; other problems show at once.
    if (r && !r.ok && (typed || r.code !== 'nickname.tooShort')) {
      showError(t(r.code, r.params));
      el.input.setAttribute('aria-invalid', 'true');
    } else {
      el.error.hidden = true;
      el.input.removeAttribute('aria-invalid');
    }
  });

  el.form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    el.error.hidden = true;
    const checked = validateNickname(el.input.value);
    if (!checked.ok) {
      showError(t(checked.code, checked.params));
      el.input.setAttribute('aria-invalid', 'true');
      el.input.focus();
      return;
    }
    const nickname = checked.value;
    el.button.disabled = true;
    try {
      let proof: Payload | undefined;
      try {
        proof = pow ? await pow : undefined;
      } catch {
        pow = null;
        showError(t('join.checkFailed'));
        el.button.disabled = false;
        return;
      }
      for (let attempt = 0; ; attempt++) {
        const res = await d.fetch('/api/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(proof ? { nickname, pow: proof } : { nickname }),
        });
        const body = (await res.json().catch(() => ({}))) as JoinResponse;
        if (res.ok) {
          d.go(body.redirect ?? '/watch');
          return;
        }
        // The check was turned on after this page loaded (or the proof expired): solve and retry once.
        if (res.status === 403 && body.code === 'viewer.err.checkRequired' && body.pow && attempt === 0) {
          proof = await startCheck(body.pow).catch(() => undefined);
          if (proof) continue;
          pow = null;
          showError(t('join.checkFailed'));
          el.button.disabled = false;
          return;
        }
        // A nickname problem leaves the proof unused; anything else may have used it up.
        if (res.status !== 400) pow = null;
        showError(tc(body, body.error ?? t('join.couldNot')));
        el.button.disabled = false;
        return;
      }
    } catch {
      showError(t('join.network'));
      el.button.disabled = false;
    }
  });

  // Wired: "Watch" now joins (before this, a click would have submitted the form natively), once
  // the page itself takes clicks.
  const enable = (): void => {
    el.button.disabled = false;
  };
  if (d.shown) void d.shown.then(enable);
  else enable();
  return { ready };
}
