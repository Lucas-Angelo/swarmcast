import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../core/logger.js';
import { CodedError } from '../core/messages.js';
import { sleep } from '../core/retry.js';
import { ManagedChild, type Reaper } from '../process/children.js';
import { parseQuickTunnelUrl } from './parse.js';
import { TunnelProvider } from './provider.js';
import { START_RETRY_DELAYS_MS, classifyStartFailure, isErrorLine, retryDelayMs, type StartFailure } from './start-failure.js';

/** How long one cloudflared run may take to print its address. */
const ATTEMPT_TIMEOUT_MS = 45_000;
/** cloudflared output lines kept to explain a failed start: the first ones ("Incorrect Usage…") and the last ones (its exit message). */
const KEPT_FIRST_LINES = 5;
const KEPT_LAST_LINES = 20;

/** A cloudflared run that ended before printing its address: why (its own words) and its exit code. */
export class StartAttemptError extends Error {
  constructor(
    readonly failure: StartFailure,
    readonly exitCode: number | null,
  ) {
    super(failure.reason ?? `cloudflared exited during startup (code ${exitCode}).`);
  }
}

export interface QuickTunnelOptions {
  /** Starts cloudflared with `args` (default: the binary as a ManagedChild; tests pass a fake). */
  launch?: (args: string[]) => ManagedChild;
  /** Extra cloudflared arguments (tests: `--quick-service` pointing at a local fake service). */
  extraArgs?: string[];
  /** Waits between attempts; rejects when `signal` aborts (default: core/retry sleep). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Jitter source (default Math.random). */
  random?: () => number;
}

/**
 * Cloudflare quick tunnel (`cloudflared tunnel --url ...`): no account, no domain,
 * random https://<words>.trycloudflare.com address. Runs only while the live is on and
 * is never installed as a service.
 *
 * Starting asks Cloudflare's free quick-tunnel service for a new tunnel, which can refuse
 * (429, many new tunnels from one network) or fail (5xx, timeout) for a while: start() then
 * tries again a few times with growing delays (START_RETRY_DELAYS_MS, plus jitter), emitting
 * `retry` before each wait, and fails with Cloudflare's own words if it keeps refusing. Any
 * other failure (a broken binary, a bad flag) fails at once with cloudflared's message.
 */
export class QuickTunnel extends TunnelProvider {
  readonly name = 'cloudflare-quick';
  private child: ManagedChild | null = null;
  private current: string | null = null;
  private wanted = false;
  private localPort = 0;
  private restarts = 0;
  private abort = new AbortController();

  constructor(
    private readonly binary: string,
    private readonly runDir: string,
    private readonly reaper: Reaper | null,
    private readonly log: Logger,
    private readonly opts: QuickTunnelOptions = {},
  ) {
    super();
  }

  get url(): string | null {
    return this.current;
  }

  override get pid(): number | undefined {
    return this.child?.pid;
  }

  async start(localPort: number): Promise<string> {
    if (!fs.existsSync(this.binary)) {
      throw new Error(`cloudflared was not found at ${this.binary}. Run the start script again to repair the installation.`);
    }
    this.wanted = true;
    this.localPort = localPort;
    this.restarts = 0;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const attempts = START_RETRY_DELAYS_MS.length + 1;
    for (let attempt = 1; ; attempt++) {
      let failure: StartFailure;
      let code: number | null;
      try {
        return await this.spawn();
      } catch (err) {
        if (!(err instanceof StartAttemptError)) throw err;
        ({ failure, exitCode: code } = err);
      }
      const reason = failure.reason ?? '';
      if (!failure.transient) {
        this.log.warn({ panel: true, err: reason, code }, 'cloudflared could not start the quick tunnel');
        throw failure.reason ? new CodedError('err.tunnelFailed', { reason }) : new CodedError('err.tunnelExited', { code: String(code) });
      }
      const causeKey = `tunnel.cause.${failure.transient}` as const;
      if (attempt >= attempts || !this.wanted) {
        this.log.warn({ panel: true, err: reason, attempt }, 'cloudflare kept refusing the quick tunnel, giving up');
        throw new CodedError('err.tunnelBusy', { causeKey, attempts, reason });
      }
      const delay = retryDelayMs(attempt, failure, this.opts.random ?? Math.random);
      // `panel: true`: the live adds it to the activity log, translated (step.tunnel.retry).
      this.log.warn({ panel: true, err: reason, attempt, delay }, 'cloudflare refused or failed the quick tunnel, trying again');
      this.emit('retry', { cause: failure.transient, reason, delayMs: delay, attempt: attempt + 1, attempts });
      await (this.opts.sleep ?? sleep)(delay, signal);
      if (!this.wanted) throw new CodedError('err.tunnelBusy', { causeKey, attempts, reason });
    }
  }

  private spawn(): Promise<string> {
    // An app-owned (empty) config file stops a user's ~/.cloudflared/config.yml
    // (e.g. from another project) from overriding --url.
    fs.mkdirSync(this.runDir, { recursive: true, mode: 0o700 });
    const cfg = path.join(this.runDir, 'cloudflared.yml');
    fs.writeFileSync(cfg, '# Generated by SwarmCast: keeps ~/.cloudflared/config.yml from overriding --url\nno-autoupdate: true\n', { mode: 0o600 });
    const args = [
      'tunnel',
      '--no-autoupdate',
      '--config',
      cfg,
      '--url',
      `http://127.0.0.1:${this.localPort}`,
      ...(this.opts.extraArgs ?? []),
      // Do not let a TUNNEL_* environment from elsewhere change behavior.
    ];
    const child = this.opts.launch?.(args) ?? new ManagedChild('cloudflared', this.binary, args, { cwd: this.runDir, env: cleanEnv() }, this.reaper, this.log);
    this.child = child;
    const first: string[] = [];
    const last: string[] = [];
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('The tunnel did not start within 45 seconds. Check your internet connection or firewall (cloudflared needs outbound UDP/TCP port 7844 or 443).'));
        }
      }, ATTEMPT_TIMEOUT_MS);
      child.on('line', (line) => {
        const url = parseQuickTunnelUrl(line);
        if (url) {
          if (url === this.current) return; // error lines repeat the same URL
          const changed = this.current !== null;
          this.current = url;
          this.log.info({ url }, 'quick tunnel URL received');
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(url);
          } else if (changed) {
            this.emit('url', url);
          }
          return;
        }
        const kept = line.slice(0, 300);
        if (first.length < KEPT_FIRST_LINES) first.push(kept);
        else {
          last.push(kept);
          if (last.length > KEPT_LAST_LINES) last.shift();
        }
        // Its fatal error is a bare line (no timestamp, no level): as important as an ERR line.
        if (isErrorLine(line)) this.log.warn({ cloudflared: kept }, 'cloudflared');
        else this.log.debug({ cloudflared: kept }, 'cloudflared');
      });
      child.once('exit', (code) => {
        // Its last lines (the reason) can arrive after 'exit': decide once the output ended.
        void child.waitForOutputEnd().then(() => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new StartAttemptError(classifyStartFailure([...first, ...last]), code));
            return;
          }
          if (this.wanted && this.child === child) void this.recover(code);
        });
      });
    });
  }

  /** The connector died during the live: restart it. The address will usually change. */
  private async recover(code: number | null): Promise<void> {
    this.emit('down', `cloudflared exited (code ${code})`);
    this.current = null;
    while (this.wanted && this.restarts < 20) {
      this.restarts += 1;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.restarts, 5));
      this.log.warn({ attempt: this.restarts, delay }, 'restarting tunnel');
      await new Promise((r) => setTimeout(r, delay));
      if (!this.wanted) return;
      try {
        const url = await this.spawn();
        this.emit('url', url);
        return;
      } catch (err) {
        this.log.warn({ err: (err as Error).message }, 'tunnel restart failed');
      }
    }
  }

  async stop(): Promise<void> {
    this.wanted = false;
    this.abort.abort();
    await this.child?.stop();
    this.child = null;
    this.current = null;
  }
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('TUNNEL_') && k !== 'NO_AUTOUPDATE') env[k] = v;
  }
  return env;
}
