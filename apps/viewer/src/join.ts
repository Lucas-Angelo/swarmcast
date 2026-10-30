import './style.css';
import type { Challenge, Payload } from 'altcha-lib';
import type { ApiErrorBody, JoinChallengeResponse } from '@swarmcast/shared';
import { validateNickname } from '@swarmcast/shared/chat/nickname';
import { t, tc } from './i18n.js';
import { solvePow } from './pow.js';

const form = document.getElementById('join-form') as HTMLFormElement;
const input = document.getElementById('nickname') as HTMLInputElement;
const errorEl = document.getElementById('error') as HTMLParagraphElement;
const checkEl = document.getElementById('check') as HTMLParagraphElement;
const progressEl = document.getElementById('check-progress') as HTMLProgressElement | null;
const button = document.getElementById('join') as HTMLButtonElement;

function showError(msg: string): void {
  errorEl.textContent = msg;
  errorEl.hidden = false;
}

/** Browser check (proof-of-work) in progress or solved, when the streamer's protection asks for it. */
let pow: Promise<Payload> | null = null;

/** Keep "Checking your browser…" up at least this long, so a fast check does not just flicker. */
const CHECK_MIN_VISIBLE_MS = 600;
/** The check the status line is showing (a retry may start a newer one). */
let shown: Promise<Payload> | null = null;

function startCheck(challenge: Challenge): Promise<Payload> {
  checkEl.hidden = false;
  const shownAt = performance.now();
  if (progressEl) progressEl.value = 0;
  const p = solvePow(challenge, (f) => {
    if (progressEl) progressEl.value = f;
  }).finally(() => {
    // Hiding waits; the proof itself is available right away.
    setTimeout(() => {
      if (shown === p) checkEl.hidden = true;
    }, Math.max(0, CHECK_MIN_VISIBLE_MS - (performance.now() - shownAt)));
  });
  p.catch(() => {});
  shown = p;
  pow = p;
  return p;
}

// Start solving right away, while the viewer types a nickname.
void (async () => {
  try {
    const res = await fetch('/api/join/challenge', { credentials: 'same-origin' });
    if (!res.ok) return;
    const body = (await res.json()) as JoinChallengeResponse;
    if (body.required) startCheck(body.challenge as Challenge);
  } catch {
    /* the join request will ask again if needed */
  }
})();

/**
 * Instant nickname feedback with the server's own rules (packages/shared/src/chat/nickname.ts);
 * the server checks again and also refuses names already taken in the live.
 */
let typed = false;
input.addEventListener('input', () => {
  const value = input.value;
  const r = value.trim() ? validateNickname(value) : null;
  if (value.trim().length >= 2) typed = true;
  // "Too short" waits until the viewer has typed a second character; other problems show at once.
  if (r && !r.ok && (typed || r.code !== 'nickname.tooShort')) {
    showError(t(r.code, r.params));
    input.setAttribute('aria-invalid', 'true');
  } else {
    errorEl.hidden = true;
    input.removeAttribute('aria-invalid');
  }
});

type JoinResponse = { redirect?: string; pow?: Challenge } & Partial<ApiErrorBody>;

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  errorEl.hidden = true;
  const checked = validateNickname(input.value);
  if (!checked.ok) {
    showError(t(checked.code, checked.params));
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    return;
  }
  const nickname = checked.value;
  button.disabled = true;
  try {
    let proof: Payload | undefined;
    try {
      proof = pow ? await pow : undefined;
    } catch {
      pow = null;
      showError(t('join.checkFailed'));
      button.disabled = false;
      return;
    }
    for (let attempt = 0; ; attempt++) {
      const res = await fetch('/api/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(proof ? { nickname, pow: proof } : { nickname }),
      });
      const body = (await res.json().catch(() => ({}))) as JoinResponse;
      if (res.ok) {
        location.replace(body.redirect ?? '/watch');
        return;
      }
      // The check was turned on after this page loaded (or the proof expired): solve and retry once.
      if (res.status === 403 && body.code === 'viewer.err.checkRequired' && body.pow && attempt === 0) {
        proof = await startCheck(body.pow).catch(() => undefined);
        if (proof) continue;
        pow = null;
        showError(t('join.checkFailed'));
        button.disabled = false;
        return;
      }
      // A nickname problem leaves the proof unused; anything else may have used it up.
      if (res.status !== 400) pow = null;
      showError(tc(body, body.error ?? t('join.couldNot')));
      button.disabled = false;
      return;
    }
  } catch {
    showError(t('join.network'));
    button.disabled = false;
  }
});
