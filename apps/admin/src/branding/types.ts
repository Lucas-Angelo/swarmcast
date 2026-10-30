import { defaultBranding, type Branding, type BrandingText } from '@swarmcast/shared/branding';

/**
 * The card's editable state. The shapes are the shared schema's (`brandingTextSchema` output,
 * `@swarmcast/shared/branding`); the panel only adds a "draft" view of them while the streamer
 * types (texts kept exactly as typed until Save; the server canonicalises them).
 */

export type Draft = BrandingText;
export type SupportDraft = Draft['support'];
export type PixDraft = NonNullable<SupportDraft['pix']>;

/** The editable part of a saved config (what the Save button sends). */
export function textOf(b: Branding): Draft {
  const { images: _images, rev: _rev, ...text } = b;
  return {
    ...text,
    tags: [...text.tags],
    links: text.links.map((l) => ({ ...l })),
    support: { ...text.support, ...(text.support.pix ? { pix: { ...text.support.pix } } : {}) },
    theme: { ...text.theme },
    preview: { ...text.preview },
  };
}

export function defaultDraft(): Draft {
  return textOf(defaultBranding());
}
