import type { ApiErrorBody } from '@swarmcast/shared';
import type { AdminBrandingState, BrandingText, BrandSlot } from '@swarmcast/shared/branding';
import { ApiError } from '../api.js';

/**
 * "Your page" calls (docs/BRANDING.md, plan branding-0.4.0 §5.3), kept here so the shared api.ts
 * stays with the chat card. Same rules as api(): same-origin cookie, JSON bodies with the JSON
 * content type (CSRF defence), except picture uploads, which send the raw image bytes with their
 * own image type (not CORS-safelisted either, so a cross-site page cannot send them).
 */

/** The server has no branding routes (an older SwarmCast): the card shows defaults and saves nothing. */
export class NotAvailableError extends Error {}

async function call<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  if (res.status === 404 && path === '/api/branding' && (init.method ?? 'GET') === 'GET') throw new NotAvailableError('branding routes not available');
  const data = (await res.json().catch(() => ({}))) as T & Partial<ApiErrorBody>;
  if (!res.ok) {
    if (data.error) throw new ApiError(data.error, data.code, data.params);
    throw new ApiError(`Request failed (${res.status})`, 'err.requestFailed', { status: res.status });
  }
  return data;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? '{}' : JSON.stringify(body),
});

export const brandingApi = {
  load: (): Promise<AdminBrandingState> => call('/api/branding', { method: 'GET' }),
  save: (text: BrandingText): Promise<AdminBrandingState> => call('/api/branding', json('PUT', text)),
  /** One rendered variant, as raw bytes with its sniffed image type. */
  upload: (slot: BrandSlot, blob: Blob): Promise<AdminBrandingState> => call(`/api/branding/image/${slot}`, { method: 'PUT', headers: { 'Content-Type': blob.type }, body: blob }),
  /** Removes a field's picture (its master slot; the variants go with it). */
  remove: (slot: BrandSlot): Promise<AdminBrandingState> => call(`/api/branding/image/${slot}`, json('DELETE')),
  reset: (): Promise<AdminBrandingState> => call('/api/branding/reset', json('POST')),
};
