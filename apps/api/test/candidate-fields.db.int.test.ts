import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, TECH_ID, U, seedFixtures, type FixtureCandidate } from "./fixtures.js";

/**
 * Migration 0140 in the database alone: the profile-field guard, the
 * compliance definer function and its readers, server-managed
 * team_assigned_at, constraints and function hygiene (rules 1, 2, 4, 6).
 */
let db: TestDb;
let candidates: FixtureCandidate[];
let company: string;
let inactiveCompany: string;

beforeAll(async () => {
  db = await createTestDb();
  candidates = await seedFixtures(db.admin);
  // Companies are written only by definer code; insert them with triggers off (test setup).
  const c = await db.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    const ins = async (name: string, status: string) => (await c.query<{ id: string }>(
      `INSERT INTO eureka.company (location_id, name, status, created_by, updated_by) VALUES ($1, $2, $3, $4, $4) RETURNING id`,
      [LOC.dallas, name, status, U.admin])).rows[0]!.id;
    company = await ins("Payroll Co", "active");
    inactiveCompany = await ins("Closed Co", "inactive");
    await c.query("COMMIT");
  } finally {
    c.release();
  }
}, 90_000);

afterAll(async () => {
  await db?.drop();
});

const own = () => candidates.find((c) => c.recruiterId === U.r1a && c.visibility === "team" && c.marketingStatus === "active")!;
const otherAllTeams = () => candidates.find((c) => c.teamId === T.t3 && c.visibility === "all_teams" && c.marketingStatus === "active")!;
const dallasOwn = () => candidates.find((c) => c.recruiterId === U.r1a && c.locationId === LOC.dallas)!;

describe("candidate_profile_guard", () => {
  it("compliance columns never change through a direct update, even by the owning lead", async () => {
    for (const set of [`documents_status = 'complete'`, `everify_company_id = '${company}'`]) {
      await expect(asUser(db.app, U.l1, (c) => c.query(`UPDATE eureka.candidate SET ${set} WHERE id = $1`, [own().id])))
        .rejects.toThrow(/set_candidate_compliance/);
    }
  });

  it("team_assigned_at is server-managed: a direct update is refused, a team change sets it", async () => {
    await expect(asUser(db.app, U.l1, (c) => c.query(`UPDATE eureka.candidate SET team_assigned_at = now() - interval '9 days' WHERE id = $1`, [own().id])))
      .rejects.toThrow(/server_managed_field/);
    const at = await asUser(db.app, U.m1, async (c) => {
      await c.query(`UPDATE eureka.candidate SET team_id = $2, recruiter_id = NULL WHERE id = $1`, [own().id, T.t2]);
      return (await c.query<{ fresh: boolean }>(
        `SELECT team_assigned_at >= now() AS fresh FROM eureka.candidate WHERE id = $1`, [own().id])).rows[0]!.fresh;
    }); // rolled back
    expect(at).toBe(true);
  });

  it("profile columns need candidate:update over the candidate (a location rater may not change them)", async () => {
    const id = dallasOwn().id;
    await expect(asUser(db.app, U.locD, (c) => c.query(`UPDATE eureka.candidate SET visa_category = 'h1b' WHERE id = $1`, [id])))
      .rejects.toThrow(/not permitted to update profile fields/);
    await expect(asUser(db.app, U.locD, (c) => c.query(`UPDATE eureka.candidate SET gh_remote = true WHERE id = $1`, [id])))
      .rejects.toThrow(/not permitted to update profile fields/);
    const n = await asUser(db.app, U.r1a, async (c) =>
      (await c.query(`UPDATE eureka.candidate SET visa_category = 'h1b', linkedin_url = 'https://linkedin.com/in/x' WHERE id = $1`, [id])).rowCount);
    expect(n).toBe(1);
  });

  it("an API insert cannot set compliance columns; team_assigned_at is the server's time", async () => {
    // A lead adds candidates (CA-6); r1a stays the assigned recruiter.
    const out = await asUser(db.app, U.l1, async (c) => {
      const person = "11111111-2222-4333-8444-555555555555";
      await c.query(`INSERT INTO eureka.person (id, first_name, last_name) VALUES ($1, 'New', 'Person')`, [person]);
      await expect(c.query(`SAVEPOINT a; INSERT INTO eureka.candidate (person_id, technology_id, team_id, recruiter_id, location_id, documents_status)
        VALUES ('${person}', '${TECH_ID}', '${T.t1}', '${U.r1a}', '${LOC.dallas}', 'complete')`)).rejects.toThrow(/server_managed_field/);
      await c.query(`ROLLBACK TO SAVEPOINT a`);
      return (await c.query<{ fresh: boolean }>(
        `INSERT INTO eureka.candidate (person_id, technology_id, team_id, recruiter_id, location_id, team_assigned_at)
         VALUES ($1, $2, $3, $4, $5, now() - interval '30 days') RETURNING team_assigned_at >= now() - interval '1 minute' AS fresh`,
        [person, TECH_ID, T.t1, U.r1a, LOC.dallas])).rows[0]!.fresh;
    });
    expect(out).toBe(true);
  });

  it.each([
    ["a non-LinkedIn link", `linkedin_url = 'https://evil.example/x'`],
    ["an http resume link", `resume_url = 'http://x.example/r'`],
    ["an unknown eligibility", `eligibility = ARRAY['anywhere']`],
    ["an empty eligibility", `eligibility = '{}'`],
    ["six marketing locations", `marketing_locations = ARRAY['a','b','c','d','e','f']`],
    ["a blank marketing location", `marketing_locations = ARRAY['']`],
    ["a guest house and remote", `gh_remote = true, gh_location_id = '${LOC.dallas}'`],
    ["an unknown visa", `visa_category = 'b1'`],
  ])("rejects %s (check constraint)", async (_what, set) => {
    await expect(asUser(db.app, U.r1a, (c) => c.query(`UPDATE eureka.candidate SET ${set} WHERE id = $1`, [dallasOwn().id])))
      .rejects.toThrow(/check constraint/);
  });
});

describe("authz.set_candidate_compliance", () => {
  const set = (user: string, id: string, e: string | null, docs: string | null) =>
    asUser(db.app, user, (c) => c.query(`SELECT authz.set_candidate_compliance($1, $2, NULL, NULL, $3) AS v`, [id, e, docs]));

  it("re-checks candidate.compliance:update in the database", async () => {
    await expect(set(U.l1, own().id, company, "pending")).rejects.toThrow(/not permitted/);
    await expect(set(U.r1a, own().id, null, "pending")).rejects.toThrow(/not permitted/);
    await expect(set("00000000-0000-0000-0000-00000000dead", own().id, null, "pending")).rejects.toThrow(/not permitted/);
    const r = await set(U.hr, own().id, company, "partial");
    expect(r.rows[0].v).toBeGreaterThan(1);
  });

  it("a changed link must name an active company; an unknown candidate is not found; a bad status fails the check", async () => {
    await expect(set(U.hr, own().id, inactiveCompany, null)).rejects.toThrow(/invalid_company/);
    await expect(set(U.hr, "99999999-9999-4999-8999-999999999999", null, null)).rejects.toThrow(/candidate_not_found/);
    await expect(set(U.hr, own().id, null, "done")).rejects.toThrow(/check constraint/);
  });

  it("company names go to owners and compliance editors, not to an Open-to-all-teams viewer", async () => {
    const id = otherAllTeams().id;
    const names = async (user: string) => (await asUser(db.app, user, (c) =>
      c.query(`SELECT link, company_name FROM authz.candidate_companies($1)`, [id]))).rows;
    // Committed (the set() helper rolls back).
    await asUser(db.app, U.imm, (c) => c.query(`SELECT authz.set_candidate_compliance($1, $2, NULL, NULL, 'complete')`, [id, company]), true);
    expect(await names(U.l3)).toEqual([{ link: "everify", company_name: "Payroll Co" }]);
    expect(await names(U.acct)).toEqual([{ link: "everify", company_name: "Payroll Co" }]);
    expect(await names(U.r1a)).toEqual([]);
    expect(await names(U.admin)).toEqual([]);
  });

  it("the company picker and resume ids are empty for callers without the permissions", async () => {
    const opts = async (user: string) => (await asUser(db.app, user, (c) => c.query(`SELECT name FROM authz.compliance_company_options()`))).rows;
    expect((await opts(U.hr)).map((r) => r.name)).toEqual(["Payroll Co"]);
    expect(await opts(U.r1a)).toEqual([]);
    const ids = await asUser(db.app, U.admin, (c) => c.query(`SELECT authz.resume_candidate_ids() AS ids, authz.resume_flags($1::uuid[]) AS f`, [[own().id]]));
    expect(ids.rows[0]).toEqual({ ids: [], f: [] });
  });
});

describe("function hygiene (rule 2)", () => {
  const fns = [
    "authz.set_candidate_compliance(uuid,uuid,uuid,uuid,text)",
    "authz.candidate_companies(uuid)",
    "authz.compliance_company_options()",
    "authz.resume_candidate_ids()",
    "authz.resume_flags(uuid[])",
    "authz.hotlist_page(text,text,text,text,uuid,integer,uuid,text,text,boolean,text,jsonb)",
    "authz.hotlist_export(text,text,text,text,integer,uuid,text,text,boolean,text,jsonb)",
  ];

  it.each(fns)("%s: definer with a pinned search_path, executable by the API role only", async (fn) => {
    const { rows } = await db.admin.query(`
      SELECT p.prosecdef AS definer, p.proconfig AS config,
             has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
             has_function_privilege('eureka_worker', p.oid, 'EXECUTE') AS worker,
             has_function_privilege('eureka_app', p.oid, 'EXECUTE') AS app
      FROM pg_proc p WHERE p.oid = $1::regprocedure`, [fn]);
    expect(rows[0]).toEqual({ definer: true, config: ["search_path=pg_catalog, pg_temp"], pub: false, worker: false, app: true });
  });

  it("the guard trigger function is not executable by PUBLIC and pins search_path", async () => {
    const { rows } = await db.admin.query(`
      SELECT p.proconfig AS config, has_function_privilege('public', p.oid, 'EXECUTE') AS pub
      FROM pg_proc p WHERE p.oid = 'eureka.candidate_profile_guard()'::regprocedure`);
    expect(rows[0]).toEqual({ config: ["search_path=pg_catalog, pg_temp"], pub: false });
  });

  it("the old six- and five-argument Hot List functions are gone (no ambiguous overloads)", async () => {
    const { rows } = await db.admin.query(`
      SELECT proname, pronargs FROM pg_proc WHERE proname IN ('hotlist_page', 'hotlist_export') ORDER BY proname`);
    expect(rows).toEqual([{ proname: "hotlist_export", pronargs: 11 }, { proname: "hotlist_page", pronargs: 12 }]);
  });

  it("migration-time backfill policies were dropped", async () => {
    const { rows } = await db.admin.query(`SELECT count(*)::int AS n FROM pg_policies WHERE policyname LIKE 'm0140_%'`);
    expect(rows[0].n).toBe(0);
  });
});
