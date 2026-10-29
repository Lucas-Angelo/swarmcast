// The one place the viewer chat takes the shared chat core from.
// Protocol types and limits come from lane A's packages/shared/src/chat (C1 part 1).
// TEMPORARY: text.ts (checkChatInvariants, countGraphemes), color.ts (contrastRatio,
// adjustNameColor, defaultNameColor) and tokens.ts (tokenizeChat) are local copies written to the
// plan, under the names C1 part 2 will export; when it lands they are re-exported from
// @swarmcast/shared/chat instead and deleted. Nothing else in apps/viewer/src/chat changes.
export * from '@swarmcast/shared/chat';
export * from './text.js';
export * from './color.js';
export * from './tokens.js';
