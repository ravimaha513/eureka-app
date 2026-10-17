import pg from "pg";
import { inject } from "vitest";
import { seedCatalog } from "../src/db/migrate.js";
import { APP_PASSWORD } from "./global-setup.js";

const ADMIN_BASE = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432";

export interface TestDb {
  name: string;
  admin: pg.Pool;
  app: pg.Pool;
  worker: pg.Pool;
  drop(): Promise<void>;
}

/**
 * Creates a fresh database as a copy of the run's migrated template (global-setup.ts) and returns
 * pools per role. Each file gets its own database, so files run in parallel.
 */
export async function createTestDb(): Promise<TestDb> {
  const name = `eureka_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const root = new pg.Client({ connectionString: `${ADMIN_BASE}/postgres` });
  await root.connect();
  await root.query(`CREATE DATABASE ${name} TEMPLATE ${inject("templateDb")}`);
  await root.end();

  const admin = new pg.Pool({ connectionString: `${ADMIN_BASE}/${name}`, max: 4 });
  // The template was seeded without these; a file that sets them gets the policy switches they imply.
  if (process.env.EUREKA_ENVIRONMENT || process.env.SINGLE_ADMIN_MODE) {
    const c = await admin.connect();
    try { await seedCatalog(c); } finally { c.release(); }
  }
  const url = new URL(ADMIN_BASE);
  const roleUrl = (role: string) => `postgres://${role}:${APP_PASSWORD}@${url.host}/${name}`;
  const app = new pg.Pool({ connectionString: roleUrl("eureka_app"), max: 8 });
  const worker = new pg.Pool({ connectionString: roleUrl("eureka_worker"), max: 2 });

  return {
    name,
    admin,
    app,
    worker,
    async drop() {
      await app.end();
      await worker.end();
      await admin.end();
      const c = new pg.Client({ connectionString: `${ADMIN_BASE}/postgres` });
      await c.connect();
      // pool.end() resolves before its connections have closed; terminating one
      // that is still closing (DROP ... FORCE) raises an uncaught client error.
      for (let i = 0; i < 40; i++) {
        const n = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1`, [name])).rows[0]!.n;
        if (n === 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}

/** Runs fn in a transaction as the given user (the only context passed to the DB). */
export async function asUser<T>(
  pool: pg.Pool,
  userId: string,
  fn: (c: pg.PoolClient) => Promise<T>,
  commit = false,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('eureka.user_id', $1, true)", [userId]);
    const out = await fn(c);
    await c.query(commit ? "COMMIT" : "ROLLBACK");
    return out;
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

/**
 * Runs `sql` as eureka_app for `userId` with function tracking on and returns
 * how often authz.owned_candidate_ids ran for it (rule 3: once per statement,
 * never per row) and how many rows came back. Needs the superuser pool
 * (track_functions is superuser-only); always rolled back.
 */
export async function ownedCandidateCalls(admin: pg.Pool, userId: string, sql: string): Promise<{ calls: number; rows: number }> {
  const c = await admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL track_functions = 'all'");
    await c.query("SELECT set_config('eureka.user_id', $1, true)", [userId]);
    // The "xact" counter holds pending counts that may span earlier transactions
    // on this backend (PostgreSQL 15+ flushes them lazily), so take a delta.
    const count = async () => Number((await c.query<{ n: string | null }>(
      `SELECT pg_stat_get_xact_function_calls('authz.owned_candidate_ids(text)'::regprocedure) AS n`)).rows[0]!.n ?? 0);
    const before = await count();
    await c.query("SET LOCAL ROLE eureka_app");
    const rows = (await c.query(sql)).rowCount ?? 0;
    await c.query("RESET ROLE");
    return { calls: (await count()) - before, rows };
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    c.release();
  }
}
