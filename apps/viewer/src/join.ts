import './style.css';
import type { Challenge, Payload } from 'altcha-lib';
import type { ApiErrorBody, JoinChallengeResponse } from '@swarmcast/shared';
import { t, tc } from './i18n.js';
import { solvePow } from './pow.js';

const form = document.getElementById('join-form') as HTMLFormElement;
const input = document.getElementById('nickname') as HTMLInputElement;
const errorEl = document.getElementById('error') as HTMLParagraphElement;
const checkEl = document.getElementById('check') as HTMLParagraphElement;
const button = document.getElementById('join') as HTMLButtonElement;

function showError(msg: string): void {
  errorEl.textContent = msg;
  errorEl.hidden = false;
}

/** Browser check (proof-of-work) in progress or solved, when the streamer's protection asks for it. */
let pow: Promise<Payload> | null = null;

function startCheck(challenge: Challenge): Promise<Payload> {
  checkEl.hidden = false;
  const p = solvePow(challenge).finally(() => {
    checkEl.hidden = true;
  });
  p.catch(() => {});
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

type JoinResponse = { redirect?: string; pow?: Challenge } & Partial<ApiErrorBody>;

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  errorEl.hidden = true;
  const nickname = input.value.trim();
  if (!nickname) {
    showError(t('nickname.empty'));
    return;
  }
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
