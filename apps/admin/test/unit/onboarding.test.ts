import { describe, expect, it, vi } from 'vitest';
import type { AdminState, QualityState } from '@swarmcast/shared';
import { isMessageKey, translate } from '@swarmcast/shared/i18n';
import {
  clampStep,
  isLastStep,
  keyframeProblem,
  loadDone,
  nextStep,
  ONBOARDING_API,
  prevStep,
  saveDone,
  shouldAutoOpen,
  STEPS,
  testStatus,
  videoSupport,
} from '../../src/onboarding/logic.js';

type Phase = AdminState['phase'];
const st = (phase: Phase, obsConnected = false, warningCodes: AdminState['warningCodes'] = []) => ({ phase, obsConnected, warningCodes });
const enc = (ok: boolean, hardware: boolean) => ({ id: 'libx264', ok, hardware }) as QualityState['encoders'][number];

describe('onboarding: auto-open', () => {
  it('opens by itself only when the server says the tutorial was never done; unknown (older server, network error) never pops up', () => {
    // Act
    const opens = [false, true, null, undefined].map((done) => shouldAutoOpen(done));
    // Assert
    expect(opens).toEqual([true, false, false, false]);
  });

  it('reads completion from GET /api/onboarding and tolerates errors and odd payloads', async () => {
    // Arrange
    const get = vi.fn(async () => ({ done: false }));
    // Act
    const answers = [
      await loadDone(get),
      await loadDone(async () => ({ done: true })),
      await loadDone(async () => ({})),
      await loadDone(async () => null),
      await loadDone(async () => {
        throw new Error('404');
      }),
    ];
    // Assert
    expect(get).toHaveBeenCalledWith(ONBOARDING_API, 'GET');
    expect(answers).toEqual([false, true, null, null, null]);
  });
});

describe('onboarding: completion persistence', () => {
  it('finishing or skipping POSTs { done } to the server', async () => {
    // Arrange
    const post = vi.fn(async () => ({ done: true }));
    // Act
    const saved = await saveDone(post, true);
    // Assert
    expect(saved).toBe(true);
    expect(post).toHaveBeenCalledWith('/api/onboarding', { done: true });
  });

  it('never throws when the server cannot save', async () => {
    // Arrange
    const post = vi.fn(async () => {
      throw new Error('offline');
    });
    // Act
    const saving = saveDone(post, true);
    // Assert
    await expect(saving).resolves.toBe(false);
  });
});

describe('onboarding: steps', () => {
  it('has the planned order, one idea per step', () => {
    // Assert
    expect(STEPS).toEqual(['welcome', 'pc', 'output', 'choose', 'connect', 'test', 'share', 'tour', 'finish']);
  });

  it('Back/Next stay inside the step range', () => {
    // Arrange
    const last = STEPS.length - 1;
    // Act
    const moves = { back: prevStep(0), next: nextStep(0), pastEnd: nextStep(last), below: clampStep(-5), above: clampStep(99), lastIsLast: isLastStep(last), firstIsLast: isLastStep(0) };
    // Assert
    expect(moves).toEqual({ back: 0, next: 1, pastEnd: last, below: 0, above: last, lastIsLast: true, firstIsLast: false });
  });

  it('has its texts in English and Brazilian Portuguese', () => {
    // Act
    const missing = ['onb.redo', 'onb.welcome.title', 'onb.test.ok', 'onb.finish.title'].filter((k) => !isMessageKey(k));
    const redo = { pt: translate('pt-BR', 'onb.redo'), en: translate('en', 'onb.redo') };
    // Assert
    expect(missing).toEqual([]);
    expect(redo).toEqual({ pt: 'Refazer o tutorial de configuração', en: 'Redo setup tutorial' });
  });
});

describe('onboarding: step 5 detects OBS from the panel state', () => {
  it('follows SwarmCast and OBS through a whole test (OBS dropping mid-live is back to waiting)', () => {
    // Act
    const statuses = [st('off'), st('starting'), st('waiting-obs'), st('waiting-obs', true), st('live', true), st('live', false), st('stopping', true)].map(testStatus);
    // Assert
    expect(statuses).toEqual(['off', 'starting', 'waiting', 'receiving', 'ok', 'waiting', 'off']);
  });

  it('spots the keyframe warning the server sends', () => {
    // Act
    const problems = [
      keyframeProblem(st('live', true)),
      keyframeProblem(st('live', true, [{ code: 'warn.keyframes', params: { seconds: 8 } }])),
      keyframeProblem(st('live', true, [{ code: 'warn.keyframes' }])),
      keyframeProblem(st('live', true, [{ code: 'warn.tunnelLimit' }])),
    ];
    // Assert
    expect(problems).toEqual([null, { seconds: 8 }, {}, null]);
  });
});

describe('onboarding: PC check degrades gracefully', () => {
  it('summarizes the quality ladder support', () => {
    // Act
    const support = [
      videoSupport(null),
      videoSupport({}),
      videoSupport({ ffmpeg: { available: false } }),
      videoSupport({ ffmpeg: { available: true }, encoders: [enc(true, true)] }),
      videoSupport({ ffmpeg: { available: true }, encoders: [enc(true, false)] }),
      videoSupport({ ffmpeg: { available: true }, encoders: [enc(false, true)] }),
      videoSupport({ ffmpeg: { available: true }, encoders: [], probing: true }),
    ];
    // Assert
    expect(support).toEqual(['unknown', 'unknown', 'noFfmpeg', 'hardware', 'software', 'none', 'checking']);
  });
});
