import { z } from 'zod';
import { NICKNAME_MAX } from './constants.js';
import { translate, type MessageKey, type MessageParams } from './i18n/index.js';

/**
 * A server-generated text with a stable code for client-side translation.
 * `code` is a message key of the shared dictionaries; `text` (where present) is the English text.
 */
export interface CodedMessage {
  code: MessageKey;
  params?: MessageParams;
}
export interface CodedText extends CodedMessage {
  text: string;
}

/** Error body of the viewer and admin APIs: English `error` plus an optional translatable code. */
export interface ApiErrorBody {
  error: string;
  code?: MessageKey;
  params?: MessageParams;
}

/** Letters, digits, spaces and a few separators; 1..NICKNAME_MAX characters after trimming. */
export const nicknameSchema = z
  .string()
  .transform((s) => s.normalize('NFC').replace(/\s+/g, ' ').trim())
  .pipe(
    z
      .string()
      .min(1, translate('en', 'nickname.empty'))
      .max(NICKNAME_MAX, translate('en', 'nickname.tooLong', { max: NICKNAME_MAX }))
      .regex(/^[\p{L}\p{N} _.-]+$/u, translate('en', 'nickname.chars')),
  );

const NICKNAME_ERRORS: CodedMessage[] = [
  { code: 'nickname.empty' },
  { code: 'nickname.tooLong', params: { max: NICKNAME_MAX } },
  { code: 'nickname.chars' },
];

/** Map a nickname validation message back to its code (unknown problems become "Invalid nickname."). */
export function nicknameError(message: string | undefined): CodedText {
  for (const e of NICKNAME_ERRORS) {
    const text = translate('en', e.code, e.params);
    if (text === message) return { ...e, text };
  }
  return { code: 'viewer.err.invalidNickname', text: translate('en', 'viewer.err.invalidNickname') };
}

export const joinRequestSchema = z.object({
  nickname: nicknameSchema,
});

export const deviceKindSchema = z.enum(['mobile', 'desktop']);
export type DeviceKind = z.infer<typeof deviceKindSchema>;

/** Hex-encoded 20-byte BitTorrent peer id. */
export const peerIdSchema = z.string().regex(/^[0-9a-f]{40}$/);

// ---------------------------------------------------------------------------
// Control channel (WebSocket /control)
// ---------------------------------------------------------------------------

export const clientMessageSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('stats'),
    p2pEnabled: z.boolean(),
    httpBytes: z.number().int().nonnegative().max(1e13),
    p2pDownBytes: z.number().int().nonnegative().max(1e13),
    p2pUpBytes: z.number().int().nonnegative().max(1e13),
    peers: z.number().int().nonnegative().max(1000),
    /** HTTP 429 responses seen (Cloudflare quick tunnel concurrency limit). */
    http429: z.number().int().nonnegative().max(1e9).default(0),
    device: deviceKindSchema,
  }),
  z.object({
    t: z.literal('hash-fail'),
    peerId: peerIdSchema.optional(),
    segment: z.string().max(200),
  }),
  z.object({
    t: z.literal('pong'),
  }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export type ServerMessage =
  /** `viewerCount`: people watching now, or null when the streamer hides the count. */
  | { t: 'hello'; sessionId: string; nickname: string; p2pAllowed: boolean; blockedPeers: string[]; viewerCount: number | null }
  /** Viewer count changed (sent at most every few seconds); null = hidden by the streamer. */
  | { t: 'viewers'; count: number | null }
  | { t: 'p2p'; allowed: boolean }
  | { t: 'block-peers'; peerIds: string[] }
  | { t: 'unblock-peers'; peerIds: string[] }
  | { t: 'kicked' }
  | { t: 'ended' }
  | { t: 'ping' };

// ---------------------------------------------------------------------------
// Viewer API
// ---------------------------------------------------------------------------

export interface ViewerConfig {
  sessionId: string;
  nickname: string;
  /** Base64url raw Ed25519 public key used to verify /hls/manifest.json. */
  manifestPublicKey: string;
  playlistUrl: string;
  manifestUrl: string;
  trackerUrl: string;
  controlUrl: string;
  stunServers: string[];
  swarmId: string;
  p2pAllowed: boolean;
  segmentDurationS: number;
}

/** Payload of the signed integrity manifest. */
export interface IntegrityManifest {
  /** Random id of the current live; changes on every Start. */
  liveId: string;
  /** Monotonic counter, increases on every update. */
  version: number;
  issuedAt: number;
  /** Map of segment path (as it appears in playlists, e.g. "/hls/v1_seg12.mp4") to lowercase hex SHA-256. */
  segments: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------

export const settingsSchema = z.object({
  uploadLimitMbps: z.number().min(1).max(10_000),
  autoStopMinutes: z.number().int().min(1).max(24 * 60),
  alsoStreamingElsewhere: z.boolean(),
  /** Show viewers how many people are watching (only the number). */
  showViewerCount: z.boolean().default(true),
  /** Cap on simultaneous viewer sessions (omitted = keep the current value). */
  maxViewers: z.number().int().min(1).max(100_000).optional(),
  /** Sessions one browser may hold (omitted = keep the current value). */
  maxSessionsPerDevice: z.number().int().min(1).max(20).optional(),
});
export type Settings = z.infer<typeof settingsSchema>;

/** Attack protection switches (panel "Protection" card; persisted in config.json `security`). */
export const securitySettingsSchema = z.object({
  /** Refuse IPs on free public blocklists (Spamhaus DROP, FireHOL level1). */
  blockKnownBadIps: z.boolean(),
  /** Always ask new viewers' browsers for a short proof-of-work before joining. */
  requireBrowserCheck: z.boolean(),
  /** Under attack: stricter join limits and session admission for a while. */
  autoTighten: z.boolean(),
  /** Suspicious activity / attack: turn the browser check on automatically. */
  autoBrowserCheck: z.boolean(),
  /** Under attack (Secure mode): generate a new link automatically (you must resend it). */
  autoNewLink: z.boolean(),
  /** Direct mode: go back to Secure mode (tunnel) at the first attack signs. */
  autoSecureFromDirect: z.boolean(),
  /** Direct mode: if going back to Secure mode fails, Stop everything. */
  autoStopIfDirectFails: z.boolean(),
  /** Turn everything off when an attack is detected (any mode). */
  stopOnAttack: z.boolean(),
});
export type SecuritySettings = z.infer<typeof securitySettingsSchema>;

export type ThreatState = 'normal' | 'suspicious' | 'attack';

/** Attack detection and protection status for the admin panel. */
export interface SecurityState {
  settings: SecuritySettings;
  threat: ThreatState;
  threatSince?: number;
  /** Main signal while not normal (a message key explaining it in plain words). */
  reasonCode?: MessageKey;
  /** Browser check (proof-of-work) level for new joins: 0 off, 1 light, 2 strong. */
  browserCheck: 0 | 1 | 2;
  /** Join limits are temporarily stricter. */
  tightened: boolean;
  /** Admission limits in force right now (lower than the configured ones while tightened). */
  effectiveMaxViewers: number;
  effectiveMaxSessionsPerDevice: number;
  /** Requests refused this stream because the IP is on a public blocklist. */
  blockedByLists: number;
  blocklists: { enabled: boolean; networks: number; updatedAt?: number; failedLists: number };
}

/** Response of GET /api/join/challenge (proof-of-work before joining, ALTCHA format). */
export type JoinChallengeResponse =
  | { required: false }
  | { required: true; challenge: { parameters: object; signature?: string } };

export const directEnableSchema = z.object({
  acknowledgeRisks: z.literal(true),
  /** Continue even when automatic port mapping is unavailable (manual port forward). */
  manualPortForward: z.boolean().optional(),
});

export type StepStatus = 'pending' | 'running' | 'ok' | 'error' | 'skipped';
export interface Step {
  id: string;
  /** English label. */
  label: string;
  /** Translation key of the label. */
  labelKey: MessageKey;
  status: StepStatus;
  /** English error text. */
  error?: string;
  /** Translation key/params of the error, when it is a known one. */
  errorCode?: MessageKey;
  errorParams?: MessageParams;
}

export type LivePhase = 'off' | 'starting' | 'waiting-obs' | 'live' | 'stopping';
export type AccessMode = 'secure' | 'direct';

export interface ViewerInfo {
  sessionId: string;
  nickname: string;
  device: DeviceKind;
  joinedAt: number;
  connected: boolean;
  p2pAllowed: boolean;
  p2pEnabled: boolean;
  peerIds: string[];
  p2pUpBytes: number;
  p2pDownBytes: number;
  httpBytes: number;
  hashFailures: number;
  autoRemovedFromP2P: boolean;
}

export interface SpeedTestResult {
  at: number;
  downloadMbps: number;
  uploadMbps: number;
  latencyMs: number;
  source: string;
}

export interface CapacityInfo {
  usableUploadMbps: number;
  recommendedLimitMbps: number;
  effectiveLimitMbps: number;
  directViewers: number;
  withP2PViewers: number;
  level: 'ok' | 'near' | 'over' | 'unknown';
  /** English text. */
  message: string;
  /** Translation key/params of `message`. */
  code: MessageKey;
  params?: MessageParams;
}

export interface DirectModeState {
  active: boolean;
  publicIp?: string;
  externalPort?: number;
  mapping?: 'upnp' | 'natpmp' | 'manual';
  certificate?: 'letsencrypt' | 'self-signed';
  viewersSeen: number;
  lastExposedIp?: string;
  ipChangedSinceLastDirect?: boolean | null;
  staleMappingWarning?: boolean;
  /** English text. */
  suggestion?: string;
  suggestionCode?: MessageKey;
}

/** Response of POST /api/direct/check. */
export interface DirectCheckResponse {
  ok: boolean;
  /** English text. */
  message: string;
  code: MessageKey;
  params?: MessageParams;
  needsManualForward: boolean;
  reason?: string;
}

export type ActivityLevel = 'info' | 'warn' | 'error';
/** action: something the streamer or SwarmCast did; viewer: joins/leaves; system: everything else. */
export type ActivityKind = 'action' | 'viewer' | 'system';

/** One line of the admin activity log (kept in memory only, already scrubbed of secrets/IPs). */
export interface ActivityEntry {
  /** Increasing id. */
  id: number;
  at: number;
  level: ActivityLevel;
  kind: ActivityKind;
  code?: MessageKey;
  params?: MessageParams;
  /** English text. */
  text: string;
}

/**
 * Messages on the admin WebSocket (/ws). A bare AdminState snapshot (no `type` field, as before)
 * or an activity-log message: `reset` replaces the client's list (backlog on connect, clear).
 */
export interface AdminLogMessage {
  type: 'log';
  reset: boolean;
  entries: ActivityEntry[];
}
export type AdminSocketMessage = AdminState | AdminLogMessage;

export interface AdminState {
  version: string;
  phase: LivePhase;
  mode: AccessMode;
  steps: Step[];
  /** Full live link (with secret) — only ever sent to the localhost admin panel. */
  liveLink?: string;
  linkGeneration: number;
  tunnelUrl?: string;
  tunnelUrlChangedAt?: number;
  rtmpUrl: string;
  streamKey: string;
  obsConnected: boolean;
  obsBitrateKbps: number;
  lastVideoAt?: number;
  autoStopAt?: number;
  viewers: ViewerInfo[];
  stats: {
    viewersConnected: number;
    viewersHelping: number;
    p2pSharePercent: number;
    originUploadMbps: number;
    httpInFlight: number;
    rateLimited429: number;
  };
  /** English warning texts. */
  warnings: string[];
  /** Translation key/params for each entry of `warnings` (same order and length). */
  warningCodes: CodedMessage[];
  settings: Settings;
  speedTest?: SpeedTestResult;
  speedTestRunning: boolean;
  capacity: CapacityInfo;
  direct: DirectModeState;
  bannedCount: number;
  security: SecurityState;
}
