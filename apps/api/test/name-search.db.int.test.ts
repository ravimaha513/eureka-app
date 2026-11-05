import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { likeContains, nameSearch, personName } from "../src/platform/sql.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { U, seedFixtures } from "./fixtures.js";

/**
 * R-13 (migration 0509): a GIN trigram index on the exact full-name expression the searches use.
 * Plans are EXPLAINed without ANALYZE and with enable_seqscan off, so the assertions do not depend on
 * the fixture's (small) table sizes; docs/backend-audit/perf-baseline.md has the measured plans on
 * 50k candidates, including why the eureka_app (RLS) list paths cannot use the index.
 */
let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
}, 60_000);

afterAll(async () => {
  await db?.drop();
});

type As = { app: string } | { role: string; user: string };

/** Runs fn in a rolled-back transaction as eureka_app for a user, or as `role` (from the superuser pool). */
async function inContext<T>(as: As, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  if ("app" in as) return asUser(db.app, as.app, fn);
  const c = await db.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('eureka.user_id', $1, true)", [as.user]);
    await c.query(`SET LOCAL ROLE ${as.role}`);
    return await fn(c);
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
}

const plan = (sql: string, params: unknown[], as: As) => inContext(as, async (c) => {
  await c.query("SET LOCAL enable_seqscan = off");
  return (await c.query<Record<string, string>>(`EXPLAIN ${sql}`, params)).rows.map((r) => r["QUERY PLAN"]).join("\n");
});

const PERSON_SEARCH = `SELECT p.id FROM eureka.person p WHERE ${nameSearch("p", "$1")}`;
const CANDIDATE_SEARCH = `SELECT c.id FROM eureka.candidate c JOIN eureka.person p ON p.id = c.person_id
  WHERE ${nameSearch("p", "$1")} ORDER BY c.id`;
const DEFINER = { role: "authz_definer", user: U.ceo };

describe("name search index (R-13, migration 0509)", () => {
  it("the trigram indexes are built on exactly the expression the queries use", async () => {
    const { rows } = await db.admin.query<{ indexrelid: string; def: string }>(
      `SELECT indexrelid::regclass::text AS indexrelid, pg_get_indexdef(indexrelid) AS def FROM pg_index
       WHERE indexrelid IN ('eureka.person_name_trgm'::regclass, 'eureka.applicant_name_trgm'::regclass) ORDER BY 1`);
    expect(rows.map((r) => r.indexrelid)).toEqual(["eureka.applicant_name_trgm", "eureka.person_name_trgm"]);
    for (const r of rows) {
      expect(r.def).toContain("USING gin");
      expect(r.def).toMatch(/\(\(\(first_name \|\| ' '::text\) \|\| last_name\)\) (public\.)?gin_trgm_ops/);
    }
    const ext = await db.admin.query("SELECT extnamespace::regnamespace::text AS s FROM pg_extension WHERE extname = 'pg_trgm'");
    expect(ext.rows).toEqual([{ s: "public" }]);
    expect(personName("p")).toBe("(p.first_name || ' ' || p.last_name)");
    expect(nameSearch("p", "$4")).toBe("(p.first_name || ' ' || p.last_name) ILIKE $4 ESCAPE '\\'");
  });

  it("the Hot List search (hotlist_page / hotlist_export run it as authz_definer) uses person_name_trgm", async () => {
    // Asked about the person side alone: on the ~100-row fixture a nested loop over candidate is cheapest
    // for the whole page query whatever the person index; perf-baseline.md has the full plans on 50k rows.
    expect(await plan(PERSON_SEARCH, [likeContains("Cand1")], DEFINER)).toMatch(/Bitmap Index Scan on person_name_trgm/);
  });

  it("an applicant name search uses applicant_name_trgm", async () => {
    const text = await plan(`SELECT ap.id FROM eureka.applicant ap WHERE ${nameSearch("ap", "$1")} LIMIT 50`,
      [likeContains("ada love")], DEFINER);
    expect(text).toMatch(/Bitmap Index Scan on applicant_name_trgm/);
  });

  it("documents the limit: as eureka_app the RLS security barrier keeps ILIKE (not leakproof) off the index", async () => {
    // person_read is a security qual. A user qual whose operator is not LEAKPROOF (~~* is not; only a
    // superuser could mark it) may not run before it, so it cannot become an index condition and the
    // eureka_app list endpoints still scan. If this starts failing, those paths can use the index now:
    // re-measure and update perf-baseline.md.
    const text = await plan(PERSON_SEARCH, [likeContains("Cand1")], { app: U.ceo });
    expect(text).not.toMatch(/person_name_trgm/);
    expect(text).toMatch(/Seq Scan on person p/);
  });

  it("the Hot List functions search the same indexed expression", async () => {
    const { rows } = await db.admin.query<{ proname: string; src: string }>(
      `SELECT proname, prosrc AS src FROM pg_proc WHERE pronamespace = 'authz'::regnamespace
         AND proname IN ('hotlist_page', 'hotlist_export') ORDER BY 1`);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.src).toContain(nameSearch("p", "$4::text"));
  });

  it("matching is unchanged on both paths: case-insensitive substring, wildcards literal, short terms allowed", async () => {
    const all = await asUser(db.app, U.ceo, async (c) =>
      (await c.query<{ id: string; n: string }>(`SELECT c.id, p.first_name || ' ' || p.last_name AS n FROM eureka.candidate c
         JOIN eureka.person p ON p.id = c.person_id ORDER BY c.id`)).rows);
    expect(all.length).toBeGreaterThan(0);
    const expected = (term: string) => all.filter((r) => r.n.toLowerCase().includes(term.toLowerCase())).map((r) => r.id);
    // The app path (RLS, scan) and the definer path with seq scans off (index) give the same rows.
    const ids = (term: string, as: As) => inContext(as, async (c) => {
      await c.query("SET LOCAL enable_seqscan = off");
      return (await c.query<{ id: string }>(CANDIDATE_SEARCH, [likeContains(term)])).rows.map((r) => r.id);
    });
    for (const term of ["cand1 TEST", "CAND", "nd1", "st", "t", "d1 t"]) {
      expect(await ids(term, { app: U.ceo }), term).toEqual(expected(term));
      expect(await ids(term, DEFINER), term).toEqual(expected(term));
    }
    expect(expected("d1 t").length).toBeGreaterThan(0);
    // An escaped % or _ is literal (no name contains one), not a wildcard.
    for (const as of [{ app: U.ceo }, DEFINER]) {
      expect(await ids("%", as)).toEqual([]);
      expect(await ids("Cand_", as)).toEqual([]);
    }
  });
});
