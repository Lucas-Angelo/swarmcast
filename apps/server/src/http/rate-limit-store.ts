import type { FastifyRateLimitStore, FastifyRateLimitStoreCtor } from '@fastify/rate-limit';
import LocalStore from '@fastify/rate-limit/store/LocalStore.js';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Forget every rate-limit counter of this server (global and per-route). Test hook: the
     * E2E control server calls it between specs so one spec's burst of joins never makes the
     * next spec wait out a one-minute window. Never reachable over HTTP.
     */
    resetRateLimits(): void;
  }
}

type Callback = Parameters<FastifyRateLimitStore['incr']>[1];
interface StoreParams {
  continueExceeding?: boolean;
  exponentialBackoff?: boolean;
  cache?: number;
}

/**
 * The plugin's own in-memory store (same counting, same LRU bound), with a reset. The plugin
 * makes one store from the global options and a child store per route with its own limits;
 * every one of them is tracked, so a reset clears them all.
 */
export function resettableRateLimits(): { Store: FastifyRateLimitStoreCtor; reset(): void } {
  const stores = new Set<ResettableStore>();
  class ResettableStore implements FastifyRateLimitStore {
    private inner: LocalStore;
    constructor(private readonly params: StoreParams) {
      this.inner = ResettableStore.make(params);
      stores.add(this);
    }

    private static make(p: StoreParams): LocalStore {
      return new LocalStore(p.continueExceeding, p.exponentialBackoff, p.cache);
    }

    incr(key: string, cb: Callback, timeWindow: number, max: number): void {
      this.inner.incr(key, cb, timeWindow, max);
    }

    read(key: string, cb: Callback, timeWindow: number, max?: number): void {
      this.inner.read(key, cb, timeWindow, max);
    }

    /** The plugin passes the route's merged options (they include the store options). */
    child(routeOptions: object): FastifyRateLimitStore {
      return new ResettableStore(routeOptions as StoreParams);
    }

    reset(): void {
      this.inner = ResettableStore.make(this.params);
    }
  }
  return {
    Store: ResettableStore as unknown as FastifyRateLimitStoreCtor,
    reset: () => {
      for (const s of stores) s.reset();
    },
  };
}
