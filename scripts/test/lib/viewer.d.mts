import type { Page, Response } from 'playwright';

/** Waits until a quick tunnel's brand-new name is known to Cloudflare's resolvers, then looks it up once on this machine. Other hosts return at once. */
export function waitForTunnelName(
  url: string,
  log?: (line: string) => void,
  dns?: { resolve4?: (host: string) => Promise<string[]>; lookup?: (host: string) => Promise<unknown> },
): Promise<void>;
/** Quick tunnels go to a local stand-in (cloudflare.mjs) from now on, or to the real Cloudflare with null. */
export function setLocalCloudflare(cf: { healthz: (base: string) => Promise<string | null> } | null): void;
/** Opens a live link once its name resolves, until the response commits; returns the response. */
export function openLink(page: Page, url: string, log?: (line: string) => void): Promise<Response | null>;
/** HTTP status of Cloudflare's own error page for a tunnel address it has no connection for. */
export const CLOUDFLARE_NO_TUNNEL: number;
/** Opens the join link, picks a nickname and clicks Watch. */
export function joinIn(page: Page, link: string, nickname: string, log?: (line: string) => void): Promise<void>;
/** joinIn once the link is open in the page. */
export function joinOpened(page: Page, nickname: string): Promise<void>;
/** Resolves once the video plays past `minTime` seconds. */
export function waitPlaying(page: Page, timeoutMs?: number, minTime?: number): Promise<void>;
export function playerStats(page: Page): Promise<unknown>;
export function playlistSeconds(page: Page): Promise<number>;
export const LATE_JOINER_WINDOW_S: number;
export function waitPlaylistForLateJoiners(page: Page, timeoutMs?: number): Promise<void>;
export function renderedTwice(page: Page): Promise<void>;
export function pageState(page: Page): Promise<unknown>;
export function probeHealth(base: string): Promise<unknown>;
