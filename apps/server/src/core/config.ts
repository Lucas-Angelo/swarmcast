import fs from 'node:fs';
import { z } from 'zod';
import { DEFAULT_PORTS, DEFAULT_STUN, defaultQualitySettings, qualitySettingsSchema } from '@swarmcast/shared';
import { writePrivateFile } from './paths.js';

export const tunnelProviderSchema = z.enum(['cloudflare-quick', 'none', 'external']);
export type TunnelProviderName = z.infer<typeof tunnelProviderSchema>;

export const configSchema = z.object({
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
  maxViewers: z.number().int().min(1).max(100_000).default(500),
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
      requireBrowserCheck: z.boolean().default(false),
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
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid config file ${file}: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
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
