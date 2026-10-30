import './zod-config.js';
import { z } from 'zod';
import { NICKNAME_MAX } from './constants.js';
import { translate, type MessageKey, type MessageParams } from './i18n/index.js';
import { chatClientSchemas } from './chat/schemas.js';
import { NICKNAME_MIN, validateNickname } from './chat/nickname.js';
import type { AdminChatMessage, ChatServerMessage, ChatSnapshot } from './chat/protocol.js';

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

/**
 * Nickname rules v2 (packages/shared/src/chat/nickname.ts): letters and digits from one
 * script, spaces, "-", "_" and "."; 2..NICKNAME_MAX graphemes, at most 64 UTF-8 bytes; no
 * emoji, symbols, invisible or control characters; no stacked marks; no reserved names.
 * Failures carry the English text of their code (nicknameError maps it back).
 */
export const nicknameSchema = z.string().transform((s, ctx) => {
  const r = validateNickname(s);
  if (r.ok) return r.value;
  ctx.addIssue({ code: 'custom', message: translate('en', r.code, r.params) });
  return z.NEVER;
});

const NICKNAME_ERRORS: CodedMessage[] = [
  { code: 'nickname.empty' },
  { code: 'nickname.tooShort', params: { min: NICKNAME_MIN } },
  { code: 'nickname.tooLong', params: { max: NICKNAME_MAX } },
  { code: 'nickname.chars' },
  { code: 'nickname.marks' },
  { code: 'nickname.mixed' },
  { code: 'nickname.reserved' },
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
    /** Seconds behind live right now (adaptive delay); absent before playback. */
    delayS: z.number().nonnegative().max(600).optional(),
  }),
  z.object({
    t: z.literal('hash-fail'),
    peerId: peerIdSchema.optional(),
    segment: z.string().max(200),
  }),
  z.object({
    t: z.literal('pong'),
  }),
  // Chat (packages/shared/src/chat): its own frame budget on the server, see control.ts.
  ...chatClientSchemas,
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

/**
 * Why P2P is off for a viewer although the streamer did not turn it off:
 * - `own-connection`: the viewer is on the streamer's own internet connection, where P2P would
 *   show other viewers the IP the stream comes from;
 * - `checking`: the server is still finding out its own public address, so P2P waits.
 */
export type P2PBlockReason = 'own-connection' | 'checking';

export type ServerMessage =
  /** `viewerCount`: people watching now, or null when the streamer hides the count. */
  /** `p2pAllowed`: this viewer may use P2P now; `p2pForAll`: the streamer's switch for everyone; `p2pBlock`: see P2PBlockReason. */
  /** `chat`: the chat snapshot (absent while the chat is off). */
  | { t: 'hello'; sessionId: string; nickname: string; p2pAllowed: boolean; p2pForAll?: boolean; p2pBlock?: P2PBlockReason; blockedPeers: string[]; viewerCount: number | null; chat?: ChatSnapshot; brandRev?: number }
  /** Viewer count changed (sent at most every few seconds); null = hidden by the streamer. */
  | { t: 'viewers'; count: number | null }
  | { t: 'p2p'; allowed: boolean; forAll?: boolean; reason?: P2PBlockReason }
  | { t: 'block-peers'; peerIds: string[] }
  | { t: 'unblock-peers'; peerIds: string[] }
  | { t: 'kicked' }
  | { t: 'ended' }
  | { t: 'ping' }
  // ---- branding: control ----
  /** The streamer saved her page: refetch /api/brand (If-None-Match) and /brand/theme.css. */
  | { t: 'branding'; rev: number }
  // ---- end branding: control ----
  | ChatServerMessage;

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
  /** Why P2P is off although the streamer allows it (see P2PBlockReason). */
  p2pBlock?: P2PBlockReason;
  segmentDurationS: number;
  /**
   * Present (true) only when the server runs with SWARMCAST_TEST_HOOKS=1 (the E2E harness):
   * the watch page then honours its test-only URL flags (`?delaySpeed=`, `?delayRate=`).
   * Never set for real viewers, so a crafted link cannot change anyone's playback.
   */
  testHooks?: true;
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
  /** Viewers may share video with each other (P2P). Off = emergency switch: everyone on HTTPS. */
  allowViewerP2P: z.boolean().default(true),
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
  /** On the streamer's own internet connection: P2P stays off to keep the streamer's IP private. */
  ownConnection?: boolean;
  /** Seconds behind live, as the player last reported (null: not playing yet). */
  delayS: number | null;
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
 * Messages on the admin WebSocket (/ws). A bare AdminState snapshot (no `type` field, as before),
 * an activity-log message (`reset` replaces the client's list: backlog on connect, clear), or,
 * in desktop mode only, the desktop app's state (autostart, updates, first-run check).
 */
export interface AdminLogMessage {
  type: 'log';
  reset: boolean;
  entries: ActivityEntry[];
}
export interface AdminDesktopMessage extends DesktopInfo {
  type: 'desktop';
}
export type AdminSocketMessage = AdminState | AdminLogMessage | AdminDesktopMessage | AdminChatMessage;

// ---- desktop app (docs/DESKTOP.md) ----

export const DESKTOP_UPDATE_STATUSES = ['none', 'available', 'downloading', 'installing', 'error'] as const;
export type DesktopUpdateStatus = (typeof DESKTOP_UPDATE_STATUSES)[number];

const clipped = (max: number) => z.string().transform((v) => v.slice(0, max));

/**
 * Update status sent by the desktop shell (`{"type":"update",...}` on the server's stdin).
 * Lenient on sizes (long texts are cut, progress is clamped) so a long release note never
 * hides an available update.
 */
export const desktopUpdateSchema = z.object({
  status: z.enum(DESKTOP_UPDATE_STATUSES),
  /** Installed version. */
  current: clipped(64).optional(),
  /** Version offered (available / downloading / installing). */
  version: clipped(64).optional(),
  /** Release notes (plain text or Markdown, shown as text). */
  notes: clipped(20_000).optional(),
  /** Download progress, 0..1. */
  progress: z
    .number()
    .transform((n) => Math.min(1, Math.max(0, n)))
    .optional(),
  error: clipped(2000).optional(),
});
export type DesktopUpdate = z.output<typeof desktopUpdateSchema>;

/** PUT /api/desktop/autostart */
export const desktopAutostartSchema = z.object({ enabled: z.boolean() });

/**
 * Update channels of the desktop app (docs/DESKTOP.md, "Updates"): `stable` gets only stable
 * versions; `beta` ("Get beta versions") also gets pre-releases (X.Y.Z-beta.N, X.Y.Z-rc.N), always
 * the higher of the two feeds. Never a downgrade.
 */
export const UPDATE_CHANNELS = ['stable', 'beta'] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

/** PUT /api/desktop/update/channel */
export const desktopUpdateChannelSchema = z.object({ channel: z.enum(UPDATE_CHANNELS) });

/** A SemVer pre-release (0.3.0-beta.1): it has a hyphen before any build metadata. */
export function isPrereleaseVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+-/.test(version.trim().split('+')[0] ?? '');
}

/**
 * The channel in use (same rule as the shell's updater.rs `resolve`): the streamer's choice,
 * otherwise beta when the installed version is a pre-release, otherwise stable.
 */
export function effectiveUpdateChannel(choice: UpdateChannel | null | undefined, version: string): UpdateChannel {
  return choice ?? (isPrereleaseVersion(version) ? 'beta' : 'stable');
}

export interface DesktopUpdateChannelState {
  /** What the streamer chose in the panel; null = automatic. */
  choice: UpdateChannel | null;
  /** The channel in use. */
  effective: UpdateChannel;
}

/** First-run system check of the desktop app: idle (not needed or not started), running, done, failed. */
export type DesktopSystemCheckRun = 'idle' | 'running' | 'done' | 'failed';

export interface DesktopAutostartState {
  /** Only when the shell told the server where the app is (SWARMCAST_DESKTOP_EXE). */
  supported: boolean;
  /** An entry exists in the OS (read back on every request). */
  enabled: boolean;
  /** The entry starts another copy of the app (moved or reinstalled); rewritten on enable. */
  stale?: boolean;
  /** Why the entry could not be read (English). */
  error?: string;
}

/** GET /api/desktop in desktop mode. */
export interface DesktopInfo {
  desktop: true;
  /** Version of the desktop app (shell). */
  version: string;
  /** Version of the server inside it. */
  serverVersion: string;
  autostart: DesktopAutostartState;
  /** Last update status from the shell; null until it sends one. */
  update: DesktopUpdate | null;
  /** "Check for updates" was asked and the shell has not answered yet. */
  updateChecking: boolean;
  /** Stable or beta versions ("Get beta versions"). Missing from servers before 0.3.0. */
  updateChannel?: DesktopUpdateChannelState;
  systemCheck: DesktopSystemCheckRun;
}

/** GET /api/desktop: `{ desktop: false }` when SwarmCast was started by a start script. */
export type DesktopInfoResponse = DesktopInfo | { desktop: false };

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
    /** Open WebSockets + HTTP requests in progress (recent peak): what a quick tunnel limits to 200. */
    tunnelInFlight: number;
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
