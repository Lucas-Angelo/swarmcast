export const PORT_BASE: number;
export const BLOCK: number;
/** SwarmCast's default ports and the demo's: never handed out, never a fixed test port. */
export const RESERVED: ReadonlySet<number>;

/** True when this process can listen on `port` on 127.0.0.1 and on all interfaces right now. */
export function canListen(port: number): Promise<boolean>;

/** `n` distinct ports of this worker's block (VITEST_POOL_ID) that are free right now. */
export function allocPorts(n: number): Promise<number[]>;

/** Named ports, e.g. `allocPortMap(['rtmp', 'mediamtxHls'])`. */
export function allocPortMap<K extends string>(names: readonly K[]): Promise<Record<K, number>>;

/** True for the error of a server that could not bind its port (worth one retry on new ports). */
export function isBindError(err: unknown): boolean;

/** True when something accepts TCP connections on host:port right now (connect probe, 800 ms). */
export function isListening(port: number, host?: string): Promise<boolean>;

type Range = readonly [first: number, last: number];
/** Each OS's default ephemeral port range (outgoing connections take their local port from it). */
export const EPHEMERAL_DEFAULTS: { readonly linux: Range; readonly darwin: Range; readonly win32: Range };
/** Where every fixed test port lies (10000-19999). */
export const FIXED_ZONE: Range;
/** Every fixed port of the test harnesses, by harness. */
export const FIXED_PORTS: {
  readonly e2e: { readonly public: number; readonly admin: number; readonly control: number; readonly mediamtxHls: number; readonly rtmp: number };
  readonly site: { readonly http: number };
  readonly obsE2e: { readonly public: number; readonly admin: number; readonly mediamtxHls: number; readonly rtmp: number };
  readonly qualityDebug: { readonly public: number; readonly admin: number; readonly mediamtxHls: number; readonly rtmp: number };
  readonly quality: { readonly public: number; readonly admin: number; readonly control: number; readonly mediamtxHls: number; readonly rtmp: number };
  readonly desktopUpdate: { readonly http: number };
};
export type Harness = keyof typeof FIXED_PORTS;
/** The offset docs screenshots run the e2e server with. */
export const SCREENSHOTS_OFFSET: number;
/** The e2e server's ports moved by `offset` (default: SWARMCAST_E2E_PORT_OFFSET). */
export function e2ePorts(offset?: number): { public: number; admin: number; control: number; mediamtxHls: number; rtmp: number };
/** This machine's ephemeral port range (the OS default when it cannot be read). */
export function ephemeralRange(platform?: string): [number, number];
/** One sentence per problem with these fixed ports (none: fine). */
export function fixedPortProblems(harness: Harness, ports: Record<string, number>, ranges?: ReadonlyArray<readonly [number, number]>): string[];
/** Throws, naming every problem, unless fixedPortProblems() finds none. */
export function assertFixedPorts(harness: Harness, ports: Record<string, number>, what?: string): void;
