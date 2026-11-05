import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { LOC, TECH_ID, U, seedFixtures, type FixtureCandidate } from "./fixtures.js";

/**
 * R-12 / C-03 (migration 0506): bulk flows defer the reporting-closure rebuild and do it once
 * (authz.reporting_closure_defer / flush, commit-time constraint trigger), with the per-row cycle
 * check kept. D-04: authz.set_batch_students.
 */
let db: TestDb;
let candidates: FixtureCandidate[];
const N = 50;
const extra = Array.from({ length: N }, (_, i) => `00000000-0000-4000-8000-${(900 + i).toString().padStart(12, "0")}`);

beforeAll(async () => {
  db = await createTestDb();
  candidates = await seedFixtures(db.admin);
  // track_functions is superuser-only: on for every new connection of this database (the app pool connects lazily).
  await db.admin.query(`ALTER DATABASE ${db.name} SET track_functions = 'all'`);
  for (const [i, id] of extra.entries()) {
    await db.admin.query(`INSERT INTO eureka.app_user (id, email, display_name) VALUES ($1, $2, $3)`, [id, `x${i}@eureka.example`, `x${i}`]);
    await db.admin.query(`INSERT INTO eureka.reporting_line (user_id, manager_id) VALUES ($1, $2)`, [id, U.ad]);
  }
});

afterAll(async () => {
  await db?.drop();
});

/** Calls of eureka.reporting_closure_rebuild on this backend (pending counts span transactions: take deltas). */
const rebuilds = async (c: pg.PoolClient) => Number((await c.query<{ n: string | null }>(
  `SELECT pg_stat_get_xact_function_calls('eureka.reporting_closure_rebuild()'::regprocedure) AS n`)).rows[0]!.n ?? 0);

/** Closure rows that differ from the closure recomputed from the current reporting lines (both directions). */
const closureDiff = async (c: pg.PoolClient | pg.Pool) => (await c.query(`
  WITH RECURSIVE x(anc, des, d) AS (
    SELECT rl.manager_id, rl.user_id, 1 FROM eureka.reporting_line rl WHERE rl.valid @> now()
    UNION ALL
    SELECT rl.manager_id, x.des, x.d + 1 FROM x JOIN eureka.reporting_line rl ON rl.user_id = x.anc AND rl.valid @> now() WHERE x.d < 64),
  want AS (SELECT anc, des, min(d) AS d FROM x GROUP BY anc, des),
  have AS (SELECT ancestor_id AS anc, descendant_id AS des, depth AS d FROM eureka.reporting_closure)
  (SELECT 'missing' AS k, * FROM (SELECT * FROM want EXCEPT SELECT * FROM have) a)
  UNION ALL
  (SELECT 'extra', * FROM (SELECT * FROM have EXCEPT SELECT * FROM want) b)`)).rows;

const ancestors = async (c: pg.PoolClient | pg.Pool, id: string) => (await c.query<{ a: string }>(
  `SELECT ancestor_id AS a FROM eureka.reporting_closure WHERE descendant_id = $1 ORDER BY depth`, [id])).rows.map((r) => r.a);

describe("reporting closure rebuilt once per bulk transaction", () => {
  it("a 50-move org-chart batch rebuilds once, at the flush, and the closure is right in and after the transaction", async () => {
    await asUser(db.app, U.admin, async (c) => {
      const before = await rebuilds(c);
      await c.query(`SELECT authz.reporting_closure_defer()`);
      // A chain under m2: x0 -> m2, x1 -> x0, ... x49 -> x48 (depth 53 from the CEO).
      for (const [i, id] of extra.entries()) {
        await c.query(`SELECT authz.org_chart_move($1, $2)`, [id, i === 0 ? U.m2 : extra[i - 1]]);
      }
      expect(await rebuilds(c) - before).toBe(0); // deferred: nothing rebuilt yet
      expect(await ancestors(c, extra[49]!)).toEqual([U.ad, U.ceo]); // stale until the flush
      await c.query(`SELECT authz.reporting_closure_flush()`);
      expect(await rebuilds(c) - before).toBe(1);
      // Later statements of the same transaction see the new closure.
      expect(await closureDiff(c)).toEqual([]);
      expect((await ancestors(c, extra[49]!)).slice(0, 3)).toEqual([extra[48], extra[47], extra[46]]);
      expect(await ancestors(c, extra[49]!)).toHaveLength(N + 2);
    }, true);
    expect(await closureDiff(db.admin)).toEqual([]);
    expect(await ancestors(db.admin, extra[0]!)).toEqual([U.m2, U.ad, U.ceo]);
    expect((await db.admin.query(`SELECT count(*)::int AS n FROM authz.reporting_closure_pending`)).rows[0].n).toBe(0);
  });

  it("without the deferral every move rebuilds, as before", async () => {
    await asUser(db.app, U.admin, async (c) => {
      const before = await rebuilds(c);
      for (const id of extra.slice(0, 5)) await c.query(`SELECT authz.org_chart_move($1, $2)`, [id, U.m1]);
      expect(await rebuilds(c) - before).toBeGreaterThanOrEqual(5);
      expect(await closureDiff(c)).toEqual([]);
    });
  });

  it("a loop is still refused on the move that closes it, as 'cycle'", async () => {
    await asUser(db.app, U.admin, async (c) => {
      await c.query(`SELECT authz.reporting_closure_defer()`);
      await c.query(`SAVEPOINT a`);
      // m2 is above x0 (committed above): putting m2 under x10 closes a loop.
      await expect(c.query(`SELECT authz.org_chart_move($1, $2)`, [U.m2, extra[10]])).rejects.toThrow(/^cycle$/);
      await c.query(`ROLLBACK TO SAVEPOINT a`);
      // A loop made of two moves of the same batch: x1 -> l3, then l3 -> x1.
      await c.query(`SELECT authz.org_chart_move($1, $2)`, [extra[1], U.l3]);
      await expect(c.query(`SELECT authz.org_chart_move($1, $2)`, [U.l3, extra[1]])).rejects.toThrow(/^cycle$/);
    });
    // Team adds (0370 trigger) and the bulk manager function report it the same way.
    await asUser(db.app, U.admin, async (c) => {
      await c.query(`SELECT authz.reporting_closure_defer()`);
      await expect(c.query(`SELECT authz.admin_bulk_set_managers($1::uuid[], $2::uuid[])`, [[extra[0], U.m2], [extra[1], extra[5]]]))
        .rejects.toThrow(/^cycle$/);
    });
  });

  it("a transaction that never flushes is rebuilt once at commit (constraint trigger)", async () => {
    await asUser(db.app, U.admin, async (c) => {
      await c.query(`SELECT authz.reporting_closure_defer()`);
      for (const id of extra.slice(20, 30)) await c.query(`SELECT authz.org_chart_move($1, $2)`, [id, U.l3]);
    }, true);
    expect(await closureDiff(db.admin)).toEqual([]);
    expect(await ancestors(db.admin, extra[25]!)).toEqual([U.l3, U.m2, U.ad, U.ceo]);
    expect((await db.admin.query(`SELECT count(*)::int AS n FROM authz.reporting_closure_pending`)).rows[0].n).toBe(0);
  });

  it("a change rolled back to its savepoint leaves nothing pending; ending lines only is rebuilt too", async () => {
    await asUser(db.app, U.admin, async (c) => {
      await c.query(`SELECT authz.reporting_closure_defer()`);
      await c.query(`SAVEPOINT a`);
      await c.query(`SELECT authz.org_chart_move($1, $2)`, [extra[40], U.m1]);
      await c.query(`ROLLBACK TO SAVEPOINT a`);
      let before = await rebuilds(c);
      await c.query(`SELECT authz.reporting_closure_flush()`);
      expect(await rebuilds(c) - before).toBe(0); // nothing pending any more
      await c.query(`SELECT authz.reporting_closure_defer()`);
      before = await rebuilds(c);
      await c.query(`SELECT authz.org_chart_move($1, NULL)`, [extra[41]]); // UPDATE only (no new line)
      expect(await rebuilds(c) - before).toBe(0);
      await c.query(`SELECT authz.reporting_closure_flush()`);
      expect(await rebuilds(c) - before).toBe(1);
      expect(await ancestors(c, extra[41]!)).toEqual([]);
      expect(await closureDiff(c)).toEqual([]);
    }, true);
    expect(await closureDiff(db.admin)).toEqual([]);
  });

  it("deferring needs access:manage; the app cannot touch the pending marker or call the rebuild", async () => {
    await expect(asUser(db.app, U.m1, (c) => c.query(`SELECT authz.reporting_closure_defer()`))).rejects.toThrow(/not_permitted/);
    await expect(asUser(db.app, U.admin, (c) => c.query(`DELETE FROM authz.reporting_closure_pending`))).rejects.toThrow(/permission denied/);
    await expect(asUser(db.app, U.admin, (c) => c.query(`SELECT eureka.reporting_closure_rebuild()`))).rejects.toThrow(/permission denied/);
    await expect(asUser(db.app, U.admin, (c) => c.query(`SELECT eureka.reporting_closure_settle()`))).rejects.toThrow(/permission denied/);
    // Flushing with nothing pending does nothing.
    await asUser(db.app, U.m1, async (c) => {
      const before = await rebuilds(c);
      await c.query(`SELECT authz.reporting_closure_flush()`);
      expect(await rebuilds(c) - before).toBe(0);
    });
    // A session that sets the flag itself and never flushes still gets its rebuild at commit.
    await asUser(db.app, U.admin, async (c) => {
      await c.query(`SELECT set_config('eureka.closure_defer', pg_current_xact_id()::text, true)`);
      await c.query(`SELECT authz.org_chart_move($1, $2)`, [extra[45], U.l1]);
    }, true);
    expect(await ancestors(db.admin, extra[45]!)).toEqual([U.l1, U.m1, U.ad, U.ceo]);
    expect(await closureDiff(db.admin)).toEqual([]);
  });

  it("new functions are hardened (rule 2)", async () => {
    const { rows } = await db.admin.query<{ f: string; cfg: string[] | null; acl: string | null }>(
      `SELECT p.oid::regprocedure::text AS f, p.proconfig AS cfg, p.proacl::text AS acl FROM pg_proc p
        WHERE p.oid::regprocedure::text IN ('authz.reporting_closure_defer()', 'authz.reporting_closure_flush()',
          'authz.set_batch_students(uuid,uuid[])', 'eureka.reporting_closure_rebuild()', 'eureka.reporting_closure_settle()')`);
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(r.cfg).toEqual(["search_path=pg_catalog, pg_temp"]);
      expect(r.acl ?? "").not.toMatch(/(^|[{,])=X/); // no PUBLIC execute
    }
  });
});

describe("authz.set_batch_students (D-04)", () => {
  let month = 0;
  const batch = (status = "planned") => asUser(db.app, U.locD, async (c) => {
    const id = (await c.query<{ id: string }>(`SELECT authz.create_batch($1, $2, make_date(2040, $3, 1), 20) AS id`,
      [LOC.dallas, TECH_ID, ++month])).rows[0]!.id;
    if (status !== "planned") await c.query(`SELECT authz.set_batch_status($1, $2)`, [id, status]);
    return id;
  }, true);
  const NOBODY = "99999999-9999-4999-8999-999999999999";

  it("adds the eligible, skips the rest, in request order, as authz.set_batch_student would", async () => {
    const id = await batch();
    const mine = candidates.filter((c) => c.recruiterId === U.r1a && c.locationId === LOC.dallas).slice(0, 3).map((c) => c.id);
    const austin = candidates.find((c) => c.locationId === LOC.austin && c.recruiterId === U.r1a)!.id;
    const other = candidates.find((c) => c.recruiterId === U.r3a && c.locationId === LOC.dallas)!.id; // l1 does not own it
    const rows = await asUser(db.app, U.l1, async (c) => (await c.query(
      `SELECT candidate_id, outcome FROM authz.set_batch_students($1, $2::uuid[])`,
      [id, [mine[0], austin, mine[1], NOBODY, mine[0], other, mine[2]]])).rows, true);
    expect(rows).toEqual([
      { candidate_id: mine[0], outcome: "added" }, { candidate_id: austin, outcome: "skipped" },
      { candidate_id: mine[1], outcome: "added" }, { candidate_id: NOBODY, outcome: "skipped" },
      { candidate_id: other, outcome: "skipped" }, { candidate_id: mine[2], outcome: "added" },
    ]);
    expect((await db.admin.query(`SELECT count(*)::int AS n FROM eureka.candidate WHERE batch_id = $1`, [id])).rows[0].n).toBe(3);
    // Already in the batch: still 'added' (no-op), as the single function returns without error.
    const again = await asUser(db.app, U.l1, async (c) => (await c.query(
      `SELECT outcome FROM authz.set_batch_students($1, $2::uuid[])`, [id, [mine[0]]])).rows);
    expect(again).toEqual([{ outcome: "added" }]);
  });

  it("refuses unknown or invisible batches (404), callers who cannot staff it (403), closed batches and NULLs", async () => {
    const id = await batch();
    const mine = candidates.find((c) => c.recruiterId === U.r1a && c.locationId === LOC.dallas)!.id;
    const run = (user: string, b: string, ids: unknown) => asUser(db.app, user, (c) =>
      c.query(`SELECT * FROM authz.set_batch_students($1, $2::uuid[])`, [b, ids]));
    await expect(run(U.l1, NOBODY, [mine])).rejects.toThrow(/batch_not_found/);
    await expect(run(U.coach, id, [mine])).rejects.toThrow(/batch_not_found/);
    await expect(run(U.l1, id, null)).rejects.toThrow(/invalid_change/);
    await expect(run(U.l1, id, [mine, null])).rejects.toThrow(/invalid_change/);
    const closed = await batch("cancelled");
    await expect(run(U.l1, closed, [mine])).rejects.toThrow(/batch_closed/);
    // Nobody eligible: nothing to add, so a closed batch only reports skips.
    expect((await run(U.l1, closed, [NOBODY])).rows).toEqual([{ candidate_id: NOBODY, outcome: "skipped" }]);
  });

  it("two overlapping bulk adds in opposite order do not deadlock", async () => {
    const id = await batch();
    const dallas = candidates.filter((c) => c.locationId === LOC.dallas).map((c) => c.id);
    const run = (ids: string[]) => asUser(db.app, U.ceo, async (c) => (await c.query(
      `SELECT outcome FROM authz.set_batch_students($1, $2::uuid[])`, [id, ids])).rows, true);
    const [a, b] = await Promise.all([run(dallas), run([...dallas].reverse())]);
    expect(a.every((r) => r.outcome === "added")).toBe(true);
    expect(b.every((r) => r.outcome === "added")).toBe(true);
    expect((await db.admin.query(`SELECT count(*)::int AS n FROM eureka.candidate WHERE batch_id = $1`, [id])).rows[0].n).toBe(dallas.length);
  });
});
