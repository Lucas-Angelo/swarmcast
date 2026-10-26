import type { CodedText } from '@swarmcast/shared';
import { translate, type MessageKey, type MessageParams } from '@swarmcast/shared/i18n';

/** A text with a stable code (for client-side translation) and its English version. */
export function coded(code: MessageKey, params?: MessageParams): CodedText {
  return { code, ...(params ? { params } : {}), text: translate('en', code, params) };
}

/** An Error whose (English) message comes from the shared dictionary, so clients can translate it. */
export class CodedError extends Error {
  constructor(
    readonly code: MessageKey,
    readonly params?: MessageParams,
  ) {
    super(translate('en', code, params));
  }
}

/** `{ code, params }` of an error when it is a CodedError, otherwise nothing. */
export function codeOf(err: unknown): { code?: MessageKey; params?: MessageParams } {
  return err instanceof CodedError ? { code: err.code, ...(err.params ? { params: err.params } : {}) } : {};
}
