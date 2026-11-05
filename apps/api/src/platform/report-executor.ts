import { Inject, Injectable, Optional } from "@nestjs/common";
import type pg from "pg";
import { CONFIG, type AppConfig } from "./config.js";
import { DbService } from "./db.service.js";
import { RetryableUnavailable } from "./errors.js";

/**
 * Report execution (audit R-03: E-02, D-05, F-02). Heavy report queries share
 * the API's small pool with sign-in, health and every write, so they:
 *
 * - run at most `REPORT_MAX_CONCURRENT` at once per API task; when that many
 *   are running the next one is refused at once with 503 + `Retry-After`
 *   (it never queues for a pool connection);
 * - get a raised statement timeout of at most REPORT_TIMEOUT_MS, below the
 *   API Gateway's 29 s integration timeout, so a query never outlives the
 *   request that asked for it;
 * - turn a statement timeout (SQLSTATE 57014) into 503 + `Retry-After`.
 *
 * Light runs (a caller below org scope, where the module already conditioned
 * the raised timeout on org scope) keep the pool's 5 s default and skip the
 * semaphore, as before.
 *
 * `cached` is a short in-process TTL cache for point-in-time aggregates only
 * (market report, dashboard needs-attention). Entries are keyed by the user id
 * plus normalized parameters (callers include the caller's scope), so one
 * user's result is never served to another.
 */

/** Raised statement timeout for heavy reports: below API Gateway's 29 s. */
export const REPORT_TIMEOUT_MS = 25_000;
/** Seconds a client should wait when every report slot is taken. */
export const REPORT_BUSY_RETRY_AFTER = 5;
/** Seconds a client should wait after a report hit the statement timeout. */
export const REPORT_TIMEOUT_RETRY_AFTER = 30;
/** Shown to the user (the web app renders a 503 problem's detail). */
export const REPORT_BUSY_DETAIL = "Too many reports are running right now; try again in a few seconds";
export const REPORT_TIMEOUT_DETAIL = "The report took too long. Try again later.";
/** Point-in-time aggregate cache: lifetime and size bound. */
export const REPORT_CACHE_TTL_MS = 60_000;
export const REPORT_CACHE_MAX_ENTRIES = 500;

export interface ReportRunOptions {
  /** Heavy: takes a report slot and the raised timeout. False keeps the pool default (5 s) and no slot. Default true. */
  heavy?: boolean;
  /** The 503 detail when the statement timeout fires (modules keep their own wording). */
  timeoutDetail?: string;
}

/** Non-blocking counting semaphore: tryAcquire never waits. */
export class Semaphore {
  private used = 0;
  constructor(readonly max: number) {}
  get inUse(): number { return this.used; }
  tryAcquire(): (() => void) | null {
    if (this.used >= this.max) return null;
    this.used++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used--;
    };
  }
}

/** Bounded TTL map: expired entries are dropped on read; when full, expired then oldest entries are evicted. */
export class TtlCache<V> {
  private readonly map = new Map<string, { at: number; value: V }>();
  constructor(readonly ttlMs: number, readonly maxEntries: number, private readonly now: () => number = Date.now) {}
  get size(): number { return this.map.size; }
  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (this.now() - e.at >= this.ttlMs) { this.map.delete(key); return undefined; }
    return e.value;
  }
  set(key: string, value: V): void {
    this.map.delete(key);
    if (this.map.size >= this.maxEntries) {
      const t = this.now();
      for (const [k, e] of this.map) if (t - e.at >= this.ttlMs) this.map.delete(k);
      while (this.map.size >= this.maxEntries) this.map.delete(this.map.keys().next().value!);
    }
    this.map.set(key, { at: this.now(), value });
  }
}

/**
 * JSON with object keys sorted, undefined dropped and Sets/Maps as sorted entries (scope objects hold Sets),
 * so equal parameters give equal keys.
 */
export function normalizeParams(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x instanceof Set) return { $set: [...x].map(norm).map((e) => JSON.stringify(e)).sort() };
    if (x instanceof Map) return { $map: [...x].map(([k, e]) => JSON.stringify([norm(k), norm(e)])).sort() };
    if (x && typeof x === "object" && !(x instanceof Date)) {
      return Object.fromEntries(Object.keys(x).sort().filter((k) => (x as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, norm((x as Record<string, unknown>)[k])]));
    }
    return x;
  };
  return JSON.stringify(norm(v)) ?? "null";
}

/** Optional provider (tests): cache lifetime, size and clock. */
export const REPORT_CACHE_OPTIONS = Symbol("REPORT_CACHE_OPTIONS");
export interface ReportCacheOptions { ttlMs?: number; maxEntries?: number; now?: () => number }

@Injectable()
export class ReportExecutor {
  readonly slots: Semaphore;
  private readonly cache: TtlCache<unknown>;

  constructor(
    private readonly db: DbService,
    @Inject(CONFIG) config: Pick<AppConfig, "REPORT_MAX_CONCURRENT">,
    @Optional() @Inject(REPORT_CACHE_OPTIONS) cache?: ReportCacheOptions,
  ) {
    this.slots = new Semaphore(config.REPORT_MAX_CONCURRENT);
    this.cache = new TtlCache(cache?.ttlMs ?? REPORT_CACHE_TTL_MS, cache?.maxEntries ?? REPORT_CACHE_MAX_ENTRIES, cache?.now);
  }

  /** Runs `fn` in db.withUser as the user, under the report limits above. */
  async run<T>(userId: string, opts: ReportRunOptions, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const heavy = opts.heavy ?? true;
    const release = heavy ? this.slots.tryAcquire() : null;
    if (heavy && !release) throw new RetryableUnavailable(REPORT_BUSY_DETAIL, REPORT_BUSY_RETRY_AFTER);
    try {
      return await this.db.withUser(userId, async (c) => {
        if (heavy) await c.query(`SET LOCAL statement_timeout = '${REPORT_TIMEOUT_MS}ms'`);
        return fn(c);
      });
    } catch (err) {
      if ((err as { code?: string } | null)?.code === "57014") {
        throw new RetryableUnavailable(opts.timeoutDetail ?? REPORT_TIMEOUT_DETAIL, REPORT_TIMEOUT_RETRY_AFTER);
      }
      throw err;
    } finally {
      release?.();
    }
  }

  /**
   * Point-in-time aggregates only: returns a result computed for the same
   * user and parameters within the TTL, else loads and stores it. Failures are
   * not cached.
   */
  async cached<T>(name: string, userId: string, params: unknown, load: () => Promise<T>): Promise<T> {
    const key = `${name}\u0000${userId}\u0000${normalizeParams(params)}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return structuredClone(hit) as T;
    const value = await load();
    this.cache.set(key, structuredClone(value));
    return value;
  }
}
