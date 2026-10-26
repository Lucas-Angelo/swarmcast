import fs from 'node:fs';
import { z } from 'zod';
import { DEFAULT_PORTS, DEFAULT_STUN, QUICK_TUNNEL_MAX_VIEWERS, defaultQualitySettings, qualitySettingsSchema } from '@swarmcast/shared';
import { writePrivateFile } from './paths.js';

export const tunnelProviderSchema = z.enum(['cloudflare-quick', 'none', 'external']);
export type TunnelProviderName = z.infer<typeof tunnelProviderSchema>;

/**
 * Version of the config.json format. Missing in files written by v0.1.0 (= version 1).
 * 2: the browser check is on by default. v0.1.0 saved its old default (`false`) in every file,
 *    so a `false` from version 1 is switched on once; a `false` saved at version 2 or later is
 *    the streamer's choice and stays.
 * 3: `maxViewers` defaults to QUICK_TUNNEL_MAX_VIEWERS (120) instead of 500, the audience a
 *    free quick tunnel really holds (docs/ARCHITECTURE.md). A 500 saved before version 3 is the
 *    old default and becomes 120 once; other values are the streamer's choice and stay.
 */
export const CONFIG_VERSION = 3;

/** `maxViewers` default before config version 3. */
const OLD_DEFAULT_MAX_VIEWERS = 500;

export const configSchema = z.object({
  configVersion: z.number().int().min(1).default(CONFIG_VERSION),
  ports: z
    .object({
      rtmp: z.number().int().min(1).max(65535).default(DEFAULT_PORTS.rtmp),
      public: z.number().int().min(1).max(65535).default(DEFAULT_PORTS.public),
      admin: z.number().int().min(1).max(65535).default(DEFAULT_PORTS.admin),
      mediamtxHls: z.number().int().min(1).max(65535).default(DEFAULT_PORTS.mediamtxHls),
    })
    .default({ ...DEFAULT_PORTS }),
  uploadLimitMbps: z.number().min(1).max(10_000).default(100),
  // Fractions are accepted for tests; the panel only offers whole minutes.
  autoStopMinutes: z.number().min(0.05).max(1440).default(10),
  alsoStreamingElsewhere: z.boolean().default(true),
  /** Viewers see how many people are watching (only the number, never names). */
  showViewerCount: z.boolean().default(true),
  /** Hard cap on simultaneous viewer sessions; new joins get "full" beyond it (app-level DoS guard). */
  maxViewers: z.number().int().min(1).max(100_000).default(QUICK_TUNNEL_MAX_VIEWERS),
  /** Sessions one browser (device cookie) may hold; the oldest is replaced beyond it. */
  maxSessionsPerDevice: z.number().int().min(1).max(20).default(3),
  tunnel: z
    .object({
      provider: tunnelProviderSchema.default('cloudflare-quick'),
      /** Base URL for the "external" provider (a reverse proxy/named tunnel you run yourself). */
      externalUrl: z.url().optional(),
    })
    .default({ provider: 'cloudflare-quick' }),
  stunServers: z.array(z.string().regex(/^stuns?:/)).min(1).default([DEFAULT_STUN]),
  /** Read the client IP from CF-Connecting-IP when the request comes from the local tunnel connector. */
  trustTunnelProxy: z.boolean().default(true),
  /** Attack detection reactions and public blocklists (see docs/SECURITY_RESEARCH.md). */
  security: z
    .object({
      blockKnownBadIps: z.boolean().default(true),
      requireBrowserCheck: z.boolean().default(true),
      autoTighten: z.boolean().default(true),
      autoBrowserCheck: z.boolean().default(true),
      autoNewLink: z.boolean().default(false),
      autoSecureFromDirect: z.boolean().default(true),
      autoStopIfDirectFails: z.boolean().default(true),
      stopOnAttack: z.boolean().default(false),
      /** Built-in lists to download (config only). "feodo" is optional (already in FireHOL level1). */
      blocklists: z.array(z.enum(['spamhaus-drop', 'spamhaus-drop-v6', 'firehol-level1', 'feodo'])).default(['spamhaus-drop', 'spamhaus-drop-v6', 'firehol-level1']),
      /** Extra list URLs (https, one CIDR/IP per line), e.g. blocklist.de or Tor exits. Config only; not recommended. */
      extraBlocklistUrls: z.array(z.url({ protocol: /^https$/ })).max(10).default([]),
    })
    .prefault({}),
  speedTest: z
    .object({
      enabled: z.boolean().default(true),
      intervalMinutes: z.number().int().min(5).default(15),
    })
    .default({ enabled: true, intervalMinutes: 15 }),
  /** Quality ladder, upload budget and obs-websocket settings (docs/QUALITY.md). */
  quality: qualitySettingsSchema.default(defaultQualitySettings()),
  /**
   * ffmpeg used for the quality ladder. Default (when unset): bin/ffmpeg next to MediaMTX if a
   * packager bundled it, else `<data>/tools/ffmpeg/ffmpeg[.exe]` (installed by the start
   * scripts or the panel). The SWARMCAST_FFMPEG environment variable overrides both. In a
   * source checkout, "ffmpeg" uses the one on PATH.
   */
  ffmpegPath: z.string().min(1).optional(),
  /** The admin panel's first-run setup tutorial was finished or skipped (it opens until then). */
  onboardingDone: z.boolean().default(false),
  /** Log files and old log exports are deleted after this many days (panel: Diagnostics). */
  diagnostics: z
    .object({ logRetentionDays: z.number().int().min(3).max(90).default(14) })
    .prefault({}),
});

export type AppConfig = z.infer<typeof configSchema>;

export function defaultConfig(): AppConfig {
  return configSchema.parse({});
}

export function loadConfig(file: string): AppConfig {
  if (!fs.existsSync(file)) {
    const cfg = defaultConfig();
    saveConfig(file, cfg);
    return cfg;
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  const { config: migrated, changed } = migrateConfig(raw);
  const parsed = configSchema.safeParse(migrated);
  if (!parsed.success) {
    throw new Error(`Invalid config file ${file}: ${z.prettifyError(parsed.error)}`);
  }
  // Write the migration back once, so the streamer's later choices are read as such.
  if (changed) saveConfig(file, parsed.data);
  return parsed.data;
}

/** Bring a config.json written by an older version up to CONFIG_VERSION (pure; unknown shapes pass through). */
export function migrateConfig(raw: unknown): { config: unknown; changed: boolean } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { config: raw, changed: false };
  const cfg = { ...(raw as Record<string, unknown>) };
  const version = typeof cfg.configVersion === 'number' ? cfg.configVersion : 1;
  if (version >= CONFIG_VERSION) return { config: cfg, changed: false };
  if (version < 2) {
    const sec = cfg.security;
    if (sec && typeof sec === 'object' && !Array.isArray(sec) && (sec as Record<string, unknown>).requireBrowserCheck === false) {
      cfg.security = { ...(sec as Record<string, unknown>), requireBrowserCheck: true };
    }
  }
  if (version < 3 && cfg.maxViewers === OLD_DEFAULT_MAX_VIEWERS) cfg.maxViewers = QUICK_TUNNEL_MAX_VIEWERS;
  cfg.configVersion = CONFIG_VERSION;
  return { config: cfg, changed: true };
}

/**
 * What the running app may write back to config.json: values chosen for this run only keep
 * what the file says (fallback ports when the usual ones are busy, and the tunnel turned off
 * by --no-tunnel), so a later normal start is not affected by them.
 */
export function persistableConfig(runtime: AppConfig, onDisk: AppConfig, run: { noTunnel?: boolean } = {}): AppConfig {
  return { ...runtime, ports: onDisk.ports, ...(run.noTunnel ? { tunnel: onDisk.tunnel } : {}) };
}

export function saveConfig(file: string, cfg: AppConfig): void {
  writePrivateFile(file, JSON.stringify(cfg, null, 2) + '\n');
}
