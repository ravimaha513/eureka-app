import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityVisible, candidateVisible, hotlistVisible, ownsCandidate, resolveScope } from "@eureka/shared";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { CLIENT_ID, LOC, T, U, seedFixtures, toUserAccess, type FixtureCandidate } from "./fixtures.js";

let db: TestDb;
let candidates: FixtureCandidate[];

beforeAll(async () => {
  db = await createTestDb();
  candidates = await seedFixtures(db.admin);
}, 60_000);

afterAll(async () => {
  await db?.drop();
});

// Tables deliberately without RLS: identity/org/reference data (design B4.8, N1).
const RLS_ALLOW_LIST = new Set([
  "location", "app_user", "role", "role_permission", "user_role", "team", "team_member",
  "reporting_line", "reporting_closure", "coach_assignment", "session", "technology", "client", "vendor",
]);

describe("RLS coverage and hardening", () => {
  it("every non-allow-listed table has RLS enabled and forced", async () => {
    const { rows } = await db.admin.query<{ relname: string; rls: boolean; force: boolean }>(`
      SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'eureka' AND c.relkind = 'r'`);
    const missing = rows.filter((r) => !RLS_ALLOW_LIST.has(r.relname) && !(r.rls && r.force)).map((r) => r.relname);
    expect(missing).toEqual([]);
  });

  it("application roles cannot bypass RLS and own no tables", async () => {
    const { rows } = await db.admin.query(`
      SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname IN ('eureka_app','eureka_worker','authz_definer')`);
    expect(rows).toHaveLength(3);
    for (const r of rows) expect([r.rolbypassrls, r.rolsuper]).toEqual([false, false]);
    const owned = await db.admin.query(`
      SELECT count(*)::int AS n FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
      WHERE r.rolname IN ('eureka_app','eureka_worker')`);
    expect(owned.rows[0].n).toBe(0);
  });

  it("every SECURITY DEFINER function pins search_path and is not executable by PUBLIC", async () => {
    const { rows } = await db.admin.query<{ sig: string; config: string[] | null; public_exec: boolean }>(`
      SELECT p.oid::regprocedure::text AS sig, p.proconfig AS config,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('authz','eureka') AND p.prosecdef`);
    expect(rows.length).toBeGreaterThan(10);
    for (const r of rows) {
      expect(r.config ?? [], r.sig).toContain("search_path=pg_catalog, pg_temp");
    }
    const anyPublic = await db.admin.query(`
      SELECT p.oid::regprocedure::text AS sig FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a ON true
      WHERE n.nspname IN ('authz','eureka') AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'`);
    expect(anyPublic.rows).toEqual([]);
  });

  it("role_permission matches the catalog seed and is read-only for the app", async () => {
    const { rows } = await db.admin.query(`SELECT count(*)::int AS n FROM eureka.role_permission`);
    expect(rows[0].n).toBeGreaterThan(150);
    await expect(asUser(db.app, U.admin, (c) => c.query(`DELETE FROM eureka.role_permission`))).rejects.toThrow(/permission denied/);
  });

  it("with no user context the app sees no candidates", async () => {
    const { rows } = await db.app.query(`SELECT count(*)::int AS n FROM eureka.candidate`);
    expect(rows[0].n).toBe(0);
  });
});

describe("differential: database RLS alone matches the application engine", () => {
  const users = Object.keys(U) as (keyof typeof U)[];

  const setPolicy = (v: "everyone" | "team") =>
    db.admin.query(`UPDATE authz.policy_setting SET value = $1 WHERE key = 'hotlist_visibility'`, [v]);
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

  // Base-table RLS never depends on the Hot List policy (review of 0010).
  describe.each(["everyone", "team"] as const)("Hot List policy %s", (policy) => {
    beforeAll(() => setPolicy(policy));
    afterAll(() => setPolicy("everyone"));

    it.each(users)("candidate rows readable by %s = engine candidate:read", async (key) => {
      const access = toUserAccess(key);
      const expected = candidates.filter((c) => candidateVisible(resolveScope(access, "candidate:read"), c)).map((c) => c.id).sort();
      const actual = await asUser(db.app, access.userId, async (c) => ids((await c.query(`SELECT id FROM eureka.candidate`)).rows));
      expect(actual).toEqual(expected);
      const persons = await asUser(db.app, access.userId, async (c) => (await c.query(`SELECT count(*)::int n FROM eureka.person`)).rows[0].n);
      expect(persons).toBe(expected.length);
    });

    it.each(users)("authz.hotlist_page for %s = engine hotlistVisible under the open policy only", async (key) => {
      const access = toUserAccess(key);
      const expected = policy === "everyone"
        ? candidates.filter((c) => hotlistVisible(resolveScope(access, "hotlist:read", "everyone"), c)).map((c) => c.id).sort()
        : [];
      const rows = await asUser(db.app, access.userId, async (c) =>
        (await c.query<{ id: string; phone: string | null; phone_masked: boolean; readable: boolean; technical_rating: number | null }>(
          `SELECT * FROM authz.hotlist_page(NULL, NULL, NULL, NULL, NULL, 500)`)).rows);
      expect(ids(rows)).toEqual(expected);
      const phoneScope = resolveScope(access, "candidate.phone:read");
      const readScope = resolveScope(access, "candidate:read");
      for (const r of rows) {
        const cand = candidates.find((c) => c.id === r.id)!;
        const owned = phoneScope !== null && ownsCandidate(phoneScope, cand);
        expect(r.phone_masked, r.id).toBe(!owned);
        if (!owned) expect(r.phone).toMatch(/^•••-•••-\d\d$/);
        expect(r.readable).toBe(candidateVisible(readScope, cand));
      }
    });
  });

  it("authz.owns is never NULL (unassigned candidates)", async () => {
    const n = await asUser(db.app, U.r2a, async (c) =>
      (await c.query(`SELECT authz.owns('candidate:update', NULL, $1, $2) IS NULL AS isnull`, [T.t1, LOC.dallas])).rows[0].isnull);
    expect(n).toBe(false);
  });

  it("status transition of another team's unassigned Open-to-all-teams candidate is refused in the database", async () => {
    const c = candidates.find((x) => x.teamId === T.t1 && x.recruiterId === null && x.visibility === "all_teams" && x.marketingStatus === "active")!;
    await expect(asUser(db.app, U.r2a, (cl) => cl.query(`SELECT authz.transition_candidate($1, 'on_hold')`, [c.id])))
      .rejects.toThrow(/not permitted/);
  });

  it("an unknown or inactive user id sees no Hot List", async () => {
    const unknown = await asUser(db.app, "00000000-0000-0000-0000-00000000dead", async (c) =>
      (await c.query(`SELECT count(*)::int n FROM authz.hotlist_page(NULL, NULL, NULL, NULL, NULL, 500)`)).rows[0].n);
    expect(unknown).toBe(0);
  });

  it("the policy setting only accepts known values and is not writable by the app", async () => {
    await expect(db.admin.query(`UPDATE authz.policy_setting SET value = 'all' WHERE key = 'hotlist_visibility'`)).rejects.toThrow(/policy_setting_value/);
    await expect(asUser(db.app, U.admin, (c) => c.query(`UPDATE authz.policy_setting SET value = 'team'`))).rejects.toThrow(/permission denied/);
  });

  describe("submissions", () => {
    type Sub = { id: string; recruiterId: string; teamId: string; locationId: string; candidate: FixtureCandidate };
    const subs: Sub[] = [];
    const teamOf: Record<string, string> = { [U.r1a]: T.t1, [U.r1b]: T.t1, [U.r2a]: T.t2, [U.r3a]: T.t3 };

    beforeAll(async () => {
      // Each candidate's recruiter submits it; r2a also submits every all-teams candidate.
      for (const cand of candidates) {
        const actors = new Set<string>();
        if (cand.recruiterId) actors.add(cand.recruiterId);
        if (cand.visibility === "all_teams" && ["active", "full_of_interviews"].includes(cand.marketingStatus)) actors.add(U.r2a);
        for (const actor of actors) {
          const id = await asUser(db.app, actor, async (c) =>
            (await c.query<{ id: string }>(
              `INSERT INTO eureka.submission (candidate_id, job_title, client_id) VALUES ($1,'Java Dev',$2) RETURNING id`,
              [cand.id, CLIENT_ID])).rows[0]!.id, true);
          subs.push({ id, recruiterId: actor, teamId: teamOf[actor]!, locationId: cand.locationId!, candidate: cand });
        }
      }
    });

    it.each(users)("submission visibility for %s", async (key) => {
      const access = toUserAccess(key);
      const scope = resolveScope(access, "submission:read");
      const expected = subs.filter((s) => activityVisible(scope, s)).map((s) => s.id).sort();
      const actual = await asUser(db.app, access.userId, async (c) =>
        (await c.query<{ id: string }>(`SELECT id FROM eureka.submission`)).rows.map((r) => r.id).sort());
      expect(actual).toEqual(expected);
    });

    it("snapshots are set by the database from the actor", async () => {
      const { rows } = await db.admin.query(`SELECT recruiter_id, team_id FROM eureka.submission WHERE id = $1`, [subs[0]!.id]);
      expect(rows[0]).toEqual({ recruiter_id: subs[0]!.recruiterId, team_id: subs[0]!.teamId });
    });
  });
});

describe("write-side guards (design B4.7, B4.8)", () => {
  const find = (pred: (c: FixtureCandidate) => boolean) => candidates.find(pred)!;
  const ownR1a = () => find((c) => c.recruiterId === U.r1a && c.visibility === "team" && c.marketingStatus === "active");
  const teammateR1b = () => find((c) => c.recruiterId === U.r1b && c.visibility === "team");
  const otherAllTeams = () => find((c) => c.teamId === T.t3 && c.visibility === "all_teams" && c.marketingStatus === "active");

  it("recruiter updates own candidate's profile", async () => {
    const n = await asUser(db.app, U.r1a, async (c) =>
      (await c.query(`UPDATE eureka.candidate SET priority='P1' WHERE id=$1`, [ownR1a().id])).rowCount);
    expect(n).toBe(1);
  });

  it("recruiter cannot update a teammate's candidate (row filtered, 0 rows)", async () => {
    const n = await asUser(db.app, U.r1a, async (c) =>
      (await c.query(`UPDATE eureka.candidate SET priority='P1' WHERE id=$1`, [teammateR1b().id])).rowCount);
    expect(n).toBe(0);
  });

  it.each([
    ["visibility", `visibility='all_teams'`, /change visibility/],
    ["team", `team_id='${T.t2}'`, /reassign/],
    ["rating", `technical_rating=5`, /technical rating/],
    ["status", `marketing_status='stopped'`, /transition/],
    ["location", `location_id='${LOC.austin}'`, /immutable/],
  ])("mass assignment: recruiter cannot change %s", async (_name, set, err) => {
    await expect(asUser(db.app, U.r1a, (c) => c.query(`UPDATE eureka.candidate SET ${set} WHERE id=$1`, [ownR1a().id])))
      .rejects.toThrow(err);
  });

  it("lead can change visibility for a team candidate", async () => {
    const n = await asUser(db.app, U.l1, async (c) =>
      (await c.query(`UPDATE eureka.candidate SET visibility='all_teams' WHERE id=$1`, [teammateR1b().id])).rowCount);
    expect(n).toBe(1);
  });

  it("manager can reassign within hierarchy but not outside it", async () => {
    const cand = teammateR1b();
    const ok = await asUser(db.app, U.m1, async (c) =>
      (await c.query(`UPDATE eureka.candidate SET team_id=$2, recruiter_id=$3 WHERE id=$1`, [cand.id, T.t2, U.r2a])).rowCount);
    expect(ok).toBe(1);
    await expect(asUser(db.app, U.m1, (c) =>
      c.query(`UPDATE eureka.candidate SET team_id=$2, recruiter_id=NULL WHERE id=$1`, [cand.id, T.t3])))
      .rejects.toThrow(/reassign|row-level security/);
  });

  it("recruiter/team invariant: recruiter must belong to the team", async () => {
    await expect(asUser(db.app, U.om, (c) =>
      c.query(`UPDATE eureka.candidate SET team_id=$2, recruiter_id=$3 WHERE id=$1`, [ownR1a().id, T.t3, U.r1a])))
      .rejects.toThrow(/not a member/);
  });

  it("location admin can set technical rating in their location only, and nothing else", async () => {
    const dallas = find((c) => c.locationId === LOC.dallas);
    const austin = find((c) => c.locationId === LOC.austin);
    const n = await asUser(db.app, U.locD, async (c) =>
      (await c.query(`UPDATE eureka.candidate SET technical_rating=4 WHERE id=$1`, [dallas.id])).rowCount);
    expect(n).toBe(1);
    const n2 = await asUser(db.app, U.locD, async (c) =>
      (await c.query(`UPDATE eureka.candidate SET technical_rating=4 WHERE id=$1`, [austin.id])).rowCount);
    expect(n2).toBe(0);
    await expect(asUser(db.app, U.locD, (c) => c.query(`UPDATE eureka.candidate SET priority='P1' WHERE id=$1`, [dallas.id])))
      .rejects.toThrow(/profile fields/);
  });

  it("status changes go through the transition function with state-machine checks", async () => {
    const cand = ownR1a();
    const to = await asUser(db.app, U.r1a, async (c) =>
      (await c.query(`SELECT authz.transition_candidate($1,'on_hold') AS s`, [cand.id])).rows[0].s);
    expect(to).toBe("on_hold");
    await expect(asUser(db.app, U.r1a, (c) => c.query(`SELECT authz.transition_candidate($1,'placed')`, [cand.id])))
      .rejects.toThrow(/invalid transition/);
    await expect(asUser(db.app, U.r1a, (c) => c.query(`SELECT authz.transition_candidate($1,'on_hold')`, [teammateR1b().id])))
      .rejects.toThrow(/not permitted/);
    await expect(asUser(db.app, U.r3a, (c) => c.query(`SELECT authz.transition_candidate($1,'on_hold')`, [teammateR1b().id])))
      .rejects.toThrow(/not found/);
  });

  it("recruiter cannot create a candidate in another team", async () => {
    await expect(asUser(db.app, U.r1a, async (c) => {
      const p = await c.query(`INSERT INTO eureka.person (first_name,last_name) VALUES ('New','Person') RETURNING id`);
      await c.query(`INSERT INTO eureka.candidate (person_id, technology_id, team_id, recruiter_id, location_id)
        SELECT $1, id, $2, NULL, $3 FROM eureka.technology LIMIT 1`, [p.rows[0].id, T.t3, LOC.dallas]);
    })).rejects.toThrow(/row-level security/);
  });

  it("recruiter can submit an Open-to-all-teams candidate but not another team's team-only candidate", async () => {
    await asUser(db.app, U.r1a, (c) => c.query(
      `INSERT INTO eureka.submission (candidate_id, job_title, client_id) VALUES ($1,'x',$2)`, [otherAllTeams().id, CLIENT_ID]));
    const hidden = find((c) => c.teamId === T.t3 && c.visibility === "team");
    await expect(asUser(db.app, U.r1a, (c) => c.query(
      `INSERT INTO eureka.submission (candidate_id, job_title, client_id) VALUES ($1,'x',$2)`, [hidden.id, CLIENT_ID])))
      .rejects.toThrow(/row-level security/);
  });

  it("client-supplied snapshot columns are rejected", async () => {
    await expect(asUser(db.app, U.r1a, (c) => c.query(
      `INSERT INTO eureka.submission (candidate_id, job_title, client_id, team_id) VALUES ($1,'x',$2,$3)`,
      [ownR1a().id, CLIENT_ID, T.t3]))).rejects.toThrow(/set by the server/);
  });

  it("interview creation is authorized against the parent submission", async () => {
    const own = await asUser(db.app, U.r1a, async (c) =>
      (await c.query(`INSERT INTO eureka.submission (candidate_id, job_title, client_id) VALUES ($1,'x',$2) RETURNING id`,
        [ownR1a().id, CLIENT_ID])).rows[0].id, true);
    const ins = (sub: string) => (c: import("pg").PoolClient) => c.query(
      `INSERT INTO eureka.interview (submission_id, round, starts_at, ends_at)
       VALUES ($1,'L1', now(), now() + interval '1 hour') RETURNING team_id`, [sub]);
    const r = await asUser(db.app, U.r1a, ins(own));
    expect(r.rows[0].team_id).toBe(T.t1);
    await expect(asUser(db.app, U.r1b, ins(own))).rejects.toThrow(/row-level security/);
    const lead = await asUser(db.app, U.l1, ins(own));
    expect(lead.rowCount).toBe(1);
  });

  it("audit log is append-only for the app", async () => {
    await asUser(db.app, U.r1a, (c) => c.query(`INSERT INTO eureka.audit_event (actor_id, action, entity_type) VALUES ($1,'test','x')`, [U.r1a]), true);
    await expect(asUser(db.app, U.admin, (c) => c.query(`UPDATE eureka.audit_event SET action='x'`))).rejects.toThrow(/permission denied/);
    await expect(asUser(db.app, U.admin, (c) => c.query(`DELETE FROM eureka.audit_event`))).rejects.toThrow(/permission denied/);
    const seen = await asUser(db.app, U.r1a, async (c) => (await c.query(`SELECT count(*)::int n FROM eureka.audit_event`)).rows[0].n);
    expect(seen).toBe(0);
    const admin = await asUser(db.app, U.admin, async (c) => (await c.query(`SELECT count(*)::int n FROM eureka.audit_event`)).rows[0].n);
    expect(admin).toBeGreaterThan(0);
  });

  it("worker reads only the columns its job needs and cannot read candidates", async () => {
    await expect(db.worker.query(`SELECT * FROM eureka.candidate`)).rejects.toThrow(/permission denied/);
    await expect(db.worker.query(`SELECT otter_url FROM eureka.interview`)).rejects.toThrow(/permission denied/);
    const sub = await asUser(db.app, U.r1a, async (c) =>
      (await c.query(`INSERT INTO eureka.submission (candidate_id, job_title, client_id) VALUES ($1,'x',$2) RETURNING id`,
        [ownR1a().id, CLIENT_ID])).rows[0].id, true);
    await asUser(db.app, U.r1a, (c) => c.query(
      `INSERT INTO eureka.interview (submission_id, round, starts_at, ends_at)
       VALUES ($1,'L1', now() - interval '2 hours', now() - interval '1 hour')`, [sub]), true);
    const { rows } = await db.worker.query(`SELECT id, ends_at FROM eureka.interview`);
    expect(rows.length).toBe(1);
    const marked = await db.worker.query(`UPDATE eureka.interview SET feedback_email_sent_at = now() WHERE id = $1`, [rows[0].id]);
    expect(marked.rowCount).toBe(1);
    // Once marked, the row leaves the worker's view (idempotent job).
    expect((await db.worker.query(`SELECT id FROM eureka.interview WHERE feedback_email_sent_at IS NULL`)).rows).toEqual([]);
    // Marking twice is a no-op (USING requires feedback_email_sent_at IS NULL).
    expect((await db.worker.query(`UPDATE eureka.interview SET feedback_email_sent_at = now() WHERE id = $1`, [rows[0].id])).rowCount).toBe(0);
  });

  it("org_admin reads no business tables (the open Hot List is a function, not RLS)", async () => {
    for (const t of ["candidate", "person", "submission", "interview"]) {
      const n = await asUser(db.app, U.admin, async (c) => (await c.query(`SELECT count(*)::int n FROM eureka.${t}`)).rows[0].n);
      expect(n, t).toBe(0);
    }
  });

  it("reporting line cycles are rejected", async () => {
    await expect(db.admin.query(`INSERT INTO eureka.reporting_line (user_id, manager_id) VALUES ($1,$2)`, [U.ceo, U.r1a]))
      .rejects.toThrow(/cycle/);
  });
});
