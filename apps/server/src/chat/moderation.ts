import crypto from 'node:crypto';
import { defaultNameColor, type ChatAuthor, type ChatRole } from '@swarmcast/shared';

/** Per-session chat identity: opaque author key, colour, lock. */
export interface ChatMember {
  sessionId: string;
  deviceId: string;
  a: string;
  nickname: string;
  color: string;
  colorLocked: boolean;
  role: ChatRole;
  tag: string;
}

/** Mutes kept per live (they survive a rejoin from the same device). */
const MAX_MUTES = 10_000;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** 4 base32 characters derived from the session id: tells apart look-alike names (never the id itself). */
function tagOf(sessionId: string, salt: Buffer): string {
  const h = crypto.createHmac('sha256', salt).update(sessionId).digest();
  let out = '';
  for (let i = 0; i < 4; i++) out += BASE32[h[i]! & 31];
  return out;
}

/**
 * Chat members (author keys, colours) and mutes. Everything is wiped on Stop. Mutes are keyed by
 * the device cookie and the session, never by IP: many viewers share one IP behind CGNAT.
 */
export class ChatModeration {
  private counter = 0;
  private salt = crypto.randomBytes(16);
  private readonly bySession = new Map<string, ChatMember>();
  private readonly byKey = new Map<string, ChatMember>();
  /** deviceId (or "s:" + sessionId) → until (ms) or 'live'. */
  private readonly mutes = new Map<string, number | 'live'>();
  /** Colours chosen or set per device, so a rejoin keeps them within the live. */
  private readonly colors = new Map<string, { color: string; locked: boolean }>();

  constructor(private readonly now: () => number = Date.now) {}

  member(s: { id: string; deviceId: string; nickname: string }, role: ChatRole = 'viewer'): ChatMember {
    let m = this.bySession.get(s.id);
    if (m) {
      m.nickname = s.nickname;
      return m;
    }
    const a = (++this.counter).toString(36);
    const kept = this.colors.get(s.deviceId);
    m = {
      sessionId: s.id,
      deviceId: s.deviceId,
      a,
      nickname: s.nickname,
      color: kept?.color ?? defaultNameColor(a + this.salt.toString('hex', 0, 4)),
      colorLocked: kept?.locked ?? false,
      role,
      tag: tagOf(s.id, this.salt),
    };
    this.bySession.set(s.id, m);
    this.byKey.set(a, m);
    return m;
  }

  bySessionId(id: string): ChatMember | undefined {
    return this.bySession.get(id);
  }

  byAuthor(a: string): ChatMember | undefined {
    return this.byKey.get(a);
  }

  /** Forget a member whose session ended (its messages stay readable through `author`). */
  forget(sessionId: string, keepAuthor: (a: string) => boolean): void {
    const m = this.bySession.get(sessionId);
    if (!m) return;
    this.bySession.delete(sessionId);
    if (!keepAuthor(m.a)) this.byKey.delete(m.a);
  }

  /** Drop author entries no longer referenced (roster cap). */
  prune(keep: (m: ChatMember) => boolean): void {
    for (const [a, m] of this.byKey) if (!this.bySession.has(m.sessionId) && !keep(m)) this.byKey.delete(a);
  }

  author(m: ChatMember): ChatAuthor {
    return { a: m.a, n: m.nickname, c: m.color, r: m.role, tag: m.tag };
  }

  authorOf(a: string): ChatAuthor | undefined {
    const m = this.byKey.get(a);
    return m ? this.author(m) : undefined;
  }

  get authors(): number {
    return this.byKey.size;
  }

  members(): IterableIterator<ChatMember> {
    return this.bySession.values();
  }

  setColor(m: ChatMember, color: string | null, locked: boolean): void {
    m.color = color ?? defaultNameColor(m.a + this.salt.toString('hex', 0, 4));
    m.colorLocked = locked;
    this.colors.set(m.deviceId, { color: m.color, locked });
    if (this.colors.size > MAX_MUTES) this.colors.delete(this.colors.keys().next().value!);
  }

  // ---- mutes ----

  mute(m: Pick<ChatMember, 'deviceId' | 'sessionId'>, minutes: number | null): number | 'live' {
    const until = minutes === null ? 'live' : this.now() + minutes * 60_000;
    this.mutes.set(m.deviceId, until);
    this.mutes.set(`s:${m.sessionId}`, until);
    while (this.mutes.size > MAX_MUTES) this.mutes.delete(this.mutes.keys().next().value!);
    return until;
  }

  unmute(m: Pick<ChatMember, 'deviceId' | 'sessionId'>): void {
    this.mutes.delete(m.deviceId);
    this.mutes.delete(`s:${m.sessionId}`);
  }

  /** Until when this device/session is muted: ms, 'live', or null. O(1). */
  mutedUntil(s: { id: string; deviceId: string }): number | 'live' | null {
    for (const k of [s.deviceId, `s:${s.id}`]) {
      const v = this.mutes.get(k);
      if (v === undefined) continue;
      if (v === 'live' || v > this.now()) return v;
      this.mutes.delete(k);
    }
    return null;
  }

  get muteCount(): number {
    return this.mutes.size;
  }

  reset(): void {
    this.counter = 0;
    this.salt = crypto.randomBytes(16);
    this.bySession.clear();
    this.byKey.clear();
    this.mutes.clear();
    this.colors.clear();
  }
}
