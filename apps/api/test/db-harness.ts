import pg from "pg";
import { migrate } from "../src/db/migrate.js";

const ADMIN_BASE = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432";
const APP_PASSWORD = "eureka_app_test";

export interface TestDb {
  name: string;
  admin: pg.Pool;
  app: pg.Pool;
  worker: pg.Pool;
  drop(): Promise<void>;
}

/** Creates a fresh database, applies all migrations and returns pools per role. */
export async function createTestDb(): Promise<TestDb> {
  const name = `eureka_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const root = new pg.Client({ connectionString: `${ADMIN_BASE}/postgres` });
  await root.connect();
  await root.query(`CREATE DATABASE ${name}`);
  await root.end();

  await migrate(`${ADMIN_BASE}/${name}`);

  const admin = new pg.Pool({ connectionString: `${ADMIN_BASE}/${name}`, max: 4 });
  await admin.query(`ALTER ROLE eureka_app PASSWORD '${APP_PASSWORD}'`);
  await admin.query(`ALTER ROLE eureka_worker PASSWORD '${APP_PASSWORD}'`);
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
