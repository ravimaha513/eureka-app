import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import pg from "pg";
import { CONFIG, type AppConfig } from "./config.js";

/** Statement timeout for exports and org-wide reports; every other query has the pool's 5s. */
export const EXPORT_STATEMENT_TIMEOUT = "60s";

/**
 * Database access for the API. Every business query runs inside withUser(),
 * which opens a transaction and passes ONLY the user id to PostgreSQL
 * (design B4.5). RLS computes the scope from database tables.
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool: pg.Pool;

  constructor(@Inject(CONFIG) config: AppConfig) {
    this.pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: config.DB_POOL_MAX });
    this.pool.on("connect", (c) => {
      void c.query("SET statement_timeout = '5s'");
    });
  }

  async withUser<T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('eureka.user_id', $1, true)", [userId]);
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  /**
   * withUser for CSV exports and org-wide reports (design N9): the statement timeout is raised from the
   * pool's 5s to EXPORT_STATEMENT_TIMEOUT for this transaction only.
   */
  async withUserExport<T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    return this.withUser(userId, async (c) => {
      await c.query(`SET LOCAL statement_timeout = '${EXPORT_STATEMENT_TIMEOUT}'`);
      return fn(c);
    });
  }

  /**
   * jobs-portal: a portal request runs as the eureka_portal role (SET LOCAL
   * ROLE, migration 0061) with ONLY the applicant id; no staff user id is set,
   * and that role's policies limit every row to this applicant.
   */
  async withApplicant<T>(applicantId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE eureka_portal");
      await c.query("SELECT set_config('eureka.applicant_id', $1, true)", [applicantId]);
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  /** Queries that must run without a user (session lookup, login). */
  async system<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
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
