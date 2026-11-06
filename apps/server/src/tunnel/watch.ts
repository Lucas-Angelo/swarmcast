/**
 * Watches the live's public address while a quick tunnel carries it (docs/ARCHITECTURE.md, "Tunnel
 * drop"). cloudflared can stay up, with no error in its output, while Cloudflare's edge answers the
 * address with its own error page (HTTP 530, "error 1033": no connection for that tunnel), so the
 * process exiting is not the only way the link stops working. The watch asks /healthz through
 * Cloudflare now and then; when Cloudflare itself keeps answering without our marker, the link is
 * dead for every viewer and the live replaces the tunnel (new address, the streamer is told).
 *
 * Only an answer from Cloudflare without our marker counts. No answer at all is this computer's own
 * connection (offline, Wi-Fi gone): cloudflared reconnects by itself then, and a new tunnel would
 * only change the link for nothing.
 *
 * No imports and no TypeScript-only syntax, on purpose: the system test harnesses
 * (scripts/test/preflight) load it with Node's type stripping to wait exactly as long as the watch
 * may take.
 */

/** What one check of the public address saw. */
export type PublicCheck =
  /** Our server answered, with this live's marker. */
  | 'ok'
  /** Cloudflare answered without our marker (530 and other edge errors): the tunnel does not reach us. */
  | 'edge-error'
  /** Nothing answered (timeout, DNS, connection refused): this computer's connection, not the tunnel. */
  | 'no-answer';

/** Between checks while the address answers. 2 per minute: /healthz allows 60 a minute. */
export const WATCH_EVERY_MS = 30_000;
/** Between checks after Cloudflare answered with an error. */
export const WATCH_RECHECK_MS = 5_000;
/**
 * Edge errors in a row, WATCH_RECHECK_MS apart, before the tunnel is replaced: about 10 s of a link
 * that answers every viewer with Cloudflare's error page. One error alone can be a hiccup of one
 * edge server; three in a row, each on a new connection, are a dead link.
 */
export const WATCH_ERRORS_BEFORE_REPLACE = 3;
/** The longest a dead address goes unnoticed: one full pause, then the errors in a row. */
export const WATCH_REPLACE_WITHIN_MS = WATCH_EVERY_MS + WATCH_ERRORS_BEFORE_REPLACE * WATCH_RECHECK_MS;

export interface TunnelWatchOptions {
  check: () => Promise<PublicCheck>;
  /** Called once when the address keeps failing; the watch is stopped by then. */
  onLost: () => void;
  everyMs?: number;
  recheckMs?: number;
  errorsBeforeReplace?: number;
}

/** Checks the public address on a timer (start/stop); calls onLost after enough edge errors in a row. */
export class TunnelWatch {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private errors = 0;
  /** Bumped by start/stop: a check that was in flight across them is ignored. */
  private generation = 0;
  private readonly opts: TunnelWatchOptions;

  constructor(opts: TunnelWatchOptions) {
    this.opts = opts;
  }

  get active(): boolean {
    return this.running;
  }

  start(): void {
    this.stop();
    this.running = true;
    this.schedule(this.opts.everyMs ?? WATCH_EVERY_MS);
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    this.errors = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    const gen = this.generation;
    this.timer = setTimeout(() => void this.tick(gen), ms);
    this.timer.unref?.();
  }

  private async tick(gen: number): Promise<void> {
    const seen = await this.opts.check().catch((): PublicCheck => 'no-answer');
    if (gen !== this.generation) return;
    if (seen === 'ok') this.errors = 0;
    else if (seen === 'edge-error') this.errors += 1;
    if (this.errors >= (this.opts.errorsBeforeReplace ?? WATCH_ERRORS_BEFORE_REPLACE)) {
      this.stop();
      this.opts.onLost();
      return;
    }
    this.schedule(this.errors > 0 ? (this.opts.recheckMs ?? WATCH_RECHECK_MS) : (this.opts.everyMs ?? WATCH_EVERY_MS));
  }
}
