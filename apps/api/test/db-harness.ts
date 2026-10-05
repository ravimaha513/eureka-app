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

/**
 * Planner settings a rule-3 check runs under. Rule 3 must hold for every plan,
 * not just the one today's statistics happen to pick, so each check repeats
 * under forced join and scan strategies (they also apply to the plans inside
 * the authz functions; both measurements of one comparison use the same).
 * "nestloop off" is slow (hash and merge joins over the tiny access tables in
 * every authz call) and runs only with RULE3_EXHAUSTIVE=1 (docs/HANDOFF.md).
 */
export const PLANNER_VARIANTS: Record<string, readonly string[]> = {
  default: [],
  "nestloop only": ["SET LOCAL enable_hashjoin = off", "SET LOCAL enable_mergejoin = off"],
  "index scans off": ["SET LOCAL enable_indexscan = off", "SET LOCAL enable_indexonlyscan = off", "SET LOCAL enable_bitmapscan = off"],
  ...(process.env.RULE3_EXHAUSTIVE === "1" ? { "nestloop off": ["SET LOCAL enable_nestloop = off"] } : {}),
};

/** Calls of every authz.* function so far in this transaction (pending counters; take a delta). */
export async function authzCallCount(c: pg.PoolClient): Promise<number> {
  return Number((await c.query<{ n: string }>(
    `SELECT coalesce(sum(pg_stat_get_xact_function_calls(p.oid)), 0)::bigint AS n
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'authz'`)).rows[0]!.n);
}

export interface Rule3Probe {
  /** Calls of every authz.* function (nested ones included) while `sql` ran. */
  calls: number;
  /** Rows `sql` returned. */
  rows: number;
  /** Plan expressions that call an authz function outside an InitPlan, i.e. per row. */
  perRow: string[];
  /** InitPlans executed more than once (an InitPlan rescanned per outer row). */
  rescannedInitPlans: number;
}

interface PlanNode {
  "Node Type": string;
  "Parent Relationship"?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  Plans?: PlanNode[];
  [key: string]: unknown;
}

/**
 * Runs `sql` as eureka_app for `userId` under EXPLAIN ANALYZE with function
 * tracking and reports what rule 3 is about: how many authz.* calls it made,
 * where in the plan authz functions are called, and whether any InitPlan ran
 * more than once. Superuser pool; always rolled back. The plan-text match on
 * `authz.` is complete because RLS policies may call no other schema's
 * functions (checked from pg_depend in rls.int.test.ts).
 *
 * `analyze` lists the tables the measured statement and its policies read;
 * they are analyzed (committed) first. Since 0082 the authz functions make the
 * same calls whatever their plans, but which InitPlans a statement evaluates
 * still follows its own plan (an OR stops at the first true branch), and that
 * plan follows these tables' statistics. Refreshing them pins the plan to the
 * data: an autoanalyze landing between two measurements could otherwise switch
 * it. Tables this small are sampled completely, so a later autoanalyze of
 * unchanged data computes the same statistics.
 *
 * `setup` runs as superuser inside the rolled-back transaction before the
 * statement (a self-test uses it to install a deliberately per-row policy).
 */
export async function rule3Probe(
  admin: pg.Pool,
  userId: string,
  sql: string,
  opts: { analyze: readonly string[]; planner?: readonly string[]; setup?: readonly string[] },
): Promise<Rule3Probe> {
  if (opts.analyze.length > 0) await admin.query(`ANALYZE ${opts.analyze.join(", ")}`);
  const c = await admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL track_functions = 'all'");
    await c.query("SELECT set_config('eureka.user_id', $1, true)", [userId]);
    for (const s of opts.planner ?? []) await c.query(s);
    for (const s of opts.setup ?? []) await c.query(s);
    // Delta of the per-transaction counters (see ownedCandidateCalls).
    const count = () => authzCallCount(c);
    const before = await count();
    await c.query("SET LOCAL ROLE eureka_app");
    const res = await c.query<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(
      `EXPLAIN (ANALYZE, VERBOSE, TIMING OFF, SUMMARY OFF, FORMAT JSON) ${sql}`);
    await c.query("RESET ROLE");
    const calls = (await count()) - before;
    const root = res.rows[0]!["QUERY PLAN"][0].Plan;
    const perRow: string[] = [];
    let rescannedInitPlans = 0;
    const walk = (n: PlanNode) => {
      const initPlan = n["Parent Relationship"] === "InitPlan";
      if (initPlan && (n["Actual Loops"] ?? 0) > 1) rescannedInitPlans++;
      for (const [k, v] of Object.entries(n)) {
        if (k === "Plans") continue;
        const text = typeof v === "string" ? v : Array.isArray(v) ? v.join(" ") : "";
        // An InitPlan's own output is the once-per-statement call rule 3 asks for.
        if (/\bauthz\./.test(text) && !(initPlan && k === "Output")) perRow.push(`${n["Node Type"]} ${k}: ${text}`);
      }
      for (const child of n.Plans ?? []) walk(child);
    };
    walk(root);
    return { calls, rows: root["Actual Rows"] ?? 0, perRow, rescannedInitPlans };
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    c.release();
  }
}
