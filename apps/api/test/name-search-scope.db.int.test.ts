import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { likeContains, nameMatch, nameSearch, scopedNameSearch, trigramUsable } from "../src/platform/sql.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { T, U, seedFixtures, type FixtureCandidate } from "./fixtures.js";
import { seedPipeline } from "./pipeline-seed.js";
import { candidateNameMatch } from "../src/modules/interviews/interviews.service.js";

/**
 * R-13b / E-09 (docs/backend-audit/perf-baseline.md "R-13b"): the scoped name-match functions are
 * differential-tested against RLS. authz.person_name_matches must return exactly the persons whose
 * name matches AND that person_read lets the caller read, for every seeded user; it must never name a
 * person outside that scope. authz.interview_name_candidate_ids must give the Interviews board the
 * same rows as its per-row name predicate, and reveal nothing the board does not already show.
 */
let db: TestDb;
let candidates: FixtureCandidate[];
const COORD = "00000000-0000-4000-8000-0000000000c1";
const NOBODY = "00000000-0000-4000-8000-0000000000c2";
const USERS = [...Object.values(U), COORD, NOBODY];
const TERMS = ["cand", "Cand1", "CAND2 test", "test", "nd3", "d1 t", "zzz", "%", "Cand_", "Orphan", "Shared"];
let shared: FixtureCandidate;

beforeAll(async () => {
  db = await createTestDb();
  candidates = await seedFixtures(db.admin);
  await seedPipeline(db, candidates);
  const c = await db.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica"); // shape data directly (guards off)
    // An interview coordinator: interview:read at org, no candidate:read (0141).
    await c.query(`INSERT INTO eureka.app_user (id, email, display_name) VALUES ($1, 'coord@eureka.example', 'coord')`, [COORD]);
    await c.query(`INSERT INTO eureka.user_role (user_id, role_key) VALUES ($1, 'interview_coordinator')`, [COORD]);
    // A person with no candidate: person_read never shows it, so the function must not either.
    await c.query(`INSERT INTO eureka.person (first_name, last_name) VALUES ('Orphan', 'Cand1 Test')`);
    // A "selected teams" candidate shared with team 2 (exercises the shared_candidate_ids branch).
    shared = candidates.find((x) => x.teamId === T.t3 && x.visibility === "team" && x.marketingStatus === "active")!;
    await c.query(`UPDATE eureka.candidate SET visibility = 'selected_teams' WHERE id = $1`, [shared.id]);
    await c.query(`INSERT INTO eureka.candidate_team_share (candidate_id, team_id, shared_by) VALUES ($1, $2, $3)`, [shared.id, T.t2, U.l3]);
    await c.query(`UPDATE eureka.person SET first_name = 'Shared' WHERE id = (SELECT person_id FROM eureka.candidate WHERE id = $1)`, [shared.id]);
    await c.query("COMMIT");
  } finally {
    c.release();
  }
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

const sorted = (xs: string[]) => [...xs].sort();

async function asApp<T>(userId: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  if (userId) return asUser(db.app, userId, fn);
  const c = await db.app.connect();
  try {
    await c.query("BEGIN");
    return await fn(c);
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
}

describe("authz.person_name_matches = person_read + name ILIKE (differential, R-13b)", () => {
  it.each(USERS)("for user %s, every term", async (userId) => {
    await asApp(userId, async (c) => {
      for (const term of TERMS) {
        const pat = likeContains(term);
        const rls = (await c.query<{ id: string }>(`SELECT p.id FROM eureka.person p WHERE ${nameSearch("p", "$1")}`, [pat])).rows.map((r) => r.id);
        const fn = (await c.query<{ ids: string[] }>(`SELECT authz.person_name_matches($1) AS ids`, [pat])).rows[0]!.ids;
        expect(sorted(fn), `${userId} ${term}`).toEqual(sorted(rls));
      }
    });
  });

  it("covers the scope branches: some users see a strict subset, the shared candidate only through its share", async () => {
    const count = (u: string, term: string) => asApp(u, async (c) =>
      (await c.query<{ n: number }>(`SELECT cardinality(authz.person_name_matches($1)) AS n`, [likeContains(term)])).rows[0]!.n);
    const all = await count(U.ceo, "cand");
    expect(all).toBeGreaterThan(0);
    expect(await count(U.r1a, "cand")).toBeLessThan(all);
    expect(await count(U.admin, "cand")).toBe(0); // org_admin reads no business rows
    expect(await count(U.r2a, "Shared")).toBe(1); // team 2 via candidate_team_share
    expect(await count(U.r1a, "Shared")).toBe(0);
    expect(await count(U.ceo, "Orphan")).toBe(0); // no candidate: not readable
  });

  it("no user, unknown user, NULL pattern: empty", async () => {
    for (const u of [null, NOBODY]) {
      expect(await asApp(u, async (c) => (await c.query(`SELECT authz.person_name_matches('%cand%') AS ids`)).rows[0].ids)).toEqual([]);
    }
    expect(await asApp(U.ceo, async (c) => (await c.query(`SELECT authz.person_name_matches(NULL) AS ids`)).rows[0].ids)).toEqual([]);
  });

  it("list SQL with the id set returns the same rows as the ILIKE alone, for every user", async () => {
    const list = (where: string) => `SELECT c.id FROM eureka.candidate c JOIN eureka.person p ON p.id = c.person_id WHERE ${where} ORDER BY c.id`;
    for (const userId of USERS) {
      await asApp(userId, async (c) => {
        for (const term of TERMS) {
          const pat = [likeContains(term)];
          const a = (await c.query(list(nameSearch("p", "$1")), pat)).rows;
          const b = (await c.query(list(`${nameSearch("p", "$1")} AND ${nameMatch("p.id", "$1")}`), pat)).rows;
          expect(b, `${userId} ${term}`).toEqual(a);
        }
      });
    }
  });

  it("the id set is an InitPlan (once per statement), and the trigram index serves the definer search", async () => {
    const text = await asApp(U.ceo, async (c) =>
      (await c.query<Record<string, string>>(`EXPLAIN SELECT c.id FROM eureka.candidate c JOIN eureka.person p ON p.id = c.person_id
         WHERE ${scopedNameSearch("p", "$1", "cand1")}`, [likeContains("cand1")])).rows.map((r) => r["QUERY PLAN"]).join("\n"));
    expect(text).toMatch(/InitPlan \d+ \(returns \$\d+\)/);
    expect(text).not.toMatch(/Filter:.*person_name_matches/);
    // The function's own search as authz_definer (EXECUTE ... USING) can use person_name_trgm.
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE authz_definer");
      // Plans on a handful of fixture rows follow the table statistics: with only seq scans off, a
      // planner may walk person_pkey and filter instead (CI did). With plain index scans off too, the
      // name condition can only be applied through an index that matches it: person_name_trgm.
      await c.query("SET LOCAL enable_seqscan = off");
      await c.query("SET LOCAL enable_indexscan = off");
      const p = (await c.query<Record<string, string>>(`EXPLAIN SELECT p.id FROM eureka.person p
        WHERE ${nameSearch("p", "$1::text")} AND EXISTS (SELECT 1 FROM eureka.candidate c WHERE c.person_id = p.id)`, [likeContains("cand1")]))
        .rows.map((r) => r["QUERY PLAN"]).join("\n");
      expect(p).toMatch(/Bitmap Index Scan on person_name_trgm/);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });

  it("pins the policies the function mirrors: change person_name_matches together with them", async () => {
    const { rows } = await db.admin.query<{ policyname: string; qual: string }>(
      `SELECT policyname, qual FROM pg_policies WHERE schemaname = 'eureka'
         AND ((tablename = 'person' AND policyname = 'person_read') OR (tablename = 'candidate' AND policyname = 'candidate_read'))
       ORDER BY 1`);
    expect(rows.map((r) => r.policyname)).toEqual(["candidate_read", "person_read"]);
    const norm = (s: string) => s.replace(/\s+/g, " ");
    expect(norm(rows[0]!.qual)).toBe(norm(`(( SELECT authz.has_org('candidate:read'::text) AS has_org) OR (recruiter_id = ANY (( SELECT authz.recruiter_ids('candidate:read'::text) AS recruiter_ids)::uuid[])) OR (team_id = ANY (( SELECT authz.team_ids('candidate:read'::text) AS team_ids)::uuid[])) OR (location_id = ANY (( SELECT authz.location_ids('candidate:read'::text) AS location_ids)::uuid[])) OR (( SELECT authz.all_teams('candidate:read'::text) AS all_teams) AND (visibility = 'all_teams'::text) AND (marketing_status = ANY (ARRAY['active'::text, 'full_of_interviews'::text]))) OR (id IN ( SELECT unnest(( SELECT authz.shared_candidate_ids('candidate:read'::text) AS shared_candidate_ids)) AS unnest)))`));
    expect(norm(rows[1]!.qual)).toBe(norm(`(EXISTS ( SELECT 1 FROM eureka.candidate c WHERE (c.person_id = person.id)))`));
    // eureka_app has no other read policy on person or candidate that the function would miss.
    const others = await db.admin.query(`SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'eureka'
      AND tablename IN ('person', 'candidate') AND cmd IN ('SELECT', 'ALL') AND 'eureka_app' = ANY (roles)
      AND policyname NOT IN ('person_read', 'candidate_read')`);
    expect(others.rows).toEqual([]);
  });

  it("is hardened: definer, pinned search_path, EXECUTE for eureka_app only", async () => {
    const { rows } = await db.admin.query<{ proname: string; prosecdef: boolean; proconfig: string[]; acl: string }>(
      `SELECT proname, prosecdef, proconfig, proacl::text AS acl FROM pg_proc WHERE pronamespace = 'authz'::regnamespace
         AND proname IN ('person_name_matches', 'interview_name_candidate_ids') ORDER BY 1`);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.prosecdef).toBe(true);
      expect(r.proconfig).toEqual(["search_path=pg_catalog, pg_temp"]);
      expect(r.acl).not.toMatch(/(^|[{,])=X/); // no PUBLIC
      expect(r.acl.match(/(\w+)=X/g)?.sort()).toEqual(["authz_definer=X", "eureka_app=X"]);
    }
  });

  it("helpers: the id set is only added when the term has a full trigram", () => {
    expect(trigramUsable("ab")).toBe(false);
    expect(trigramUsable("a b c")).toBe(false);
    expect(trigramUsable("abc")).toBe(true);
    expect(trigramUsable("Zoë")).toBe(true);
    expect(scopedNameSearch("p", "$2", "ab")).toBe(nameSearch("p", "$2"));
    expect(scopedNameSearch("p", "$2", "abc", "e.person_id"))
      .toBe(`${nameSearch("p", "$2")} AND e.person_id = ANY ((SELECT authz.person_name_matches($2::text))::uuid[])`);
  });
});

describe("authz.interview_name_candidate_ids (E-09)", () => {
  const CANDIDATE_NAME = `CASE WHEN p.id IS NOT NULL THEN p.first_name || ' ' || p.last_name ELSE authz.interview_candidate_name(i.id) END`;
  const board = (where: string) => `SELECT i.id FROM eureka.interview i
    LEFT JOIN eureka.candidate c ON c.id = i.candidate_id LEFT JOIN eureka.person p ON p.id = c.person_id
    WHERE ${where} ORDER BY i.starts_at, i.id`;
  const OLD = `(${CANDIDATE_NAME}) ILIKE $1 ESCAPE '\\'`;
  // The service's own SQL: the indexed form (a 3+ character term) and the walk form (short term, or under OR).
  const NEW_AND = candidateNameMatch("$1", "abc", true);
  const WALK = candidateNameMatch("$1", "ab", true);
  expect(NEW_AND).toMatch(/^\(i\.candidate_id = ANY \(\(SELECT authz\.interview_name_candidate_ids\(\$1::text\)\)::uuid\[\]\)/);
  expect(WALK).toMatch(/^\(CASE WHEN p\.id IS NOT NULL THEN .* ELSE i\.candidate_id IN \(SELECT pg_catalog\.unnest/);
  expect(candidateNameMatch("$1", "abc", false)).toBe(WALK);

  it.each(USERS)("board rows for user %s: new predicate = per-row predicate, and the set reveals nothing more", async (userId) => {
    await asApp(userId, async (c) => {
      const readable = new Set((await c.query<{ id: string }>(`SELECT id FROM eureka.candidate`)).rows.map((r) => r.id));
      const orgInterviews = (await c.query<{ o: boolean }>(`SELECT coalesce(authz.has_org('interview:read'), false) AS o`)).rows[0]!.o;
      const interviewed = new Set((await c.query<{ id: string }>(`SELECT DISTINCT candidate_id AS id FROM eureka.interview WHERE candidate_id IS NOT NULL`)).rows.map((r) => r.id));
      for (const term of TERMS) {
        const pat = [likeContains(term)];
        const old = (await c.query(board(OLD), pat)).rows;
        expect((await c.query(board(NEW_AND), pat)).rows, `${userId} ${term} AND`).toEqual(old);
        expect((await c.query(board(WALK), pat)).rows, `${userId} ${term} walk`).toEqual(old);
        expect((await c.query(board(`(${WALK} OR false)`), pat)).rows, `${userId} ${term} OR`).toEqual(old);
        const set = (await c.query<{ ids: string[] }>(`SELECT authz.interview_name_candidate_ids($1) AS ids`, pat)).rows[0]!.ids;
        for (const id of set) expect(readable.has(id) || (orgInterviews && interviewed.has(id)), `${userId} ${term} leaks ${id}`).toBe(true);
      }
    });
  });

  it("the coordinator finds interviews by candidate name although no candidate is readable", async () => {
    const pat = [likeContains("cand1")];
    await asApp(COORD, async (c) => {
      expect((await c.query(`SELECT id FROM eureka.candidate`)).rows).toEqual([]);
      const rows = (await c.query(board(NEW_AND), pat)).rows;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows).toEqual((await c.query(board(OLD), pat)).rows);
    });
    // A sales recruiter does not match names of candidates outside their scope.
    await asApp(U.r2a, async (c) => {
      const ids = (await c.query<{ ids: string[] }>(`SELECT authz.interview_name_candidate_ids($1) AS ids`, [likeContains("cand")])).rows[0]!.ids;
      const outside = candidates.filter((x) => x.teamId === T.t1 && x.visibility === "team").map((x) => x.id);
      expect(outside.length).toBeGreaterThan(0);
      for (const id of outside) expect(ids).not.toContain(id);
    });
  });

  it.each([["indexed", 0], ["walk", 1]] as const)("no per-row definer call in the %s filter: the set is an InitPlan", async (_n, k) => {
    const text = await asApp(COORD, async (c) =>
      (await c.query<Record<string, string>>(`EXPLAIN (VERBOSE) ${board([NEW_AND, WALK][k]!)}`, [likeContains("cand1")])).rows.map((r) => r["QUERY PLAN"]).join("\n"));
    expect(text).toMatch(/InitPlan \d+ \(returns \$\d+\)\n\s+->\s+Result.*\n\s+Output: authz\.interview_name_candidate_ids/);
    expect(text).not.toMatch(/(Filter|Cond):.*interview_candidate_name/);
  });
});
