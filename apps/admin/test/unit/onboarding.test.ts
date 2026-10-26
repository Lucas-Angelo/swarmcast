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

describe('onboarding: auto-open', () => {
  it('opens by itself only when the server says the tutorial was never done', () => {
    expect(shouldAutoOpen(false)).toBe(true);
    expect(shouldAutoOpen(true)).toBe(false);
    // Unknown (older server, network error): never pop up uninvited.
    expect(shouldAutoOpen(null)).toBe(false);
    expect(shouldAutoOpen(undefined)).toBe(false);
  });

  it('reads completion from GET /api/onboarding and tolerates errors and odd payloads', async () => {
    const get = vi.fn(async () => ({ done: false }));
    expect(await loadDone(get)).toBe(false);
    expect(get).toHaveBeenCalledWith(ONBOARDING_API, 'GET');
    expect(await loadDone(async () => ({ done: true }))).toBe(true);
    expect(await loadDone(async () => ({}))).toBeNull();
    expect(await loadDone(async () => null)).toBeNull();
    expect(
      await loadDone(async () => {
        throw new Error('404');
      }),
    ).toBeNull();
  });
});

describe('onboarding: completion persistence', () => {
  it('finishing or skipping POSTs { done } to the server', async () => {
    const post = vi.fn(async () => ({ done: true }));
    expect(await saveDone(post, true)).toBe(true);
    expect(post).toHaveBeenCalledWith('/api/onboarding', { done: true });
  });

  it('never throws when the server cannot save', async () => {
    const post = vi.fn(async () => {
      throw new Error('offline');
    });
    await expect(saveDone(post, true)).resolves.toBe(false);
  });
});

describe('onboarding: steps', () => {
  it('has the planned order, one idea per step', () => {
    expect(STEPS).toEqual(['welcome', 'pc', 'output', 'choose', 'connect', 'test', 'share', 'tour', 'finish']);
  });

  it('Back/Next stay inside the step range', () => {
    expect(prevStep(0)).toBe(0);
    expect(nextStep(0)).toBe(1);
    expect(nextStep(STEPS.length - 1)).toBe(STEPS.length - 1);
    expect(clampStep(-5)).toBe(0);
    expect(clampStep(99)).toBe(STEPS.length - 1);
    expect(isLastStep(STEPS.length - 1)).toBe(true);
    expect(isLastStep(0)).toBe(false);
  });

  it('has its texts in English and Brazilian Portuguese', () => {
    for (const k of ['onb.redo', 'onb.welcome.title', 'onb.test.ok', 'onb.finish.title']) expect(isMessageKey(k)).toBe(true);
    expect(translate('pt-BR', 'onb.redo')).toBe('Refazer o tutorial de configuração');
    expect(translate('en', 'onb.redo')).toBe('Redo setup tutorial');
  });
});

describe('onboarding: step 5 detects OBS from the panel state', () => {
  it('follows SwarmCast and OBS through a whole test', () => {
    expect(testStatus(st('off'))).toBe('off');
    expect(testStatus(st('starting'))).toBe('starting');
    expect(testStatus(st('waiting-obs'))).toBe('waiting');
    expect(testStatus(st('waiting-obs', true))).toBe('receiving');
    expect(testStatus(st('live', true))).toBe('ok');
    // OBS dropped mid-live: back to waiting.
    expect(testStatus(st('live', false))).toBe('waiting');
    expect(testStatus(st('stopping', true))).toBe('off');
  });

  it('spots the keyframe warning the server sends', () => {
    expect(keyframeProblem(st('live', true))).toBeNull();
    expect(keyframeProblem(st('live', true, [{ code: 'warn.keyframes', params: { seconds: 8 } }]))).toEqual({ seconds: 8 });
    expect(keyframeProblem(st('live', true, [{ code: 'warn.keyframes' }]))).toEqual({});
    expect(keyframeProblem(st('live', true, [{ code: 'warn.tunnelLimit' }]))).toBeNull();
  });
});

describe('onboarding: PC check degrades gracefully', () => {
  const enc = (ok: boolean, hardware: boolean) => ({ id: 'libx264', ok, hardware }) as QualityState['encoders'][number];
  it('summarizes the quality ladder support', () => {
    expect(videoSupport(null)).toBe('unknown');
    expect(videoSupport({})).toBe('unknown');
    expect(videoSupport({ ffmpeg: { available: false } })).toBe('noFfmpeg');
    expect(videoSupport({ ffmpeg: { available: true }, encoders: [enc(true, true)] })).toBe('hardware');
    expect(videoSupport({ ffmpeg: { available: true }, encoders: [enc(true, false)] })).toBe('software');
    expect(videoSupport({ ffmpeg: { available: true }, encoders: [enc(false, true)] })).toBe('none');
    expect(videoSupport({ ffmpeg: { available: true }, encoders: [], probing: true })).toBe('checking');
  });
});
