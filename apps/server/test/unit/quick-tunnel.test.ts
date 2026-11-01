import { describe, expect, it, onTestFinished } from 'vitest';
import { CodedError } from '../../src/core/messages.js';
import { sleep } from '../../src/core/retry.js';
import { ManagedChild } from '../../src/process/children.js';
import { translate } from '@swarmcast/shared/i18n';
import { TunnelProvider, type ReachabilityIo, type TunnelRetry } from '../../src/tunnel/provider.js';
import { QuickTunnel } from '../../src/tunnel/quick.js';
import { REACHABLE_TIMEOUT_MS } from '../../src/tunnel/start-budget.js';
import { START_RETRY_DELAYS_MS, classifyStartFailure, isErrorLine, isQuicFailureLine } from '../../src/tunnel/start-failure.js';
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

/**
 * `noise`: that many debug lines first (made by the fake: an environment variable holds at most 128 KiB on Linux).
 * With `url`: `after` is printed with the address (one write), then it exits with `exit` (stays up without it).
 * `hang`: prints nothing and stays up.
 */
type Attempt = { lines: string[]; exit: number; noise?: number } | { url: string; after?: string[]; exit?: number } | { hang: true };

/** Prints its attempt's lines on stderr, then exits with its code, or prints the address and stays up. */
const FAKE_CLOUDFLARED = [
  'const a = JSON.parse(process.env.SC_FAKE_CLOUDFLARED);',
  "for (let i = 0; i < (a.noise ?? 0); i++) process.stderr.write('2026-11-01T02:58:54Z DBG line ' + i + ' ' + 'x'.repeat(80) + '\\n');",
  "for (const l of a.lines ?? []) process.stderr.write(l + '\\n');",
  'if (a.url) {',
  // One write: the address and what follows reach SwarmCast together, as cloudflared's output can.
  "  process.stderr.write(['2026-11-01T02:58:55Z INF |  ' + a.url + '  |', ...(a.after ?? [])].map((l) => l + '\\n').join(''));",
  '  if (a.exit === undefined) setInterval(() => {}, 1000); else process.exitCode = a.exit;',
  '} else if (a.hang) setInterval(() => {}, 1000);',
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
  const udpBlocked: string[] = [];
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
  tunnel.on('udp-blocked', (reason) => udpBlocked.push(reason));
  onTestFinished(() => tunnel.stop());
  return { tunnel, launches, waits, retries, udpBlocked };
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
    const quicGo = '2026/11/01 03:54:44 failed to sufficiently increase receive buffer size (was: 1024 kiB, wanted: 7168 kiB, got: 2048 kiB). See https://github.com/quic-go/quic-go/wiki/UDP-Buffer-Sizes for details.';
    const kinds = [S429, '2026-11-01T02:58:54Z ERR boom', REQUESTING, '2026-11-01T02:58:54Z DBG x', '', '   --help, -h  show help', quicGo].map(isErrorLine);
    // Assert
    expect(kinds).toEqual([true, true, false, false, false, false, false]);
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

// A network that blocks or drops UDP: cloudflared gets its address (an HTTPS request) but then
// cannot reach Cloudflare's edge over QUIC, its default, and the address never answers.
// cloudflared's own fallback to HTTP/2 needs 8 failed dials with growing pauses, longer than
// SwarmCast waits for an address. These are the lines cloudflared 2026.10.4 printed in CI run
// 41283791976 (macOS runner) and against a local edge that drops UDP (integration test).
const QUIC_SERVE = '2026-11-01T08:45:37Z ERR Serve tunnel error error="accept stream listener error: failed to accept QUIC stream: timeout: no recent network activity" connIndex=0 event=0 ip=198.41.192.167';
const QUIC_DIAL = '2026-11-01T08:45:44Z ERR Failed to dial a quic connection error="failed to dial to edge with quic: timeout: no recent network activity" connIndex=0 event=0 ip=198.41.192.227';
const PRECHECK_UDP = '2026-11-01T09:06:29Z INF precheck component="UDP Connectivity" details="QUIC connection failed" run_id=768f8978-6d13-4bf6-ab0c-f3d5a3487124 status=fail target=198.41.192.227:7844';
const REGISTERED = '2026-11-01T08:45:30Z INF Registered tunnel connection connIndex=0 connection=0f0e0d0c-0b0a-4908-8706-050403020100 event=0 ip=198.41.200.13 location=gru05 protocol=quic';
const TCP_URL = 'https://calm-lake-over-tcp.trycloudflare.com';

/** Resolves on the tunnel's next `down` (its cloudflared exited after printing everything). */
const nextDown = (tunnel: TunnelProvider): Promise<void> => new Promise((resolve) => tunnel.once('down', () => resolve()));

describe('quick tunnel: a network that blocks UDP', () => {
  it('reports UDP blocked after two QUIC failures before any connection, once, in its own words', async () => {
    // Arrange
    const { tunnel, udpBlocked } = tunnelWith([{ url: URL_, after: [QUIC_SERVE, QUIC_DIAL, QUIC_DIAL], exit: 1 }]);
    // Act
    const url = await tunnel.start(18080);
    await nextDown(tunnel);
    // Assert
    expect(url).toBe(URL_);
    expect(udpBlocked).toEqual(['Failed to dial a quic connection error="failed to dial to edge with quic: timeout: no recent network activity" connIndex=0 event=0 ip=198.41.192.227']);
  });

  it.each([
    ['one QUIC failure (a lost burst: cloudflared tries another address)', [QUIC_DIAL]],
    ['QUIC failures after a connection worked', [REGISTERED, QUIC_SERVE, QUIC_DIAL]],
    ['unrelated errors', ['2026-11-01T08:45:37Z ERR Unable to reach the origin service. The service may be down error="dial tcp 127.0.0.1:18080: connect: connection refused"', '2026-11-01T08:45:38Z ERR boom']],
  ])('does not report UDP blocked for %s', async (_what, after) => {
    // Arrange
    const { tunnel, udpBlocked } = tunnelWith([{ url: URL_, after, exit: 1 }]);
    // Act
    await tunnel.start(18080);
    await nextDown(tunnel);
    // Assert
    expect(udpBlocked).toEqual([]);
  });

  it("counts cloudflared's own UDP pre-check failure", async () => {
    // Arrange
    const { tunnel, udpBlocked } = tunnelWith([{ url: URL_, after: [QUIC_DIAL, PRECHECK_UDP], exit: 1 }]);
    // Act
    await tunnel.start(18080);
    await nextDown(tunnel);
    // Assert
    expect(udpBlocked).toHaveLength(1);
  });

  it('opens over TCP (--protocol http2) when asked, and never reports UDP blocked then', async () => {
    // Arrange
    const { tunnel, launches, udpBlocked } = tunnelWith([{ url: URL_ }, { url: TCP_URL, after: [QUIC_DIAL, QUIC_DIAL], exit: 1 }]);
    // Act
    await tunnel.start(18080);
    await tunnel.stop();
    await tunnel.start(18080, { transport: 'tcp' });
    await nextDown(tunnel);
    // Assert
    expect(launches[0]).not.toContain('--protocol');
    expect(launches[1]).toEqual(expect.arrayContaining(['--url', 'http://127.0.0.1:18080']));
    expect(launches[1]!.slice(launches[1]!.indexOf('--protocol'), launches[1]!.indexOf('--protocol') + 2)).toEqual(['--protocol', 'http2']);
    expect(udpBlocked).toEqual([]);
  });

  it('keeps TCP when cloudflared restarts during the live', async () => {
    // Arrange
    const { tunnel, launches } = tunnelWith([{ url: URL_, exit: 1 }, { url: TCP_URL }]);
    const changed = new Promise<string>((resolve) => tunnel.once('url', resolve));
    // Act
    await tunnel.start(18080, { transport: 'tcp' });
    const url = await changed;
    // Assert
    expect(url).toBe(TCP_URL);
    expect(launches.map((a) => a.includes('http2'))).toEqual([true, true]);
  });

  it("does not start a retry that would end after the tunnel step's deadline: Cloudflare's words at once", async () => {
    // Arrange
    const { tunnel, launches, waits } = tunnelWith([failed(S429), { url: URL_ }]);
    // Act
    const err = await codedRejection(tunnel.start(18080, { deadline: Date.now() + START_RETRY_DELAYS_MS[0] - 1 }));
    // Assert
    expect(launches).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(err.code).toBe('err.tunnelBusy');
    expect(err.params).toEqual({ causeKey: 'tunnel.cause.busy', attempts: 1, reason: S429 });
  });

  it.each([
    [QUIC_SERVE, true],
    [QUIC_DIAL, true],
    [PRECHECK_UDP, true],
    ['2026-11-01T09:06:29Z INF precheck component="UDP Connectivity" details="QUIC connection succeeded" status=pass target=198.41.192.227:7844', false],
    ['2026-11-01T09:06:29Z INF |  UDP Connectivity  198.41.192.227:7844  FAIL  QUIC connection failed  |', false],
    [REGISTERED, false],
  ])('%s is a QUIC failure: %s', (line, expected) => {
    // Act
    const is = isQuicFailureLine(line);
    // Assert
    expect(is).toBe(expected);
  });
});

/** A network where only `reachableHost` answers (the tunnel over TCP); its checks go to the live's local public server. */
function networkWhereOnly(reachableHost: string, publicPort: () => number | null): ReachabilityIo {
  return {
    cloudflare: async () => ({ ip: '192.0.2.10' }),
    system: async () => true,
    health: async (url, _ip, headers) => {
      if (url.hostname !== reachableHost) return null;
      const res = await fetch(`http://127.0.0.1:${publicPort()}/healthz`, { headers });
      await res.body?.cancel();
      return res.ok ? res.headers.get('x-swarmcast') : null;
    },
  };
}

/** A live whose tunnel is a QuickTunnel running the fake cloudflared `attempts`, on a network where only `reachableHost` answers. */
function liveWith(attempts: Attempt[], reachableHost: string, check: { reachableMs?: number; budgetMs?: number } = {}) {
  const t = tunnelWith(attempts);
  let port: () => number | null = () => null;
  const { live } = makeController(undefined, {
    tunnel: t.tunnel,
    egress: { lookup: async () => ({}) },
    tunnelCheck: { io: networkWhereOnly(reachableHost, () => port()), ...check },
  });
  port = () => live.publicPort;
  onTestFinished(async () => void (await live.stop()));
  return { ...t, live };
}

const tunnelStep = (live: ReturnType<typeof makeController>['live']) => live.snapshot().steps.find((s) => s.id === 'tunnel');

describe('the live opens a new tunnel over TCP when UDP is blocked', () => {
  it('as soon as cloudflared reports QUIC failures, and goes live over TCP (CI run 41283791976)', async () => {
    // Arrange
    const { live, launches } = liveWith([{ url: URL_, after: [QUIC_SERVE, QUIC_DIAL] }, { url: TCP_URL }], new URL(TCP_URL).hostname);
    const t0 = Date.now();
    // Act
    await live.start();
    // Assert
    expect(live.snapshot().liveLink).toMatch(/^https:\/\/calm-lake-over-tcp\.trycloudflare\.com\/join\//);
    expect(Date.now() - t0).toBeLessThan(REACHABLE_TIMEOUT_MS / 4);
    expect(launches).toHaveLength(2);
    expect(launches[0]).not.toContain('--protocol');
    expect(launches[1]).toEqual(expect.arrayContaining(['--protocol', 'http2']));
    const text = 'Your network blocks or drops the faster route to Cloudflare (UDP). SwarmCast is opening a new tunnel over a regular TCP connection instead.';
    expect(live.activity.list()).toContainEqual(expect.objectContaining({ level: 'warn', code: 'step.tunnel.tcp', params: { causeKey: 'tunnel.cause.udpBlocked' }, text }));
    expect(translate('pt-BR', 'step.tunnel.tcp', { causeKey: 'tunnel.cause.udpBlocked' })).toBe('Sua rede bloqueia ou perde o caminho mais rápido até a Cloudflare (UDP). O SwarmCast está abrindo um túnel novo por uma conexão TCP comum.');
  });

  it('when the address does not answer in time, even without QUIC errors', async () => {
    // Arrange
    const { live, launches } = liveWith([{ url: URL_ }, { url: TCP_URL }], new URL(TCP_URL).hostname, { reachableMs: 1500 });
    // Act
    await live.start();
    // Assert
    expect(live.snapshot().liveLink).toContain('calm-lake-over-tcp');
    expect(launches[1]).toEqual(expect.arrayContaining(['--protocol', 'http2']));
    expect(live.activity.list()).toContainEqual(expect.objectContaining({ code: 'step.tunnel.tcp', params: { causeKey: 'tunnel.cause.noAnswer' }, text: 'The tunnel address did not answer in time. SwarmCast is opening a new tunnel over a regular TCP connection instead.' }));
  });

  it('shows the switch on the tunnel step while the new tunnel opens', async () => {
    // Arrange
    const { live, tunnel } = liveWith([{ url: URL_, after: [QUIC_DIAL, QUIC_DIAL] }, { url: TCP_URL }], new URL(TCP_URL).hostname);
    let seen: unknown;
    const start = tunnel.start.bind(tunnel);
    tunnel.start = (port, opts) => {
      if (opts?.transport === 'tcp') seen = structuredClone(tunnelStep(live));
      return start(port, opts);
    };
    // Act
    await live.start();
    // Assert
    expect(seen).toMatchObject({ status: 'running', noteCode: 'step.tunnel.tcp', noteParams: { causeKey: 'tunnel.cause.udpBlocked' } });
  });

  it('fails with "does not answer" when the TCP tunnel does not answer either (one switch only)', async () => {
    // Arrange
    const { live, launches } = liveWith([{ url: URL_ }, { url: TCP_URL }], 'nothing-answers.example', { reachableMs: 500 });
    // Act
    const err = await codedRejection(live.start());
    // Assert
    expect(err.code).toBe('err.tunnelNoAnswer');
    expect(launches).toHaveLength(2);
    expect(live.snapshot().phase).toBe('off');
  });

  it("gives up at the tunnel step's limit with its own error, and stops cloudflared", async () => {
    // Arrange
    const { live, tunnel } = liveWith([{ hang: true }], 'nothing-answers.example', { budgetMs: 1200 });
    const t0 = Date.now();
    // Act
    const err = await codedRejection(live.start());
    // Assert
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(err.code).toBe('err.tunnelTimeout');
    expect(err.params).toEqual({ minutes: 1 });
    expect(err.message).toBe("The secure tunnel did not open within 1 min. Check your internet connection (a firewall may block Cloudflare's tunnel, port 7844) and turn SwarmCast on again.");
    expect(tunnel.pid).toBeUndefined();
    expect(tunnelStep(live)).toMatchObject({ status: 'error' });
  });
});
