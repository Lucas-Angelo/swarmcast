import './zod-config.js';
import { z } from 'zod';

const value = z.union([z.string().max(200), z.number(), z.boolean(), z.null()]).optional();

/**
 * Result of the start script's system check, written to `<data>/system-check.json` (English values).
 * The desktop app writes the same file on its first start (apps/server/src/desktop/system-check.ts),
 * plus `appVersion` and `source` so it can run again after an update. The server serves it to the
 * panel's setup tutorial (GET /api/system-check). Unknown result ids are kept (the panel shows them
 * with their raw id); unknown fields are dropped.
 */
export const systemCheckSchema = z.object({
  version: z.literal(1),
  at: z.union([z.string().max(64), z.number()]),
  os: z.string().max(100),
  arch: z.string().max(40),
  results: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        status: z.enum(['ok', 'warn', 'fail', 'skipped']),
        value,
        min: value,
        recommended: value,
        detail: z.string().max(500).optional(),
      }),
    )
    .max(50),
  uploadMbps: z.number().nullable().optional(),
  downloadMbps: z.number().nullable().optional(),
  viewerEstimate: z.number().nullable().optional(),
  belowMinimum: z.array(z.string().max(40)).max(50).default([]),
  /** Version of SwarmCast that ran the check (desktop app only; the start scripts do not write it). */
  appVersion: z.string().max(64).optional(),
  /** Who ran the check; missing means a start script. */
  source: z.enum(['script', 'desktop']).optional(),
});

export type SystemCheck = z.infer<typeof systemCheckSchema>;

export type SystemCheckResult = SystemCheck['results'][number];

/** Parse the file's text; null when it is not a valid system check. */
export function parseSystemCheck(text: string): SystemCheck | null {
  try {
    const r = systemCheckSchema.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
