import type { HtmlTagDescriptor, IndexHtmlTransformContext, Plugin } from 'vite';

export const STARTUP_GUARD: string;
export const STARTUP_GUARD_PAGES: readonly string[];
export function startupGuard(): Plugin & {
  transformIndexHtml(html: string, ctx: Pick<IndexHtmlTransformContext, 'path'>): HtmlTagDescriptor[] | undefined;
};
