import './zod-config.js';
import { z } from 'zod';

// ---- diagnostics: log retention and "Export logs" (admin panel only) ----

export const LOG_RETENTION_RANGE = { min: 3, max: 90, default: 14 } as const;

/** GET/PUT /api/diagnostics */
export const diagnosticsSettingsSchema = z.object({
  logRetentionDays: z.number().int().min(LOG_RETENTION_RANGE.min).max(LOG_RETENTION_RANGE.max),
});
export type DiagnosticsSettings = z.infer<typeof diagnosticsSettingsSchema>;

/** POST /api/diagnostics/export */
export const logExportRequestSchema = z
  .object({
    /** Keep viewers' IP addresses as they are (only when the developer asks). Off by default. */
    includeFullIps: z.boolean().default(false),
  })
  .strict();
export type LogExportRequest = z.input<typeof logExportRequestSchema>;

export interface LogExportResult {
  /** Absolute path of the ZIP that was written. */
  path: string;
  /** File name only. */
  name: string;
  /** Folder that holds it. */
  folder: string;
  bytes: number;
  /** True when the Downloads folder could not be used and the ZIP went to `<data>/exports`. */
  fallback: boolean;
}
