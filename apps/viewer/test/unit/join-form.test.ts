// @vitest-environment happy-dom
// The join form (apps/viewer/src/join-form.ts) on the real join.html markup, with the server, the
// browser-check solver and the navigation replaced by doubles.
//
// Two rules come from the stability soak (PR #43):
// - "Watch" never moves by itself. The "Checking your browser…" line used to sit above it and went
//   away about a second after the page opened; a press already on the button then ended beside it,
//   so the click never happened and no join was sent (adaptive-delay.spec on WebKit/Ubuntu waited
//   240 s for it). The line now comes after the button.
// - "Watch" is disabled in the markup until the form handles it: a click before that submitted
//   the form natively and reloaded the page.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Challenge, Payload } from 'altcha-lib';
import { t } from '@swarmcast/shared/i18n';
import { CHECK_MIN_VISIBLE_MS, startJoinForm, type JoinFormElements } from '../../src/join-form.js';
import type { PowProgress } from '../../src/pow.js';

const JOIN_HTML = readFileSync(path.join(import.meta.dirname, '..', '..', 'join.html'), 'utf8');

/** The join page's body as served, without its scripts and stylesheets (the form is started by the test). */
function joinPage(): JoinFormElements {
  const page = new DOMParser().parseFromString(JOIN_HTML, 'text/html');
  for (const el of page.querySelectorAll('script, link')) el.remove();
  document.body.replaceChildren(...Array.from(page.body.childNodes, (node) => document.importNode(node, true)));
  const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  return { form: $('join-form'), input: $('nickname'), button: $('join'), error: $('error'), check: $('check'), progress: $('check-progress') };
}

const challenge = (salt: string): Challenge =>
  ({ parameters: { algorithm: 'SHA-256', nonce: 'aa', salt, cost: 1, keyLength: 32, keyPrefix: '00', data: { level: 1, max: 15_000 } }, signature: `sig-${salt}` }) as Challenge;
const proofOf = (c: Challenge): Payload => ({ challenge: c, solution: { counter: 7, derivedKey: `key-${c.parameters.salt}` } }) as Payload;

type Answer = { status?: number; body?: unknown } | Error;

/** A server double: answers each "METHOD path" with its next scripted answer and keeps what was posted. */
function server(routes: Record<string, Answer[]>) {
  const posted: unknown[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    if (init?.body) posted.push(JSON.parse(String(init.body)));
    const answer = routes[key]?.shift();
    if (!answer) throw new Error(`no answer scripted for ${key}`);
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, posted };
}

const noCheck: Answer = { body: { required: false } };
const checkWith = (c: Challenge): Answer => ({ body: { required: true, challenge: c } });

/** A browser-check solver the test drives: progress, then `finish()` or `fail()`. */
function solver() {
  const runs: Array<{ challenge: Challenge; progress: PowProgress; finish(): void; fail(): void }> = [];
  const solve = vi.fn(
    (c: Challenge, progress: PowProgress) =>
      new Promise<Payload>((resolve, reject) => {
        runs.push({ challenge: c, progress, finish: () => resolve(proofOf(c)), fail: () => reject(new Error('no solution')) });
      }),
  );
  return { solve, runs };
}

/** Start the form and resolve with the URL it leaves for (the doubles' `go`). */
function start(el: JoinFormElements, fetch: typeof globalThis.fetch, solve: ReturnType<typeof solver>['solve']) {
  let left: (url: string) => void = () => {};
  const leaves = new Promise<string>((resolve) => (left = resolve));
  const form = startJoinForm(el, { fetch, solve, go: (url) => left(url), now: () => Date.now() });
  return { form, leaves };
}

describe('the join page markup', () => {
  it('keeps Watch disabled until the form handles it', () => {
    // Arrange
    const el = joinPage();
    const disabledInMarkup = el.button.disabled;

    // Act
    startJoinForm(el, { fetch: server({ 'GET /api/join/challenge': [noCheck] }).fetch, solve: solver().solve, go: () => {} });

    // Assert
    expect(disabledInMarkup).toBe(true);
    expect(el.button.disabled).toBe(false);
  });

  it('puts the browser-check line after Watch, so showing or hiding it never moves the button', () => {
    // Act
    const el = joinPage();

    // Assert
    expect(el.button.compareDocumentPosition(el.check) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(el.check.hidden).toBe(true);
  });
});

describe('the browser check', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts on load when the server asks for it, shows its progress and stays up at least CHECK_MIN_VISIBLE_MS', async () => {
    // Arrange
    const el = joinPage();
    const check = solver();
    const { form } = start(el, server({ 'GET /api/join/challenge': [checkWith(challenge('a1'))] }).fetch, check.solve);

    // Act
    await form.ready;
    check.runs[0]!.progress(0.4);

    // Assert
    expect(el.check.hidden).toBe(false);
    expect(el.progress!.value).toBe(0.4);

    // Act
    await vi.advanceTimersByTimeAsync(100);
    check.runs[0]!.finish();
    await vi.advanceTimersByTimeAsync(CHECK_MIN_VISIBLE_MS - 101);

    // Assert
    expect(el.check.hidden).toBe(false);

    // Act
    await vi.advanceTimersByTimeAsync(1);

    // Assert
    expect(el.check.hidden).toBe(true);
  });

  it('is not shown when the server needs none', async () => {
    // Arrange
    const el = joinPage();
    const check = solver();
    const { form } = start(el, server({ 'GET /api/join/challenge': [noCheck] }).fetch, check.solve);

    // Act
    await form.ready;

    // Assert
    expect(check.solve).not.toHaveBeenCalled();
    expect(el.check.hidden).toBe(true);
  });
});

describe('joining', () => {
  it('disables Watch, sends the nickname with the proof and leaves for the page the server names', async () => {
    // Arrange
    const el = joinPage();
    const check = solver();
    const c = challenge('b1');
    const srv = server({ 'GET /api/join/challenge': [checkWith(c)], 'POST /api/join': [{ body: { ok: true, redirect: '/watch' } }] });
    const { form, leaves } = start(el, srv.fetch, check.solve);
    await form.ready;
    el.input.value = '  Ana  Clara ';

    // Act
    el.button.click();

    // Assert
    expect(el.button.disabled).toBe(true);

    // Act
    check.runs[0]!.finish();

    // Assert
    expect(await leaves).toBe('/watch');
    expect(srv.posted).toEqual([{ nickname: 'Ana Clara', pow: proofOf(c) }]);
  });

  it('solves the challenge a refusal brings when the check was turned on after the page loaded, and asks once more', async () => {
    // Arrange
    const el = joinPage();
    const check = solver();
    const late = challenge('c1');
    const srv = server({
      'GET /api/join/challenge': [noCheck],
      'POST /api/join': [{ status: 403, body: { code: 'viewer.err.checkRequired', error: 'check', pow: late } }, { body: { ok: true, redirect: '/watch' } }],
    });
    const { form, leaves } = start(el, srv.fetch, check.solve);
    await form.ready;
    el.input.value = 'Bia';

    // Act
    el.button.click();
    await vi.waitFor(() => expect(check.runs).toHaveLength(1));
    check.runs[0]!.finish();

    // Assert
    expect(await leaves).toBe('/watch');
    expect(check.runs[0]!.challenge).toEqual(late);
    expect(srv.posted).toEqual([{ nickname: 'Bia' }, { nickname: 'Bia', pow: proofOf(late) }]);
  });

  it('says the check failed and gives Watch back when the browser check cannot be solved', async () => {
    // Arrange
    const el = joinPage();
    const check = solver();
    const srv = server({ 'GET /api/join/challenge': [checkWith(challenge('d1'))] });
    const { form } = start(el, srv.fetch, check.solve);
    await form.ready;
    el.input.value = 'Caio';

    // Act
    el.button.click();
    check.runs[0]!.fail();

    // Assert
    await vi.waitFor(() => expect(el.error.hidden).toBe(false));
    expect(el.error.textContent).toBe(t('join.checkFailed'));
    expect(el.button.disabled).toBe(false);
    expect(srv.posted).toEqual([]);
  });

  it("shows the server's reason for a refused nickname and keeps the proof for the next try", async () => {
    // Arrange
    const el = joinPage();
    const check = solver();
    const c = challenge('e1');
    const taken = { code: 'nickname.taken', error: 'taken', params: { suggestion: 'Ana 2' } };
    const srv = server({
      'GET /api/join/challenge': [checkWith(c)],
      'POST /api/join': [{ status: 400, body: taken }, { body: { ok: true, redirect: '/watch' } }],
    });
    const { form, leaves } = start(el, srv.fetch, check.solve);
    await form.ready;
    check.runs[0]!.finish();
    el.input.value = 'Ana';

    // Act
    el.button.click();

    // Assert
    await vi.waitFor(() => expect(el.error.textContent).toBe(t('nickname.taken', taken.params)));
    expect(el.button.disabled).toBe(false);

    // Act
    el.input.value = 'Ana Maria';
    el.button.click();

    // Assert
    expect(await leaves).toBe('/watch');
    expect(check.solve).toHaveBeenCalledTimes(1);
    expect(srv.posted).toEqual([
      { nickname: 'Ana', pow: proofOf(c) },
      { nickname: 'Ana Maria', pow: proofOf(c) },
    ]);
  });

  it('shows the network message and gives Watch back when the join request fails', async () => {
    // Arrange
    const el = joinPage();
    const srv = server({ 'GET /api/join/challenge': [noCheck], 'POST /api/join': [new TypeError('Failed to fetch')] });
    const { form } = start(el, srv.fetch, solver().solve);
    await form.ready;
    el.input.value = 'Eva';

    // Act
    el.button.click();

    // Assert
    await vi.waitFor(() => expect(el.error.textContent).toBe(t('join.network')));
    expect(el.button.disabled).toBe(false);
  });

  it('checks the nickname before asking the server', async () => {
    // Arrange
    const el = joinPage();
    const srv = server({ 'GET /api/join/challenge': [noCheck] });
    const { form } = start(el, srv.fetch, solver().solve);
    await form.ready;
    el.input.value = 'x';

    // Act
    el.button.click();

    // Assert
    expect(el.error.hidden).toBe(false);
    expect(el.error.textContent).toBe(t('nickname.tooShort', { min: 2 }));
    expect(el.input.getAttribute('aria-invalid')).toBe('true');
    expect(el.button.disabled).toBe(false);
    expect(srv.posted).toEqual([]);
  });
});
