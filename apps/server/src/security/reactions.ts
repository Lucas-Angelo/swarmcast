import type { MessageKey, MessageParams, SecuritySettings } from '@swarmcast/shared';
import type { ThreatState } from './detector.js';
import type { PowLevel } from './pow.js';

/** What the reaction policy may do; implemented by the live controller (mocked in tests). */
export interface ReactionActions {
  mode(): 'secure' | 'direct';
  /** Temporarily stricter join rate limits and session admission. */
  setTightened(on: boolean): void;
  /** Proof-of-work level chosen automatically (the manual switch is applied on top). */
  setAutoPow(level: PowLevel): void;
  /** New link (old one stops working); the panel highlights it. */
  rotateLink(): void;
  /** Leave Direct mode and go back to the tunnel. Throws when that fails. */
  backToSecure(): Promise<void>;
  /** The existing "Stop everything" flow. */
  stopAll(): Promise<boolean>;
  /** Tell the streamer what happened (panel warning + activity log + desktop notification). */
  report(code: MessageKey, params?: MessageParams): void;
}

/**
 * Automatic reactions to the detector's state changes.
 * - Secure mode (volumetric floods hit Cloudflare, not the PC): suspicious → light browser
 *   check; attack → tighter limits, stronger check, optionally a new link (once per attack).
 * - Direct mode (the home IP is exposed): at the first signs → back to Secure mode, and if that
 *   fails → Stop everything.
 * - "Turn everything off if an attack is detected" overrides the rest.
 * Never turns Direct mode on.
 */
export class ReactionPolicy {
  private rotated = false;
  private drastic: Promise<void> | null = null;

  constructor(
    private readonly settings: () => SecuritySettings,
    private readonly a: ReactionActions,
  ) {}

  /** React to a state change. `reasonKey` explains the main signal in plain words. */
  async onThreat(to: ThreatState, from: ThreatState, reasonKey: MessageKey): Promise<void> {
    const s = this.settings();
    if (to === 'normal') {
      this.rotated = false;
      this.a.setTightened(false);
      this.a.setAutoPow(0);
      return;
    }
    const escalating = from === 'normal' || (from === 'suspicious' && to === 'attack');
    if (!escalating) {
      // attack → suspicious: keep limits tight until fully calm, lighten the check.
      if (s.autoBrowserCheck) this.a.setAutoPow(1);
      return;
    }
    if (this.drastic) return;

    if (s.stopOnAttack && to === 'attack') {
      await this.runDrastic(async () => {
        await this.a.stopAll();
        this.a.report('react.stopped', { reasonKey });
      });
      return;
    }

    if (this.a.mode() === 'direct') {
      if (s.stopOnAttack) {
        await this.runDrastic(async () => {
          await this.a.stopAll();
          this.a.report('react.stopped', { reasonKey });
        });
      } else if (s.autoSecureFromDirect) {
        await this.runDrastic(async () => {
          try {
            await this.a.backToSecure();
            this.a.report('react.backToSecure', { reasonKey });
          } catch (err) {
            if (s.autoStopIfDirectFails) {
              await this.a.stopAll();
              this.a.report('react.backToSecureFailedStopped', { reasonKey, error: (err as Error).message });
            } else {
              this.a.report('react.backToSecureFailed', { reasonKey, error: (err as Error).message });
            }
          }
        });
      } else {
        this.a.report('react.directNoAction', { reasonKey });
      }
      return;
    }

    // Secure mode.
    if (to === 'suspicious') {
      if (s.autoBrowserCheck) this.a.setAutoPow(1);
      return;
    }
    if (s.autoTighten) this.a.setTightened(true);
    if (s.autoBrowserCheck) this.a.setAutoPow(2);
    if (s.autoNewLink && !this.rotated) {
      this.rotated = true;
      this.a.rotateLink();
      this.a.report('react.newLink', { reasonKey });
    }
  }

  private async runDrastic(fn: () => Promise<void>): Promise<void> {
    this.drastic = fn().finally(() => {
      this.drastic = null;
    });
    await this.drastic;
  }
}
