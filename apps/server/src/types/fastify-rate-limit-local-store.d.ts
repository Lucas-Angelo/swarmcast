// @fastify/rate-limit's in-memory store (the plugin's default). Not part of its typed API, but
// the package has no "exports" map, so the file is importable; rate-limit-store.ts wraps it.
declare module '@fastify/rate-limit/store/LocalStore.js' {
  type Callback = (err: Error | null, res?: { current: number; ttl: number }) => void;
  class LocalStore {
    constructor(continueExceeding?: boolean, exponentialBackoff?: boolean, cache?: number);
    incr(key: string, cb: Callback, timeWindow: number, max: number): void;
    read(key: string, cb: Callback, timeWindow: number, max?: number): void;
  }
  export default LocalStore;
}
