// The one place the viewer chat takes the shared chat core from (@swarmcast/shared/chat, C1):
// protocol types, limits, checkChatInvariants, tokenizeChat and the colour helpers. css.ts only
// reads colours back from the page.
export * from '@swarmcast/shared/chat';
export * from './css.js';
