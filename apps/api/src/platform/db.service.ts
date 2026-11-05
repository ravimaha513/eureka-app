import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import pg from "pg";
import { CONFIG, type AppConfig } from "./config.js";
import { databaseBusy, isConnectTimeout, pgCodeOf } from "./errors.js";
import { apiLog, errorFields } from "./logger.js";

/** Default statement timeout of every API connection (design N9; reports raise it with SET LOCAL). */
export const STATEMENT_TIMEOUT_MS = 5000;

/** A failed ROLLBACK leaves the connection in an unknown state: the pool destroys a client released with an error. */
const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

/**
 * Database access for the API. Every business query runs inside withUser(),
 * which opens a transaction and passes ONLY the user id to PostgreSQL
 * (design B4.5). RLS computes the scope from database tables.
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool: pg.Pool;

  constructor(@Inject(CONFIG) config: AppConfig) {
    this.pool = new pg.Pool({
      connectionString: config.DATABASE_URL,
      max: config.DB_POOL_MAX,
      // Session default sent as a startup parameter (no extra round trip, no
      // floating promise). Reports raise it per transaction with SET LOCAL.
      statement_timeout: STATEMENT_TIMEOUT_MS,
      // Bounded wait for a connection; acquire() turns the timeout into a retryable 503.
      connectionTimeoutMillis: config.DB_CONNECT_TIMEOUT_MS,
    });
    // An idle pooled client whose backend dies (failover, pg_terminate_backend,
    // network reset) emits `error` on the pool. Without a listener that event
    // would crash the process; the pool already discards the client.
    this.pool.on("error", (err) => apiLog.error("idle database client error", { pgCode: pgCodeOf(err), ...errorFields(err) }));
    // A client whose backend dies while checked out (between queries of a
    // transaction) emits `error` on itself, where pg-pool has no listener while
    // it is lent out: that would crash the process too. The request's next query
    // fails with the error (and is logged there); release() then discards the client.
    this.pool.on("connect", (c) => { c.on("error", () => undefined); });
  }

  /** A pooled client; no connection within DB_CONNECT_TIMEOUT_MS is a 503 with Retry-After. */
  private async acquire(): Promise<pg.PoolClient> {
    try {
      return await this.pool.connect();
    } catch (err) {
      if (isConnectTimeout(err)) throw databaseBusy();
      throw err;
    }
  }

  async withUser<T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.acquire();
    let broken: Error | undefined;
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('eureka.user_id', $1, true)", [userId]);
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (err) {
      await c.query("ROLLBACK").catch((rollbackErr: unknown) => { broken = toError(rollbackErr); });
      throw err;
    } finally {
      c.release(broken);
    }
  }

  /** Same-transaction write under system scope (no user id set): the change and its audit row commit or roll back together. */
  async withSystemTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.acquire();
    let broken: Error | undefined;
    try {
      await c.query("BEGIN");
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (err) {
      await c.query("ROLLBACK").catch((rollbackErr: unknown) => { broken = toError(rollbackErr); });
      throw err;
    } finally {
      c.release(broken);
    }
  }

  /**
   * jobs-portal: a portal request runs as the eureka_portal role (SET LOCAL
   * ROLE, migration 0061) with ONLY the applicant id; no staff user id is set,
   * and that role's policies limit every row to this applicant.
   */
  async withApplicant<T>(applicantId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.acquire();
    let broken: Error | undefined;
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE eureka_portal");
      await c.query("SELECT set_config('eureka.applicant_id', $1, true)", [applicantId]);
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (err) {
      await c.query("ROLLBACK").catch((rollbackErr: unknown) => { broken = toError(rollbackErr); });
      throw err;
    } finally {
      c.release(broken);
    }
  }

  /** Queries that must run without a user (session lookup, login). */
  async system<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.acquire();
    try {
      return await fn(c);
    } finally {
      c.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
