import crypto from 'node:crypto';
import type { Challenge } from 'altcha-lib';
import type { CodedText, MessageKey, SecuritySettings, SecurityState } from '@swarmcast/shared';
import type { ActivityLog } from '../core/activity.js';
import type { Logger } from '../core/logger.js';
import { coded } from '../core/messages.js';
import type { PublicBlocklists } from './blocklists.js';
import { ipPrefixLabel } from './cidr.js';
import { AttackDetector, type DetectorOptions, type SignalName, type ThreatState } from './detector.js';
import { JoinPow, type PowLevel, type PowResult } from './pow.js';
import { ReactionPolicy, type ReactionActions } from './reactions.js';
import { BrowserVerification } from './verified.js';

/** Hooks the public server(s) call; implemented by SecurityShield. */
export interface PublicSecurity {
  /** Every viewer-facing request (rate and distinct client IPs). */
  request(ip: string): void;
  /** Someone opened a join link or submitted the join form. */
  joinAttempt(): void;
  /** A join was refused (wrong/old link, removed device, blocked, failed check, full). */
  joinFailed(): void;
  /** We answered 429 (rate limit). */
  rateLimited(): void;
  /** WebSocket upgrade attempt. */
  upgrade(): void;
  /** TLS handshake failed (Direct mode). */
  tlsError(): void;
  /** Open TCP connections changed. */
  connection(delta: number): void;
  /** True (counted and logged without the full IP) when the IP is on a public blocklist. */
  blocked(ip: string): boolean;
  /** Per-IP join rate limit, stricter while tightened. */
  joinRateMax(base: number): number;
  /** Browser check (proof-of-work) level required for new joins. */
  powLevel(): PowLevel;
  issuePow(): Promise<Challenge>;
  verifyPow(payload: unknown): Promise<PowResult>;
  /**
   * The "verified" cookie of this device covers the level required now (always true while no
   * check is required), so the proof-of-work can be skipped. Never a substitute for the link/ticket check or the ban check.
   */
  isVerified(token: string | undefined, deviceId: string | undefined): boolean;
  /** New "verified" cookie value after this device solved a challenge of `level`. */
  issueVerified(deviceId: string, level: 1 | 2): string;
}

/** Plain-words reason for each detector signal (message keys without params). */
export const REASON_KEYS: Record<SignalName, MessageKey> = {
  requests: 'attack.reason.requests',
  joins: 'attack.reason.joins',
  badJoins: 'attack.reason.badJoins',
  rateLimited: 'attack.reason.rateLimited',
  upgrades: 'attack.reason.upgrades',
  tlsErrors: 'attack.reason.tlsErrors',
  ips: 'attack.reason.ips',
  connections: 'attack.reason.connections',
};

const CHECK_KEYS: Record<PowLevel, MessageKey> = { 0: 'security.check.off', 1: 'security.check.light', 2: 'security.check.strong' };

export interface ShieldDeps {
  settings: () => SecuritySettings;
  /** Configured admission limits. */
  limits: () => { maxViewers: number; maxSessionsPerDevice: number };
  blocklists?: PublicBlocklists;
  activity: ActivityLog;
  log: Logger;
  /** Live numbers for the detector: watching viewers, sessions, upload limiter saturation (0..1). */
  sample: () => { viewers: number; sessions: number; saturation: number };
  /** Live-controller side of the reactions. */
  actions: Pick<ReactionActions, 'mode' | 'rotateLink' | 'backToSecure' | 'stopAll' | 'report'>;
  /** State changed (push to the panel). */
  changed: () => void;
  now?: () => number;
  detector?: DetectorOptions;
  /** HMAC key (hex) of the "verified" cookie, from secrets.json (random when omitted: tests). */
  browserCheckKey?: string;
}

/**
 * Glue between the public servers, the attack detector, the reaction policy, the join
 * proof-of-work and the public blocklists. One per app; started/stopped with each live.
 */
export class SecurityShield implements PublicSecurity {
  readonly detector: AttackDetector;
  readonly pow: JoinPow;
  /** Survives stop()/start(): a browser stays remembered across lives (see verified.ts). */
  readonly verification: BrowserVerification;
  private readonly policy: ReactionPolicy;
  private timer: NodeJS.Timeout | null = null;
  private tightened = false;
  private frozenMaxViewers: number | null = null;
  private autoPow: PowLevel = 0;
  private blockedCount = 0;
  private blockLogAt = new Map<string, number>();
  private blockLogMinute = { at: 0, n: 0 };
  private reason?: MessageKey;

  constructor(private readonly d: ShieldDeps) {
    const now = d.now ?? Date.now;
    this.detector = new AttackDetector({ now, ...d.detector });
    this.pow = new JoinPow(now);
    this.verification = new BrowserVerification(d.browserCheckKey ?? crypto.randomBytes(32).toString('hex'), now);
    this.policy = new ReactionPolicy(d.settings, {
      ...d.actions,
      backToSecure: async () => {
        await d.actions.backToSecure();
        // New address, new link, everyone reconnects: start the detector from scratch.
        this.detector.reset(true);
        this.reason = undefined;
      },
      setTightened: (on) => this.setTightened(on),
      setAutoPow: (level) => this.setAutoPow(level),
    });
    this.detector.on('state', (to, from, report) => {
      const top = report.signals[0]?.signal;
      if (top) this.reason = REASON_KEYS[top];
      this.logTransition(to, from);
      void this.policy.onThreat(to, from, this.reason ?? 'attack.reason.requests').catch((err: unknown) => {
        d.log.warn({ err: (err as Error).message }, 'automatic attack reaction failed');
      });
      if (to === 'normal') this.reason = undefined;
      d.changed();
    });
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  /** New live: fresh secrets and counters, sample once per second. */
  start(): void {
    this.stop();
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.detector.reset();
    this.pow.reset();
    this.tightened = false;
    this.frozenMaxViewers = null;
    this.autoPow = 0;
    this.blockedCount = 0;
    this.blockLogAt.clear();
    this.reason = undefined;
  }

  tick(): void {
    const s = this.d.sample();
    this.detector.tick({ viewers: s.viewers, saturation: s.saturation });
  }

  /** The streamer ended the alert: back to normal right away (baselines are kept). */
  clearAlert(): void {
    const was = this.detector.state;
    this.detector.reset(true);
    this.setTightened(false);
    this.setAutoPow(0);
    this.reason = undefined;
    if (was !== 'normal') this.d.activity.action('log.attackCleared');
    this.d.changed();
  }

  // ---- PublicSecurity ----

  request(ip: string): void {
    this.detector.request(ip);
  }
  joinAttempt(): void {
    this.detector.record('joins');
  }
  joinFailed(): void {
    this.detector.record('badJoins');
  }
  rateLimited(): void {
    this.detector.record('rateLimited');
  }
  upgrade(): void {
    this.detector.record('upgrades');
  }
  tlsError(): void {
    this.detector.record('tlsErrors');
  }
  connection(delta: number): void {
    this.detector.connection(delta);
  }

  blocked(ip: string): boolean {
    if (!this.d.settings().blockKnownBadIps || !this.d.blocklists?.isBlocked(ip)) return false;
    this.blockedCount += 1;
    this.logBlocked(ip);
    return true;
  }

  joinRateMax(base: number): number {
    return this.tightened ? Math.max(2, Math.ceil(base / 4)) : base;
  }

  powLevel(): PowLevel {
    const manual: PowLevel = this.d.settings().requireBrowserCheck ? 1 : 0;
    return Math.max(manual, this.autoPow) as PowLevel;
  }

  issuePow(): Promise<Challenge> {
    return this.pow.issue(this.powLevel() === 2 ? 2 : 1);
  }

  verifyPow(payload: unknown): Promise<PowResult> {
    return this.pow.verifyLevel(payload);
  }

  isVerified(token: string | undefined, deviceId: string | undefined): boolean {
    return this.verification.covers(token, deviceId, this.powLevel());
  }

  issueVerified(deviceId: string, level: 1 | 2): string {
    return this.verification.issue(deviceId, level);
  }

  // ---- admission ----

  /** Admission limits in force (configured, or stricter while tightened). */
  effectiveLimits(): { maxViewers: number; maxSessionsPerDevice: number } {
    const cfg = this.d.limits();
    if (!this.tightened) return cfg;
    return { maxViewers: Math.min(cfg.maxViewers, this.frozenMaxViewers ?? cfg.maxViewers), maxSessionsPerDevice: 1 };
  }

  private setTightened(on: boolean): void {
    if (on === this.tightened) return;
    this.tightened = on;
    if (on) {
      // Let roughly a quarter more people in than are here now, so a real raid still gets in slowly.
      const sessions = this.d.sample().sessions;
      this.frozenMaxViewers = Math.max(20, Math.ceil(sessions * 1.25) + 10);
      const eff = this.effectiveLimits();
      this.d.activity.action('log.react.tightened', { max: eff.maxViewers }, 'warn');
    } else {
      this.frozenMaxViewers = null;
      this.d.activity.action('log.react.relaxed');
    }
    this.d.changed();
  }

  private setAutoPow(level: PowLevel): void {
    if (level === this.autoPow) return;
    const before = this.powLevel();
    this.autoPow = level;
    const after = this.powLevel();
    if (after !== before) this.d.activity.action('log.react.browserCheck', { levelKey: CHECK_KEYS[after] }, after > before ? 'warn' : 'info');
    this.d.changed();
  }

  private logTransition(to: ThreatState, from: ThreatState): void {
    const reasonKey = this.reason ?? 'attack.reason.requests';
    if (to === 'attack') {
      this.d.activity.add({ level: 'warn', kind: 'system', code: 'log.attackDetected', params: { reasonKey } });
      this.d.log.warn({ panel: true, reason: reasonKey }, 'attack detected');
    } else if (to === 'suspicious' && from === 'normal') {
      this.d.activity.add({ level: 'warn', kind: 'system', code: 'log.attackSuspicious', params: { reasonKey } });
    } else if (to === 'suspicious') {
      this.d.activity.add({ kind: 'system', code: 'log.attackCalmer' });
    } else {
      this.d.activity.add({ kind: 'system', code: 'log.attackOver' });
    }
  }

  private logBlocked(ip: string): void {
    const now = this.now();
    const prefix = ipPrefixLabel(ip);
    const last = this.blockLogAt.get(prefix);
    if (last !== undefined && now - last < 10 * 60_000) return;
    if (now - this.blockLogMinute.at > 60_000) this.blockLogMinute = { at: now, n: 0 };
    if (this.blockLogMinute.n >= 10) return;
    this.blockLogMinute.n += 1;
    if (this.blockLogAt.size > 5000) this.blockLogAt.clear();
    this.blockLogAt.set(prefix, now);
    this.d.activity.add({ kind: 'system', code: 'log.blocklistBlocked', params: { prefix } });
  }

  // ---- panel ----

  /** Panel warning while something is going on. */
  warning(): CodedText | undefined {
    const st = this.detector.state;
    if (st === 'normal') return undefined;
    const reasonKey = this.reason ?? 'attack.reason.requests';
    return coded(st === 'attack' ? 'warn.attackDetected' : 'warn.attackSuspicious', { reasonKey });
  }

  snapshot(): SecurityState {
    const eff = this.effectiveLimits();
    const info = this.d.blocklists?.info();
    const st = this.detector.state;
    return {
      settings: this.d.settings(),
      threat: st,
      ...(st !== 'normal' ? { threatSince: this.detector.report.since, ...(this.reason ? { reasonCode: this.reason } : {}) } : {}),
      browserCheck: this.powLevel(),
      tightened: this.tightened,
      effectiveMaxViewers: eff.maxViewers,
      effectiveMaxSessionsPerDevice: eff.maxSessionsPerDevice,
      blockedByLists: this.blockedCount,
      blocklists: {
        enabled: !!info?.enabled,
        networks: info?.networks ?? 0,
        ...(info?.updatedAt ? { updatedAt: info.updatedAt } : {}),
        failedLists: info?.lists.filter((l) => l.entries === 0 && l.error).length ?? 0,
      },
    };
  }
}
