import type { ApiErrorBody } from '@swarmcast/shared';
import { ApiError } from '../api.js';
import type { SlotId } from './image.js';
import type { BrandingResponse, BrandingText } from './types.js';

/**
 * "Your page" calls (plan branding-0.4.0 §5.3), kept here so the shared api.ts stays with the
 * chat card. Same rules as api(): same-origin cookie, JSON bodies with the JSON content type
 * (CSRF defence), except picture uploads, which send the raw image bytes with their own image
 * type (not CORS-safelisted either, so a cross-site page cannot send them).
 */

/** The server has no branding routes yet (BR2 not merged): the card shows defaults. */
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
  load: (): Promise<BrandingResponse> => call('/api/branding', { method: 'GET' }),
  save: (text: BrandingText): Promise<BrandingResponse> => call('/api/branding', json('PUT', text)),
  /** One rendered variant, as raw bytes with its sniffed image type. */
  upload: (slot: SlotId, blob: Blob): Promise<BrandingResponse> =>
    call(`/api/branding/image/${slot}`, { method: 'PUT', headers: { 'Content-Type': blob.type }, body: blob }),
  /** Removes the picture of a field (the master slot; its variants go with it). */
  remove: (slot: SlotId): Promise<BrandingResponse> => call(`/api/branding/image/${slot}`, json('DELETE')),
  reset: (): Promise<BrandingResponse> => call('/api/branding/reset', json('POST')),
};
