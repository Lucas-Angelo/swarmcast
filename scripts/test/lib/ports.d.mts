export const PORT_BASE: number;
export const BLOCK: number;
/** SwarmCast's default ports and the demo's: never handed out. */
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
