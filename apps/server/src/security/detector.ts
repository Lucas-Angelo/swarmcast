import { EventEmitter } from 'node:events';

/**
 * Rolling-window attack detector for the public server(s). Pure logic: callers feed events
 * and call tick() about once per second; the clock is injectable for tests.
 *
 * Each signal is compared with a threshold that adapts to the stream:
 *   threshold = max(absolute floor, k × learned baseline (EWMA), perViewer × watching viewers)
 * so a busy stream with hundreds of viewers does not look like an attack, while a flood on a
 * small stream still does. Baselines only learn while everything is calm.
 */

export type CounterSignal = 'requests' | 'joins' | 'badJoins' | 'rateLimited' | 'upgrades' | 'tlsErrors';
export type GaugeSignal = 'ips' | 'connections';
export type SignalName = CounterSignal | GaugeSignal;
export type ThreatState = 'normal' | 'suspicious' | 'attack';

export interface SignalRule {
  /** Absolute floors (per second for counters, a count for gauges). */
  susp: number;
  attack: number;
  /** Multiples of the learned baseline. */
  kSusp: number;
  kAttack: number;
  /** Expected amount per watching viewer (raises the thresholds on big streams). */
  perViewerSusp: number;
  perViewerAttack: number;
}

/**
 * Defaults. Rates are averages over the window (10 s). A viewer without P2P makes about
 * 1–3 HLS requests per second and keeps 2 WebSockets open; joining is 2 requests.
 */
export const DEFAULT_RULES: Record<SignalName, SignalRule> = {
  requests: { susp: 150, attack: 400, kSusp: 4, kAttack: 8, perViewerSusp: 6, perViewerAttack: 12 },
  joins: { susp: 8, attack: 25, kSusp: 5, kAttack: 10, perViewerSusp: 0.05, perViewerAttack: 0.15 },
  badJoins: { susp: 1.5, attack: 5, kSusp: 5, kAttack: 10, perViewerSusp: 0.01, perViewerAttack: 0.03 },
  rateLimited: { susp: 2, attack: 10, kSusp: 5, kAttack: 10, perViewerSusp: 0.02, perViewerAttack: 0.05 },
  upgrades: { susp: 10, attack: 30, kSusp: 4, kAttack: 8, perViewerSusp: 0.1, perViewerAttack: 0.3 },
  tlsErrors: { susp: 3, attack: 10, kSusp: 5, kAttack: 10, perViewerSusp: 0.02, perViewerAttack: 0.05 },
  // Distinct client IPs seen during the window.
  ips: { susp: 150, attack: 500, kSusp: 3, kAttack: 6, perViewerSusp: 1.5, perViewerAttack: 3 },
  // Open TCP connections right now.
  connections: { susp: 400, attack: 1500, kSusp: 3, kAttack: 6, perViewerSusp: 6, perViewerAttack: 12 },
};

export interface DetectorOptions {
  now?: () => number;
  rules?: Partial<Record<SignalName, Partial<SignalRule>>>;
  /** Averaging window in seconds. */
  windowS?: number;
  /** How long a level must persist before the state escalates. */
  escalateAfterMs?: number;
  /** Calm time needed to go from attack back to suspicious, and from suspicious to normal. */
  attackCalmMs?: number;
  suspiciousCalmMs?: number;
  /** While elevated, thresholds are multiplied by this (< 1), so the state does not flap. */
  exitFactor?: number;
  /** EWMA time constant of the baselines. */
  baselineTauS?: number;
  /** Upload limiter saturation (0..1) at or above which a suspicious signal counts as an attack. */
  saturationCorroborates?: number;
  /** Bound on remembered client IPs. */
  maxTrackedIps?: number;
}

export interface SignalReport {
  signal: SignalName;
  value: number;
  /** Threshold that was crossed. */
  threshold: number;
  level: 1 | 2;
}

export interface DetectorReport {
  state: ThreatState;
  /** Level computed for the last tick (0 calm, 1 suspicious, 2 attack). */
  level: 0 | 1 | 2;
  /** Signals over their threshold in the last tick, most severe first. */
  signals: SignalReport[];
  /** Upload limiter saturation used in the last tick. */
  saturation: number;
  since: number;
}

export interface DetectorEvents {
  state: [to: ThreatState, from: ThreatState, report: DetectorReport];
}

const COUNTERS: CounterSignal[] = ['requests', 'joins', 'badJoins', 'rateLimited', 'upgrades', 'tlsErrors'];
const ALL: SignalName[] = [...COUNTERS, 'ips', 'connections'];
const RANK: Record<ThreatState, number> = { normal: 0, suspicious: 1, attack: 2 };

export class AttackDetector extends EventEmitter<DetectorEvents> {
  private readonly now: () => number;
  private readonly rules: Record<SignalName, SignalRule>;
  private readonly windowS: number;
  private readonly o: Required<Omit<DetectorOptions, 'now' | 'rules' | 'windowS'>>;
  /** Counts in the current (open) second. */
  private current = zeroCounters();
  /** Closed seconds, newest last (at most windowS). */
  private ring: Array<Record<CounterSignal, number>> = [];
  private ips = new Map<string, number>();
  private tickNo = 0;
  private connections = 0;
  private baseline = zeroSignals();
  private lastTickAt: number;
  state: ThreatState = 'normal';
  private stateSince: number;
  /** When the computed level first reached each value (for escalation) / last exceeded it (for calm). */
  private levelSince: [number, number, number];
  private lastHot: [number, number, number];
  private last: DetectorReport;

  constructor(opts: DetectorOptions = {}) {
    super();
    this.now = opts.now ?? Date.now;
    this.windowS = opts.windowS ?? 10;
    this.rules = Object.fromEntries(ALL.map((s) => [s, { ...DEFAULT_RULES[s], ...opts.rules?.[s] }])) as Record<SignalName, SignalRule>;
    this.o = {
      escalateAfterMs: opts.escalateAfterMs ?? 3_000,
      attackCalmMs: opts.attackCalmMs ?? 60_000,
      suspiciousCalmMs: opts.suspiciousCalmMs ?? 120_000,
      exitFactor: opts.exitFactor ?? 0.6,
      baselineTauS: opts.baselineTauS ?? 300,
      saturationCorroborates: opts.saturationCorroborates ?? 0.95,
      maxTrackedIps: opts.maxTrackedIps ?? 20_000,
    };
    const t = this.now();
    this.lastTickAt = t;
    this.stateSince = t;
    this.levelSince = [Infinity, Infinity, Infinity];
    this.lastHot = [0, 0, 0];
    this.last = { state: 'normal', level: 0, signals: [], saturation: 0, since: t };
  }

  /** Forget everything (new live, or the streamer ended the alert). */
  reset(keepBaselines = false): void {
    const t = this.now();
    this.current = zeroCounters();
    this.ring = [];
    this.ips.clear();
    this.connections = 0;
    if (!keepBaselines) this.baseline = zeroSignals();
    this.state = 'normal';
    this.stateSince = t;
    this.lastTickAt = t;
    this.levelSince = [Infinity, Infinity, Infinity];
    this.lastHot = [0, 0, 0];
    this.last = { state: 'normal', level: 0, signals: [], saturation: 0, since: t };
  }

  record(signal: CounterSignal, n = 1): void {
    this.current[signal] += n;
  }

  /** A request from this client IP (feeds "requests" and the distinct-IP count). */
  request(ip: string | undefined): void {
    this.current.requests += 1;
    if (!ip) return;
    if (this.ips.size < this.o.maxTrackedIps || this.ips.has(ip)) this.ips.set(ip, this.tickNo);
  }

  /** Open connections changed by `delta`. */
  connection(delta: number): void {
    this.connections = Math.max(0, this.connections + delta);
  }

  get report(): DetectorReport {
    return this.last;
  }

  /**
   * Close the current second and re-evaluate. `viewers` = people watching now;
   * `saturation` = how close the upload limiter is to its cap (0..1).
   */
  tick(input: { viewers: number; saturation?: number }): DetectorReport {
    const t = this.now();
    const elapsedS = Math.max(0.001, (t - this.lastTickAt) / 1000);
    this.lastTickAt = t;
    this.tickNo += 1;
    this.ring.push(this.current);
    this.current = zeroCounters();
    if (this.ring.length > this.windowS) this.ring.splice(0, this.ring.length - this.windowS);
    const oldest = this.tickNo - this.windowS;
    for (const [ip, at] of this.ips) if (at <= oldest) this.ips.delete(ip);

    const values = this.values();
    const saturation = clamp01(input.saturation ?? 0);
    const viewers = Math.max(0, input.viewers);
    const factor = this.state === 'normal' ? 1 : this.o.exitFactor;
    const signals: SignalReport[] = [];
    for (const s of ALL) {
      const r = this.rules[s];
      const b = this.baseline[s];
      const susp = Math.max(r.susp, r.kSusp * b, r.perViewerSusp * viewers) * factor;
      const attack = Math.max(r.attack, r.kAttack * b, r.perViewerAttack * viewers) * factor;
      const v = values[s];
      if (v >= attack) signals.push({ signal: s, value: v, threshold: attack, level: 2 });
      else if (v >= susp) signals.push({ signal: s, value: v, threshold: susp, level: 1 });
    }
    signals.sort((a, b) => b.level - a.level || b.value / b.threshold - a.value / a.threshold);
    let level: 0 | 1 | 2 = signals.length ? signals[0]!.level : 0;
    // Several anomalies at once, or one while the upload is maxed out, add up to an attack.
    if (level === 1 && (signals.length >= 3 || saturation >= this.o.saturationCorroborates)) level = 2;

    // Baselines learn only while calm, so an attack never becomes "normal".
    if (this.state === 'normal' && level === 0) {
      const alpha = 1 - Math.exp(-elapsedS / this.o.baselineTauS);
      for (const s of ALL) this.baseline[s] += alpha * (values[s] - this.baseline[s]);
    }

    for (const l of [1, 2] as const) {
      if (level >= l) {
        if (!Number.isFinite(this.levelSince[l])) this.levelSince[l] = t;
        this.lastHot[l] = t;
      } else {
        this.levelSince[l] = Number.POSITIVE_INFINITY;
      }
    }

    const prev = this.state;
    let next: ThreatState = prev;
    const sustained = (l: 1 | 2): boolean => level >= l && t - this.levelSince[l] >= this.o.escalateAfterMs;
    if (sustained(2)) next = 'attack';
    else if (sustained(1) && prev === 'normal') next = 'suspicious';
    else if (prev === 'attack' && t - this.lastHot[2] >= this.o.attackCalmMs) next = 'suspicious';
    else if (prev === 'suspicious' && t - this.lastHot[1] >= this.o.suspiciousCalmMs) next = 'normal';

    if (next !== prev) {
      this.state = next;
      this.stateSince = t;
      // Calming down from attack to suspicious restarts the suspicious calm timer.
      if (RANK[next] < RANK[prev]) this.lastHot[1] = t;
    }
    this.last = { state: this.state, level, signals, saturation, since: this.stateSince };
    if (next !== prev) this.emit('state', next, prev, this.last);
    return this.last;
  }

  /** Current window values (rates per second for counters). */
  values(): Record<SignalName, number> {
    const n = Math.max(1, this.ring.length);
    const out = zeroSignals();
    for (const b of this.ring) for (const s of COUNTERS) out[s] += b[s];
    for (const s of COUNTERS) out[s] /= n;
    out.ips = this.ips.size;
    out.connections = this.connections;
    return out;
  }

  /** Learned baselines (for diagnostics/tests). */
  baselines(): Record<SignalName, number> {
    return { ...this.baseline };
  }
}

function zeroCounters(): Record<CounterSignal, number> {
  return { requests: 0, joins: 0, badJoins: 0, rateLimited: 0, upgrades: 0, tlsErrors: 0 };
}

function zeroSignals(): Record<SignalName, number> {
  return { ...zeroCounters(), ips: 0, connections: 0 };
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}
