import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { SignJWT, jwtVerify, type JWTVerifyResult } from 'jose';
import { CHAT_RESERVED_NAMES, JOIN_TICKET_TTL_S, NICKNAME_MAX, SESSION_TTL_S, countGraphemes, type DeviceKind, type P2PBlockReason } from '@swarmcast/shared';
import { nameKeys } from '@swarmcast/shared/chat/skeleton';

export interface Session {
  id: string;
  nickname: string;
  deviceId: string;
  device: DeviceKind;
  /** Client IP, in memory only, used for rate limiting and bans. */
  ip: string;
  joinedAt: number;
  /** Link generation the session joined with. */
  linkGeneration: number;
  /** Streamer allows this session to take part in P2P. */
  p2pAllowed: boolean;
  /** Viewer opted in to P2P in the player. */
  p2pEnabled: boolean;
  /**
   * Seen on the streamer's own internet connection (Secure mode): P2P would show the other P2P
   * viewers the IP the server runs behind, so it stays off for this session, whatever the
   * streamer's switches say (access/own-connection.ts).
   */
  ownConnection: boolean;
  autoRemovedFromP2P: boolean;
  hashFailures: number;
  peerIds: Set<string>;
  stats: { httpBytes: number; p2pDownBytes: number; p2pUpBytes: number; peers: number };
  http429: number;
  /** Seconds behind live the player last reported (adaptive delay), null before playback. */
  delayS: number | null;
  /** Number of open control channels. */
  connections: number;
  lastSeenAt: number;
  /** Look-alike keys of the nickname (skeleton.ts): two live viewers never share one. */
  nameKeys: [string, string];
  /** This session already opened a WebSocket once (reconnects are not counted by the shield). */
  upgraded?: boolean;
}

/** A session counts as present for name uniqueness while connected or seen this recently. */
export const NAME_ACTIVE_MS = 30_000;

const RESERVED_KEYS = new Set(CHAT_RESERVED_NAMES.flatMap((n) => nameKeys(n)));

export type AccessEvents = {
  kicked: [session: Session];
  'p2p-changed': [session: Session];
  'session-created': [session: Session];
  'link-rotated': [generation: number];
  'all-disconnected': [];
  reset: [];
};

export type JoinError = 'invalid-link' | 'banned' | 'not-live';

/**
 * In-memory access control for one live.
 * Everything here (secrets, sessions, bans) disappears on reset().
 */
export class AccessControl extends EventEmitter<AccessEvents> {
  liveId = '';
  live = false;
  linkGeneration = 0;
  private linkSecretHash: Buffer | null = null;
  private linkSecret = '';
  private jwtKey: Uint8Array = new Uint8Array(32);
  readonly sessions = new Map<string, Session>();
  /**
   * Kicked devices (device cookie). We deliberately do not ban IPs: many viewers share
   * one IP behind mobile-carrier CGNAT, so an IP ban would lock out innocent subscribers.
   */
  private bannedDevices = new Set<string>();

  /** The streamer's switch for everyone ("Allow P2P for viewers"); per-viewer removal comes on top. */
  p2pForAll = true;
  /**
   * The server's own public address is not known right now (Secure mode), so nobody can be told
   * apart from someone at the streamer's home: P2P waits for everyone.
   */
  p2pChecking = false;

  constructor(private readonly now: () => number = Date.now) {
    super();
  }

  /** May this viewer use P2P right now (global switch, per-viewer removal, the streamer's privacy)? */
  p2pAllowed(session: Pick<Session, 'p2pAllowed' | 'ownConnection'>): boolean {
    return this.p2pForAll && session.p2pAllowed && !session.ownConnection && !this.p2pChecking;
  }

  /** Why P2P is off for this viewer although the streamer did not turn it off (shown on the watch page). */
  p2pBlock(session: Pick<Session, 'ownConnection'>): P2PBlockReason | undefined {
    if (session.ownConnection) return 'own-connection';
    if (this.p2pChecking) return 'checking';
    return undefined;
  }

  /** Begin a new live: fresh id, signing key and link secret. */
  begin(): string {
    this.reset();
    this.live = true;
    this.liveId = crypto.randomBytes(9).toString('base64url');
    this.jwtKey = crypto.randomBytes(32);
    return this.rotateLink();
  }

  /** Forget everything. Called by "Stop everything". */
  reset(): void {
    const hadSessions = this.sessions.size > 0;
    this.live = false;
    this.liveId = '';
    this.linkSecret = '';
    this.linkSecretHash = null;
    this.jwtKey = crypto.randomBytes(32);
    this.sessions.clear();
    this.bannedDevices.clear();
    this.linkGeneration = 0;
    this.p2pChecking = false;
    if (hadSessions) this.emit('reset');
  }

  /**
   * New 256-bit link secret. The old link stops working for new joins; current viewers stay.
   * Browsers that passed the browser check stay remembered (security/verified.ts): the check is
   * about bots, not about who may watch, and the new link is still required to join.
   */
  rotateLink(): string {
    this.linkSecret = crypto.randomBytes(32).toString('base64url');
    this.linkSecretHash = sha256(this.linkSecret);
    this.linkGeneration += 1;
    this.emit('link-rotated', this.linkGeneration);
    return this.linkSecret;
  }

  get currentSecret(): string {
    return this.linkSecret;
  }

  checkSecret(candidate: string): boolean {
    if (!this.live || !this.linkSecretHash) return false;
    if (candidate.length > 128) return false;
    return crypto.timingSafeEqual(sha256(candidate), this.linkSecretHash);
  }

  isBanned(deviceId: string | undefined): boolean {
    return deviceId !== undefined && this.bannedDevices.has(deviceId);
  }

  get bannedCount(): number {
    return this.bannedDevices.size;
  }

  clearBans(): void {
    this.bannedDevices.clear();
  }

  /** Short-lived ticket proving the holder opened the current link (lets us drop the secret from the URL). */
  async issueTicket(): Promise<string> {
    return new SignJWT({ typ: 'ticket', lid: this.liveId, gen: this.linkGeneration })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(new Date(this.now()))
      .setExpirationTime(new Date(this.now() + JOIN_TICKET_TTL_S * 1000))
      .sign(this.jwtKey);
  }

  /** jwtVerify on this instance's clock (the one `now` injects), like the iat/exp it issued. */
  private verifyJwt(token: string): Promise<JWTVerifyResult> {
    return jwtVerify(token, this.jwtKey, { algorithms: ['HS256'], currentDate: new Date(this.now()) });
  }

  async verifyTicket(token: string | undefined): Promise<boolean> {
    if (!token || !this.live) return false;
    try {
      const { payload } = await this.verifyJwt(token);
      return payload.typ === 'ticket' && payload.lid === this.liveId && payload.gen === this.linkGeneration;
    } catch {
      return false;
    }
  }

  /**
   * Admission check before creating a session: refuses when the stream is full and keeps
   * each device to `perDevice` sessions by ending its oldest ones.
   */
  admit(deviceId: string, maxViewers: number, perDevice: number): 'ok' | 'full' {
    const own = [...this.sessions.values()].filter((s) => s.deviceId === deviceId).sort((a, b) => a.joinedAt - b.joinedAt);
    while (own.length >= perDevice) this.sessions.delete(own.shift()!.id);
    return this.sessions.size >= maxViewers ? 'full' : 'ok';
  }

  createSession(input: { nickname: string; deviceId: string; device: DeviceKind; ip: string }): Session {
    const session: Session = {
      id: crypto.randomBytes(12).toString('base64url'),
      nickname: input.nickname,
      deviceId: input.deviceId,
      device: input.device,
      ip: input.ip,
      joinedAt: this.now(),
      linkGeneration: this.linkGeneration,
      p2pAllowed: true,
      p2pEnabled: false,
      ownConnection: false,
      autoRemovedFromP2P: false,
      hashFailures: 0,
      peerIds: new Set(),
      stats: { httpBytes: 0, p2pDownBytes: 0, p2pUpBytes: 0, peers: 0 },
      http429: 0,
      delayS: null,
      connections: 0,
      lastSeenAt: this.now(),
      nameKeys: nameKeys(input.nickname),
    };
    this.sessions.set(session.id, session);
    this.emit('session-created', session);
    return session;
  }

  async issueSessionToken(session: Session): Promise<string> {
    return new SignJWT({ typ: 'session', lid: this.liveId, sid: session.id })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(new Date(this.now()))
      .setExpirationTime(new Date(this.now() + SESSION_TTL_S * 1000))
      .sign(this.jwtKey);
  }

  /**
   * Validate a session cookie. Returns the session and whether the token should be renewed
   * (less than half of its lifetime left).
   */
  async verifySessionToken(token: string | undefined): Promise<{ session: Session; renew: boolean } | null> {
    if (!token || !this.live) return null;
    try {
      const { payload } = await this.verifyJwt(token);
      if (payload.typ !== 'session' || payload.lid !== this.liveId || typeof payload.sid !== 'string') return null;
      const session = this.sessions.get(payload.sid);
      if (!session) return null;
      session.lastSeenAt = this.now();
      const remaining = (payload.exp ?? 0) * 1000 - this.now();
      return { session, renew: remaining < (SESSION_TTL_S * 1000) / 2 };
    } catch {
      return null;
    }
  }

  /** Drop the session now and block the device until the live ends. */
  kick(sessionId: string): Session | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    this.bannedDevices.add(session.deviceId);
    this.sessions.delete(sessionId);
    this.emit('kicked', session);
    return session;
  }

  /**
   * Disconnect everyone without banning (they can rejoin with the current link). Like a new link,
   * this does not forget which browsers passed the browser check: that is about bots, not access.
   */
  disconnectAll(): void {
    this.sessions.clear();
    this.emit('all-disconnected');
  }

  setP2PAllowed(sessionId: string, allowed: boolean, auto = false): Session | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    session.p2pAllowed = allowed;
    session.autoRemovedFromP2P = !allowed && auto;
    if (allowed) session.hashFailures = 0;
    this.emit('p2p-changed', session);
    return session;
  }

  /**
   * Why this nickname cannot join now: 'reserved' (looks like "Streamer", "admin"… or the
   * streamer's chat name) or 'taken' (looks like the name of someone else watching). The same
   * device may rejoin with its own name (a new tab or a reload).
   */
  nicknameProblem(nickname: string, deviceId: string, extraReserved: Iterable<string> = []): 'reserved' | 'taken' | null {
    const keys = nameKeys(nickname);
    const reserved = new Set(RESERVED_KEYS);
    for (const r of extraReserved) if (r.trim()) for (const k of nameKeys(r)) reserved.add(k);
    if (keys.some((k) => reserved.has(k))) return 'reserved';
    return this.nameTaken(keys, deviceId) ? 'taken' : null;
  }

  private nameTaken(keys: readonly string[], deviceId: string): boolean {
    const now = this.now();
    for (const s of this.sessions.values()) {
      if (s.deviceId === deviceId) continue;
      if (s.connections === 0 && now - s.lastSeenAt >= NAME_ACTIVE_MS) continue;
      if (s.nameKeys.some((k) => keys.includes(k))) return true;
    }
    return false;
  }

  /** A free variant of a taken nickname: the name plus a digit (shortened to fit). */
  suggestNickname(nickname: string, deviceId: string): string {
    for (let d = 2; d <= 99; d++) {
      const suffix = String(d);
      let base = nickname;
      while (countGraphemes(base + suffix) > NICKNAME_MAX) base = [...base].slice(0, -1).join('');
      const candidate = base + suffix;
      if (!this.nameTaken(nameKeys(candidate), deviceId)) return candidate;
    }
    return nickname;
  }

  // ---- branding: tokens derived from this live's key ----

  private hmac(label: string): string {
    return crypto.createHmac('sha256', this.jwtKey).update(label).digest('base64url').slice(0, 22);
  }

  /** Sent by our own reachability checks (X-SwarmCast-Probe): only then does /healthz say which live is on. */
  probeToken(): string {
    return this.hmac('probe');
  }

  checkProbeToken(candidate: string | undefined): boolean {
    return typeof candidate === 'string' && safeEqual(candidate, this.probeToken());
  }

  /** Token in the link-preview card URL: derived from the current link, so it dies with "New link". Empty when off. */
  previewToken(): string {
    return this.live && this.linkSecret ? this.hmac(`preview:${this.linkSecret}`) : '';
  }

  checkPreviewToken(candidate: string): boolean {
    const t = this.previewToken();
    return t !== '' && safeEqual(candidate, t);
  }

  sessionByPeerId(peerId: string): Session | undefined {
    for (const s of this.sessions.values()) if (s.peerIds.has(peerId)) return s;
    return undefined;
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = sha256(a);
  const y = sha256(b);
  return crypto.timingSafeEqual(x, y);
}

function sha256(s: string): Buffer {
  return crypto.createHash('sha256').update(s).digest();
}
