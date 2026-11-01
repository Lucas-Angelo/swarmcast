import { describe, expect, it, onTestFinished } from 'vitest';
import { CodedError } from '../../src/core/messages.js';
import { sleep } from '../../src/core/retry.js';
import { ManagedChild } from '../../src/process/children.js';
import { TunnelProvider, type TunnelRetry } from '../../src/tunnel/provider.js';
import { QuickTunnel } from '../../src/tunnel/quick.js';
import { START_RETRY_DELAYS_MS, classifyStartFailure, isErrorLine } from '../../src/tunnel/start-failure.js';
import { captureLog, silentLog, tempDir } from './helpers.js';
import { makeController } from './live-helpers.js';

// Starting a quick tunnel asks Cloudflare's free service for a new tunnel. It can refuse (429,
// many new tunnels from one network) or fail (5xx, timeout) for a while: SwarmCast then tries
// again a few times with growing delays and shows it, and fails with Cloudflare's own words if
// it keeps refusing. Any other failure fails at once with cloudflared's message. cloudflared's
// error is a bare line on stderr (no timestamp, no level) followed by exit code 1; the lines
// below are what cloudflared 2026.10.x prints against a fake quick-tunnel service
// (apps/server/test/integration/quick-tunnel.test.ts runs the real binary).
//
// The fake cloudflared is a real child process (Node), one per attempt, scripted with the lines it
// prints and its exit code, or with the address banner (then it runs until stopped). The waits
// between attempts go through a recording sleep that returns at once; jitter is fixed at 0.

const BANNER = '2026-11-01T02:58:54Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment and try it out.';
const REQUESTING = '2026-11-01T02:58:54Z INF Requesting new quick Tunnel on trycloudflare.com...';
const S429 = 'quick tunnel provisioning failed with status 429';
const S429_JSON = 'quick tunnel provisioning failed with status 429: [1015] You are being rate limited';
const S503 = 'quick tunnel provisioning failed with status 503';
const URL_ = 'https://quiet-river-mango-tree.trycloudflare.com';

/** `noise`: that many debug lines first (made by the fake: an environment variable holds at most 128 KiB on Linux). */
type Attempt = { lines: string[]; exit: number; noise?: number } | { url: string };

/** Prints its attempt's lines on stderr, then exits with its code, or prints the address and stays up. */
const FAKE_CLOUDFLARED = [
  'const a = JSON.parse(process.env.SC_FAKE_CLOUDFLARED);',
  "for (let i = 0; i < (a.noise ?? 0); i++) process.stderr.write('2026-11-01T02:58:54Z DBG line ' + i + ' ' + 'x'.repeat(80) + '\\n');",
  "for (const l of a.lines ?? []) process.stderr.write(l + '\\n');",
  "if (a.url) { process.stderr.write('2026-11-01T02:58:55Z INF |  ' + a.url + '  |\\n'); setInterval(() => {}, 1000); }",
  'else process.exitCode = a.exit;',
].join('\n');

/** A bad flag: "Incorrect Usage…", then the help text. */
const HELP = (usage: string): string[] => [usage, '', 'NAME:', '   cloudflared tunnel - Use Cloudflare Tunnel to expose private services to the Internet or to Cloudflare connected private users.', '', 'OPTIONS:', '   --loglevel value  Application logging level {debug, info, warn, error, fatal}.', '   --help, -h  show help (default: false)'];

const failed = (...lines: string[]): Attempt => ({ lines: [BANNER, REQUESTING, ...lines], exit: 1 });

/** A QuickTunnel whose cloudflared runs `attempts` in turn; records the launches, the waits and the retry events. */
function tunnelWith(attempts: Attempt[], opts: { sleep?: (ms: number, signal: AbortSignal) => Promise<void>; log?: typeof silentLog } = {}) {
  const launches: string[][] = [];
  const waits: number[] = [];
  const retries: TunnelRetry[] = [];
  const tunnel = new QuickTunnel(process.execPath, tempDir('sc-quick-'), null, opts.log ?? silentLog, {
    launch: (args) => {
      const attempt = attempts[launches.length];
      launches.push(args);
      if (!attempt) throw new Error('unexpected launch');
      return new ManagedChild('cloudflared', process.execPath, ['-e', FAKE_CLOUDFLARED], { env: { ...process.env, SC_FAKE_CLOUDFLARED: JSON.stringify(attempt) } }, null, silentLog);
    },
    sleep:
      opts.sleep ??
      (async (ms) => {
        waits.push(ms);
      }),
    random: () => 0,
  });
  tunnel.on('retry', (r) => retries.push(r));
  onTestFinished(() => tunnel.stop());
  return { tunnel, launches, waits, retries };
}

/** The CodedError `p` rejects with. */
async function codedRejection(p: Promise<unknown>): Promise<CodedError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CodedError);
  return err as CodedError;
}

describe('quick tunnel start: Cloudflare refuses or fails', () => {
  it('tries again after a 429 and gets the address', async () => {
    // Arrange
    const { tunnel, launches, waits, retries } = tunnelWith([failed(S429), { url: URL_ }]);
    // Act
    const url = await tunnel.start(18080);
    // Assert
    expect(url).toBe(URL_);
    expect(launches).toHaveLength(2);
    expect(launches[0]).toEqual(expect.arrayContaining(['tunnel', '--url', 'http://127.0.0.1:18080']));
    expect(waits).toEqual([START_RETRY_DELAYS_MS[0]]);
    expect(retries).toEqual([{ cause: 'busy', reason: S429, delayMs: START_RETRY_DELAYS_MS[0], attempt: 2, attempts: START_RETRY_DELAYS_MS.length + 1 }]);
  });

  it('tries again after a 5xx and gets the address', async () => {
    // Arrange
    const { tunnel, waits, retries } = tunnelWith([failed(S503), failed(S503), { url: URL_ }]);
    // Act
    const url = await tunnel.start(18080);
    // Assert
    expect(url).toBe(URL_);
    expect(waits).toEqual([START_RETRY_DELAYS_MS[0], START_RETRY_DELAYS_MS[1]]);
    expect(retries.map((r) => [r.cause, r.reason, r.attempt])).toEqual([
      ['unavailable', S503, 2],
      ['unavailable', S503, 3],
    ]);
  });

  it("gives up after the last attempt with Cloudflare's own words", async () => {
    // Arrange
    const attempts = START_RETRY_DELAYS_MS.length + 1;
    const { tunnel, launches, waits } = tunnelWith(Array.from({ length: attempts }, () => failed(S429_JSON)));
    // Act
    const err = await codedRejection(tunnel.start(18080));
    // Assert
    expect(launches).toHaveLength(attempts);
    expect(waits).toEqual([...START_RETRY_DELAYS_MS]);
    expect(err.code).toBe('err.tunnelBusy');
    expect(err.params).toEqual({ causeKey: 'tunnel.cause.busy', attempts, reason: S429_JSON });
    expect(err.message).toBe(`Cloudflare refused to open a new tunnel right now (too many requests). SwarmCast tried ${attempts} times. Wait a few minutes and turn SwarmCast on again. Cloudflare said: "${S429_JSON}"`);
  });

  it('fails at once, with its message, when cloudflared fails for another reason', async () => {
    // Arrange
    // What cloudflared 2026.10.4 prints for an unknown flag: on stdout, then exit code 0.
    const usage = 'Incorrect Usage. flag provided but not defined: -bogus-flag';
    const { tunnel, launches, waits, retries } = tunnelWith([{ lines: HELP(usage), exit: 0 }, { url: URL_ }]);
    // Act
    const err = await codedRejection(tunnel.start(18080));
    // Assert
    expect(launches).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(retries).toEqual([]);
    expect(err.code).toBe('err.tunnelFailed');
    expect(err.params).toEqual({ reason: usage });
    expect(err.message).toContain(`"${usage}"`);
  });

  it('fails at once with the exit code when cloudflared says nothing', async () => {
    // Arrange
    const { tunnel, launches } = tunnelWith([{ lines: [], exit: 3 }]);
    // Act
    const err = await codedRejection(tunnel.start(18080));
    // Assert
    expect(launches).toHaveLength(1);
    expect(err.code).toBe('err.tunnelExited');
    expect(err.params).toEqual({ code: '3' });
  });

  it('keeps the reason when cloudflared prints a lot and exits at once (its last lines can come after the exit)', async () => {
    // Arrange
    const { tunnel } = tunnelWith([{ noise: 3000, lines: [S429], exit: 1 }, { url: URL_ }]);
    const retries: TunnelRetry[] = [];
    tunnel.on('retry', (r) => retries.push(r));
    // Act
    const url = await tunnel.start(18080);
    // Assert
    expect(url).toBe(URL_);
    expect(retries.map((r) => r.reason)).toEqual([S429]);
  });

  it("logs cloudflared's bare error line as a warning (it reaches the activity log)", async () => {
    // Arrange
    const { log, lines } = captureLog('info');
    const { tunnel } = tunnelWith([failed(S429), { url: URL_ }], { log });
    // Act
    await tunnel.start(18080);
    // Assert
    expect(lines().filter((l) => l.level === 40).map((l) => l.cloudflared ?? l.msg)).toEqual([S429, 'cloudflare refused or failed the quick tunnel, trying again']);
  });

  it('stops trying when the tunnel is stopped during the wait', async () => {
    // Arrange
    const { tunnel, launches } = tunnelWith([failed(S429), { url: URL_ }], { sleep: (ms, signal) => sleep(60_000, signal) });
    let waiting!: () => void;
    const waited = new Promise<void>((r) => (waiting = r));
    tunnel.on('retry', () => waiting());
    // Act
    const started = tunnel.start(18080).then(
      () => 'started',
      (e: Error) => e.name,
    );
    await waited;
    await tunnel.stop();
    // Assert
    expect(await started).toBe('AbortError');
    expect(launches).toHaveLength(1);
  });
});

describe("classifying cloudflared's start failure", () => {
  it.each([
    ['a 429', [REQUESTING, S429], 'busy', S429],
    ['a 429 with Cloudflare errors', [REQUESTING, S429_JSON], 'busy', S429_JSON],
    ['a 503', [REQUESTING, S503], 'unavailable', S503],
    ['a 502 (bad gateway)', [REQUESTING, 'quick tunnel provisioning failed with status 502'], 'unavailable', 'quick tunnel provisioning failed with status 502'],
    [
      'a request timeout',
      [REQUESTING, 'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": net/http: request canceled (Client.Timeout exceeded while awaiting headers)'],
      'unavailable',
      'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": net/http: request canceled (Client.Timeout exceeded while awaiting headers)',
    ],
    [
      'an older release, whose 429 is in an ERR line before the exit message',
      [
        REQUESTING,
        '2024-03-01T10:00:00Z ERR Error unmarshaling QuickTunnel response: error code: 1015 error="invalid character \'e\' looking for beginning of value" status_code="429 Too Many Requests"',
        "failed to unmarshal quick Tunnel: invalid character 'e' looking for beginning of value",
      ],
      'busy',
      "failed to unmarshal quick Tunnel: invalid character 'e' looking for beginning of value",
    ],
  ])('%s is transient', (_what, lines, cause, reason) => {
    // Act
    const f = classifyStartFailure(lines);
    // Assert
    expect(f).toEqual({ transient: cause, reason });
  });

  it.each([
    ['an unknown flag (then the help text)', HELP('Incorrect Usage. flag provided but not defined: -bogus-flag'), 'Incorrect Usage. flag provided but not defined: -bogus-flag'],
    ['no internet (no DNS)', [REQUESTING, 'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: lookup api.trycloudflare.com: no such host'], 'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: lookup api.trycloudflare.com: no such host'],
    ['an ERR line only', [REQUESTING, '2026-11-01T02:58:54Z ERR Cannot determine default origin certificate path.'], 'Cannot determine default origin certificate path.'],
    ['silence', [], null],
  ])('%s is not transient', (_what, lines, reason) => {
    // Act
    const f = classifyStartFailure(lines);
    // Assert
    expect(f).toEqual({ transient: null, reason });
  });

  it('reads a Retry-After when cloudflared reports one', () => {
    // Act
    const f = classifyStartFailure([`${S429} (retry after 30 s)`]);
    // Assert
    expect(f.retryAfterS).toBe(30);
  });

  it('waits as long as Cloudflare asked, when that is longer than planned', async () => {
    // Arrange
    const { tunnel, waits } = tunnelWith([failed(`${S429}, Retry-After: 30`), { url: URL_ }]);
    // Act
    await tunnel.start(18080);
    // Assert
    expect(waits).toEqual([30_000]);
  });

  it('tells error lines from information lines', () => {
    // Act
    const kinds = [S429, '2026-11-01T02:58:54Z ERR boom', REQUESTING, '2026-11-01T02:58:54Z DBG x', '', '   --help, -h  show help'].map(isErrorLine);
    // Assert
    expect(kinds).toEqual([true, true, false, false, false, false]);
  });
});

/** A local tunnel (no reachability check) that reports one retry while starting and records what the panel showed then. */
class RetryOnceTunnel extends TunnelProvider {
  readonly name = 'none';
  current: string | null = null;
  seen: unknown;
  constructor(private readonly look: () => unknown) {
    super();
  }
  async start(localPort: number): Promise<string> {
    this.emit('retry', { cause: 'busy', reason: S429, delayMs: 5400, attempt: 2, attempts: 4 });
    this.seen = this.look();
    this.current = `http://127.0.0.1:${localPort}`;
    return this.current;
  }
  async stop(): Promise<void> {
    this.current = null;
  }
  get url(): string | null {
    return this.current;
  }
}

describe('the streamer sees Cloudflare refusing', () => {
  it('on the tunnel step while it waits, and in the activity log', async () => {
    // Arrange
    const steps = (): unknown => structuredClone(live.snapshot().steps.find((s) => s.id === 'tunnel'));
    const tunnel = new RetryOnceTunnel(() => steps());
    const { live } = makeController(undefined, { tunnel });
    onTestFinished(async () => void (await live.stop()));
    // Act
    await live.start();
    // Assert
    const params = { causeKey: 'tunnel.cause.busy', seconds: 6, attempt: 2, attempts: 4 };
    const note = 'Cloudflare refused to open a new tunnel right now (too many requests). SwarmCast tries again in 6 s (try 2 of 4).';
    expect(tunnel.seen).toMatchObject({ status: 'running', note, noteCode: 'step.tunnel.retry', noteParams: params });
    expect(live.snapshot().steps.find((s) => s.id === 'tunnel')).toEqual(expect.not.objectContaining({ note: expect.anything() }));
    expect(live.activity.list()).toContainEqual(expect.objectContaining({ level: 'warn', code: 'step.tunnel.retry', params, text: note }));
  });
});
