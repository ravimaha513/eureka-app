import { createHash } from "node:crypto";
import type pg from "pg";

/**
 * Fixed-window per-key limiter, in memory per task. Good enough to stop one
 * signed-in user scraping a list; not a global quota (WAF and API Gateway
 * throttling cover volume per IP and overall; the applicant portal also has
 * database-wide caps). The map is hard-capped: at `maxKeys` expired windows
 * are dropped from the oldest end, then the oldest live keys are evicted
 * (a Map keeps insertion order), so a flood of distinct keys costs O(1)
 * amortised per call and bounded memory.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number, private readonly windowMs: number, private readonly now = () => Date.now(),
    private readonly maxKeys = 10_000,
  ) {}

  /** Returns true when the call is allowed. */
  take(key: string): boolean {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      this.windows.delete(key);
      while (this.windows.size >= this.maxKeys) {
        const oldest = this.windows.keys().next();
        if (oldest.done) break;
        this.windows.delete(oldest.value);
      }
      this.windows.set(key, { start: t, count: 1 });
      return true;
    }
    w.count += 1;
    return w.count <= this.limit;
  }

  get size(): number { return this.windows.size; }
}

/** Anything that can run one query: a pooled client inside the caller's transaction. */
export interface RateQueryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}
/** Runs a query on its own pooled connection, outside any transaction (DbService.system). */
export interface RateSystemDb {
  system<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T>;
}

/**
 * Fixed-window limiter shared by every API task and kept across deploys
 * (audit R-24, F-06/B-09): the count lives in Postgres (authz.rate_take,
 * migration 0516; one UPSERT per call, windows aligned to the epoch). For the
 * security-relevant limits only: password sign-in and reset, portal sign-up,
 * link and verify, public feedback, document and Data Hub downloads/uploads,
 * exports. Cheap read throttles stay on RateLimiter.
 *
 * An in-memory RateLimiter with the same limit stays in front as a fast first
 * gate: a key already over its limit on this task is refused without a round
 * trip. The key never reaches the database raw: the API sends
 * SHA-256(name, key) and the function stores a digest of that, so IPs, emails
 * and ids are not stored.
 *
 * `take(key, via)`: `via` is either the caller's transaction client (the unit
 * is given back if that transaction rolls back; use this inside withUser so a
 * request never holds two pool connections) or the DbService, which runs one
 * autocommit statement on its own checkout (the unit always counts; use this
 * before any other database work, e.g. sign-in).
 */
export class SharedRateLimiter {
  private readonly local: RateLimiter;
  private readonly windowSeconds: number;

  constructor(private readonly name: string, private readonly limit: number, windowMs: number) {
    if (!/^[a-z0-9_.:-]{1,60}$/.test(name)) throw new Error(`invalid rate limiter name ${name}`);
    this.windowSeconds = Math.max(1, Math.round(windowMs / 1000));
    this.local = new RateLimiter(limit, windowMs);
  }

  /** Returns true when the call is allowed. */
  async take(key: string, via: RateQueryable | RateSystemDb): Promise<boolean> {
    if (!this.local.take(key)) return false;
    const digest = createHash("sha256").update(this.name).update("\0").update(key).digest("hex");
    const sql = `SELECT authz.rate_take($1, $2, $3) AS ok`;
    const params = [`${this.name}:${digest}`, this.limit, this.windowSeconds];
    const run = (c: RateQueryable) => c.query<{ ok: boolean }>(sql, params);
    const { rows } = "system" in via ? await via.system(run) : await run(via);
    return rows[0]?.ok === true;
  }
}
