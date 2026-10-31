import type { Page } from 'playwright';

/** Waits until a quick tunnel's brand-new name is known to Cloudflare's resolvers, then looks it up once on this machine. Other hosts return at once. */
export function waitForTunnelName(
  url: string,
  log?: (line: string) => void,
  dns?: { resolve4?: (host: string) => Promise<string[]>; lookup?: (host: string) => Promise<unknown> },
): Promise<void>;
/** Opens a live link once its name resolves, until the response commits. */
export function openLink(page: Page, url: string, log?: (line: string) => void): Promise<void>;
/** Opens the join link, picks a nickname and clicks Watch. */
export function joinIn(page: Page, link: string, nickname: string, log?: (line: string) => void): Promise<void>;
/** Resolves once the video plays past `minTime` seconds. */
export function waitPlaying(page: Page, timeoutMs?: number, minTime?: number): Promise<void>;
export function playerStats(page: Page): Promise<unknown>;
export function playlistSeconds(page: Page): Promise<number>;
export const LATE_JOINER_WINDOW_S: number;
export function waitPlaylistForLateJoiners(page: Page, timeoutMs?: number): Promise<void>;
export function renderedTwice(page: Page): Promise<void>;
export function pageState(page: Page): Promise<unknown>;
export function probeHealth(base: string): Promise<unknown>;
