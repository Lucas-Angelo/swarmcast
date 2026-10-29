/**
 * Chat core shared by the server, the viewer and the panel (docs/CHAT.md).
 * Everything exported here is safe for the viewer bundle: no `v`-flag regex literals and no
 * big tables. The confusables skeleton (server-only) lives in `@swarmcast/shared/chat/skeleton`.
 */
export * from './limits.js';
export * from './schemas.js';
export * from './protocol.js';
export * from './text.js';
export * from './nickname.js';
export { countGraphemes, graphemes, isWellFormedString, utf8Length } from './ucd.js';
export * from './tokens.js';
export * from './color.js';
export { AhoCorasick } from './ahocorasick.js';
