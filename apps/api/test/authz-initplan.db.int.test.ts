import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./db-harness.js";
import { U, seedFixtures } from "./fixtures.js";

/**
 * Migration 0082: the authz functions evaluate authz.current_user_id() once
 * per call (an InitPlan), so the number of authz calls a statement makes does
 * not depend on how the planner reads the access tables. Before 0082,
 * authz.grants called it once per user_role row whenever user_role was
 * seq-scanned, which an (auto)analyze of that table switched on. The DataHub
 * folder sets inlined their `me` CTE, so the caller's scope ran per folder.
 */
let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

const ACCESS_TABLES = ["eureka.user_role", "eureka.app_user", "eureka.role", "eureka.role_permission",
  "eureka.reporting_closure", "eureka.team", "eureka.team_member", "eureka.coach_assignment"];
const SCANS = {
  "index scans": ["SET LOCAL enable_seqscan = off"],
  "seq scans": ["SET LOCAL enable_indexscan = off", "SET LOCAL enable_indexonlyscan = off", "SET LOCAL enable_bitmapscan = off"],
} as const;
const STATEMENTS = [
  `SELECT id FROM eureka.candidate ORDER BY id`,
  `SELECT authz.actor_team() AS a, authz.coached_team_ids('candidate:read') AS b, authz.hotlist_open() AS c`,
];
const USERS = ["ceo", "m1", "l1", "r1a", "coach", "locA", "hr"] as const;

/** authz.* calls (nested ones included) and the result of `sql` as eureka_app for `userId`; rolled back. */
async function measure(userId: string, sql: string, planner: readonly string[] = []): Promise<{ calls: number; result: string }> {
  const c = await db.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL track_functions = 'all'");
    await c.query("SELECT set_config('eureka.user_id', $1, true)", [userId]);
    for (const s of planner) await c.query(s);
    const count = async () => Number((await c.query<{ n: string }>(
      `SELECT coalesce(sum(pg_stat_get_xact_function_calls(p.oid)), 0)::bigint AS n
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'authz'`)).rows[0]!.n);
    const before = await count();
    await c.query("SET LOCAL ROLE eureka_app");
    const result = JSON.stringify((await c.query(sql)).rows);
    await c.query("RESET ROLE");
    return { calls: (await count()) - before, result };
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    c.release();
  }
}

describe("authz.current_user_id() is evaluated once per authz call (0082)", () => {
  it.each(USERS)("calls and results for %s are the same with index scans and with seq scans of the access tables", async (key) => {
    for (const sql of STATEMENTS) {
      const idx = await measure(U[key], sql, SCANS["index scans"]);
      const seq = await measure(U[key], sql, SCANS["seq scans"]);
      expect(idx.calls, sql).toBeGreaterThan(0);
      expect(seq.result, sql).toBe(idx.result);
      expect(seq.calls, sql).toBe(idx.calls);
    }
  });

  it.each(USERS)("calls and results for %s are the same before and after ANALYZE of the access tables", async (key) => {
    for (const sql of STATEMENTS) {
      const before = await measure(U[key], sql);
      await db.admin.query(`ANALYZE ${ACCESS_TABLES.join(", ")}`);
      const after = await measure(U[key], sql);
      expect(after.result, sql).toBe(before.result);
      expect(after.calls, sql).toBe(before.calls);
    }
  });

  it("authz.grants calls current_user_id once per call, however user_role is read", async () => {
    for (const planner of Object.values(SCANS)) {
      const c = await db.admin.connect();
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL track_functions = 'all'");
        await c.query("SELECT set_config('eureka.user_id', $1, true)", [U.l1]);
        for (const s of planner) await c.query(s);
        const n = async () => Number((await c.query<{ n: string | null }>(
          `SELECT pg_stat_get_xact_function_calls('authz.current_user_id()'::regprocedure) AS n`)).rows[0]!.n ?? 0);
        const before = await n();
        const rows = (await c.query(`SELECT * FROM authz.grants('candidate:read')`)).rowCount;
        expect(rows).toBeGreaterThan(0);
        expect(await n() - before).toBe(1);
      } finally {
        await c.query("ROLLBACK").catch(() => undefined);
        c.release();
      }
    }
  });

  // The functions added since (jobs, chat, training, DataHub) read tables the
  // fixtures leave empty, where call counts differ between plans only by which
  // InitPlans an empty scan never needs, so for them the rule is checked on the
  // function text: no SQL function in authz or eureka filters on the bare call.
  it("no SQL function filters a query on bare authz.current_user_id()", async () => {
    const { rows } = await db.admin.query<{ fn: string }>(`
      SELECT p.oid::regprocedure::text AS fn FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
      WHERE n.nspname IN ('authz', 'eureka') AND l.lanname = 'sql'
        AND p.prosrc ~* '(=|\\mwhere|\\mand|\\mor|\\mon|\\mnot)\\s+authz\\.current_user_id\\(\\)'
      ORDER BY 1`);
    expect(rows.map((r) => r.fn)).toEqual([]);
  });

  it.each(["hr", "admin", "r1a"] as const)("DataHub folder sets for %s make the same authz calls for 10 and for 40 folders", async (key) => {
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL track_functions = 'all'");
      const addFolders = async (n: number) => {
        await c.query("SET LOCAL session_replication_role = replica");
        await c.query(`INSERT INTO eureka.datahub_folder (name, level, created_by, updated_by)
          SELECT 'f' || g || '-' || $1, 'internal', $2, $2 FROM generate_series(1, $1::int) g`, [n, U.admin]);
        await c.query("SET LOCAL session_replication_role = origin");
      };
      const measureFolders = async () => {
        await c.query("SELECT set_config('eureka.user_id', $1, true)", [U[key]]);
        const count = async () => Number((await c.query<{ n: string }>(
          `SELECT coalesce(sum(pg_stat_get_xact_function_calls(p.oid)), 0)::bigint AS n
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'authz'`)).rows[0]!.n);
        const before = await count();
        await c.query("SET LOCAL ROLE eureka_app");
        const r = (await c.query(`SELECT authz.datahub_readable_folders() AS r, authz.datahub_managed_folders() AS m`)).rows[0];
        await c.query("RESET ROLE");
        return { calls: (await count()) - before, readable: (r.r as string[]).length, managed: (r.m as string[]).length };
      };
      await addFolders(10);
      const one = await measureFolders();
      await addFolders(30);
      const two = await measureFolders();
      expect(one.calls).toBeGreaterThan(0);
      expect(two.readable).toBe(one.readable * 4);
      expect(two.managed).toBe(one.managed * 4);
      expect(two.calls).toBe(one.calls);
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  });
});
