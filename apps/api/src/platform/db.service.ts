import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import pg from "pg";
import { CONFIG, type AppConfig } from "./config.js";

/**
 * Database access for the API. Every business query runs inside withUser(),
 * which opens a transaction and passes ONLY the user id to PostgreSQL
 * (design B4.5). RLS computes the scope from database tables.
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool: pg.Pool;

  constructor(@Inject(CONFIG) config: AppConfig) {
    this.pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 20 });
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
