import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownsCandidate, resolveScope } from "@eureka/shared";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { T, U, seedFixtures, toUserAccess, type FixtureCandidate } from "./fixtures.js";

/**
 * R-12 (A-03, C-03): bulk endpoints keep their per-record results while batching the work.
 * Org-chart apply, bulk user import and team members bulk rebuild the reporting closure once
 * (migration 0476); Hot List bulk actions read once and write in one transaction with a
 * savepoint per record (no audit row for a record that was rolled back).
 */
let db: TestDb;
let app: NestFastifyApplication;
let candidates: FixtureCandidate[];
const SECRET = "test-secret-test-secret-test-secret-123";
const N = 50;
const extra = Array.from({ length: N }, (_, i) => `00000000-0000-4000-8000-${(700 + i).toString().padStart(12, "0")}`);

beforeAll(async () => {
  db = await createTestDb();
  candidates = await seedFixtures(db.admin);
  // Test-only counter: every closure rebuild empties eureka.reporting_closure with one DELETE statement.
  await db.admin.query(`CREATE TABLE public.test_closure_rebuild (at timestamptz NOT NULL DEFAULT clock_timestamp())`);
  await db.admin.query(`CREATE FUNCTION public.test_count_closure_rebuild() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp AS $$ BEGIN INSERT INTO public.test_closure_rebuild DEFAULT VALUES; RETURN NULL; END $$`);
  await db.admin.query(`CREATE TRIGGER test_closure_rebuild AFTER DELETE ON eureka.reporting_closure
    FOR EACH STATEMENT EXECUTE FUNCTION public.test_count_closure_rebuild()`);
  for (const [i, id] of extra.entries()) {
    await db.admin.query(`INSERT INTO eureka.app_user (id, email, display_name) VALUES ($1, $2, $3)`, [id, `y${i}@eureka.example`, `y${i}`]);
    await db.admin.query(`INSERT INTO eureka.reporting_line (user_id, manager_id) VALUES ($1, $2)`, [id, U.ad]);
  }
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: SECRET, GOOGLE_HOSTED_DOMAIN: "eureka.example",
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
}, 90_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

type Method = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
const sessions = new Map<string, { cookie: string; csrf: string }>();
async function call(key: keyof typeof U, method: Method, url: string, payload?: unknown) {
  let s = sessions.get(key);
  if (!s) {
    const res = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: `${key}@eureka.example` } });
    const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
    s = { cookie, csrf: me.json().csrfToken as string };
    sessions.set(key, s);
  }
  return app.inject({ method, url, payload: payload as never, headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}) } });
}

/** Closure rebuilds so far: rows of the test-only counter (one per DELETE of the whole closure, i.e. per rebuild). */
const rebuilds = async () => (await db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.test_closure_rebuild`)).rows[0]!.n;

/** Closure rows that differ from the closure recomputed from the current reporting lines. */
const closureDiff = async () => (await db.admin.query(`
  WITH RECURSIVE x(anc, des, d) AS (
    SELECT rl.manager_id, rl.user_id, 1 FROM eureka.reporting_line rl WHERE rl.valid @> now()
    UNION ALL
    SELECT rl.manager_id, x.des, x.d + 1 FROM x JOIN eureka.reporting_line rl ON rl.user_id = x.anc AND rl.valid @> now() WHERE x.d < 64),
  want AS (SELECT anc, des, min(d) AS d FROM x GROUP BY anc, des),
  have AS (SELECT ancestor_id AS anc, descendant_id AS des, depth AS d FROM eureka.reporting_closure)
  (SELECT 'missing' AS k, * FROM (SELECT * FROM want EXCEPT SELECT * FROM have) a)
  UNION ALL
  (SELECT 'extra', * FROM (SELECT * FROM have EXCEPT SELECT * FROM want) b)`)).rows;
const managerOf = async (id: string) =>
  (await db.admin.query<{ m: string }>(`SELECT manager_id AS m FROM eureka.reporting_line WHERE user_id = $1 AND valid @> now()`, [id])).rows[0]?.m ?? null;

describe("reporting closure: one rebuild per bulk request (C-03)", () => {
  it("a 50-move org-chart apply rebuilds the closure once; closure, lines and audit rows are right", async () => {
    const before = await rebuilds();
    // A chain under m2: y0 -> m2, y1 -> y0, ... (depth 53 from the CEO).
    const moves = extra.map((id, i) => ({ userId: id, managerId: i === 0 ? U.m2 : extra[i - 1]! }));
    const r = await call("admin", "POST", "/api/v1/admin/org-chart/apply", { moves });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ applied: N });
    expect(await rebuilds() - before).toBe(1);
    expect(await closureDiff()).toEqual([]);
    for (const m of moves) expect(await managerOf(m.userId)).toBe(m.managerId);
    const deepest = (await db.admin.query<{ a: string }>(
      `SELECT ancestor_id AS a FROM eureka.reporting_closure WHERE descendant_id = $1 ORDER BY depth`, [extra[N - 1]])).rows.map((x) => x.a);
    expect(deepest).toEqual([...extra.slice(0, N - 1).reverse(), U.m2, U.ad, U.ceo]);
    expect((await db.admin.query(`SELECT count(*)::int AS n FROM eureka.audit_event WHERE action = 'admin.user.manager' AND changes->>'batch' = 'true'`))
      .rows[0].n).toBe(N);
    // A loop is still refused as 'cycle' and the whole batch rolls back.
    const bad = await call("admin", "POST", "/api/v1/admin/org-chart/apply", {
      moves: [{ userId: extra[40], managerId: U.m1 }, { userId: U.m2, managerId: extra[30] }],
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().detail).toBe("cycle");
    expect(await managerOf(extra[40]!)).toBe(extra[39]);
    expect(await closureDiff()).toEqual([]);
  });

  it("team members bulk: per-user results as before, one rebuild for the request", async () => {
    await db.admin.query(`UPDATE eureka.app_user SET status = 'inactive' WHERE id = $1`, [extra[49]]);
    const before = await rebuilds();
    const NOBODY = "99999999-9999-4999-8999-999999999999";
    const adds = extra.slice(0, 10);
    const r = await call("admin", "POST", `/api/v1/admin/teams/${T.t3}/members/bulk`, {
      userIds: [...adds, U.r1a, U.admin, NOBODY, U.m2, extra[49], adds[0]],
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({
      added: adds,
      failed: [
        { userId: U.r1a, error: "already_member" },
        { userId: U.admin, error: "self_change" },
        { userId: NOBODY, error: "user_not_found" },
        { userId: U.m2, error: "cycle" }, // m2 is above the team's lead l3
        { userId: extra[49], error: "user_inactive" },
      ],
    });
    expect(await rebuilds() - before).toBe(1);
    for (const id of adds) expect(await managerOf(id)).toBe(U.l3);
    expect(await closureDiff()).toEqual([]);
    const audit = (await db.admin.query(`SELECT changes->>'userId' AS u FROM eureka.audit_event WHERE action = 'admin.team.member_added' AND entity_id = $1`, [T.t3])).rows;
    expect(audit.map((a) => a.u).sort()).toEqual([...adds].sort()); // none for the refused ones
    expect((await call("admin", "POST", `/api/v1/admin/teams/${NOBODY}/members/bulk`, { userIds: [extra[20]] })).statusCode).toBe(404);
    expect((await call("l1", "POST", `/api/v1/admin/teams/${T.t3}/members/bulk`, { userIds: [extra[20]] })).statusCode).toBe(403);
  });

  it("bulk import with managers and teams rebuilds once (the docs' claim) and commits", async () => {
    const before = await rebuilds();
    const rows = Array.from({ length: 12 }, (_, i) => ({
      email: `imp${i}@eureka.example`, displayName: `Imp ${i}`,
      ...(i % 3 === 0 ? { team: "Team Vikram" } : { manager: i % 3 === 1 ? "m1@eureka.example" : `imp${i - 1}@eureka.example` }),
    }));
    const r = await call("admin", "POST", "/api/v1/admin/users/bulk", { dryRun: false, rows });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ committed: true, created: 12, failed: 0 });
    expect(await rebuilds() - before).toBe(1);
    expect(await closureDiff()).toEqual([]);
    const id = (email: string) => (r.json().rows as { email: string; id: string }[]).find((x) => x.email === email)!.id;
    expect(await managerOf(id("imp0@eureka.example"))).toBe(U.l3);
    expect(await managerOf(id("imp1@eureka.example"))).toBe(U.m1);
    expect(await managerOf(id("imp2@eureka.example"))).toBe(id("imp1@eureka.example"));
    // A dry run does the same work and rolls back: nothing is left behind.
    const dry = await call("admin", "POST", "/api/v1/admin/users/bulk", { dryRun: true, rows: [{ email: "dry@eureka.example", displayName: "Dry", team: "Team Vikram" }] });
    expect(dry.json()).toMatchObject({ committed: false, failed: 0 });
    expect(await closureDiff()).toEqual([]);
  });
});

describe("Hot List bulk: one read, one transaction, savepoint per record (A-03)", () => {
  it("a 100-id request with mixed outcomes reports each record as before and audits only the successes", async () => {
    const NOBODY = (i: number) => `99999999-9999-4999-8999-${i.toString().padStart(12, "0")}`;
    const ids = [...candidates.slice(0, 90).map((c) => c.id), ...Array.from({ length: 10 }, (_, i) => NOBODY(i))];
    const scope = resolveScope(toUserAccess("m1"), "candidate.visibility:update")!;
    // Expected per record, by the single-record rules: 404 not readable, 403 not owned, and "Selected teams"
    // naming only the candidate's own team is refused by the database (teams_required -> invalid_teams).
    const expected = new Map<string, string | null>();
    for (const id of ids) {
      const c = candidates.find((x) => x.id === id);
      if (!c || (await call("m1", "GET", `/api/v1/candidates/${id}`)).statusCode === 404) expected.set(id, "not_found");
      else if (!ownsCandidate(scope, c)) expected.set(id, "forbidden");
      else expected.set(id, c.teamId === T.t1 ? "invalid_teams" : null);
    }
    const outcomes = new Set(expected.values());
    expect([...outcomes].sort()).toEqual(["forbidden", "invalid_teams", "not_found", null].sort());
    const visBefore = new Map((await db.admin.query<{ id: string; visibility: string }>(
      `SELECT id, visibility FROM eureka.candidate WHERE id = ANY ($1::uuid[])`, [ids])).rows.map((x) => [x.id, x.visibility]));

    const r = await call("m1", "POST", "/api/v1/hotlist/bulk/visibility", { ids, visibility: "selected_teams", teamIds: [T.t1] });
    expect(r.statusCode, r.body).toBe(200);
    const ok = ids.filter((id) => expected.get(id) === null);
    expect(r.json()).toEqual({
      succeeded: ok.length, failed: ids.length - ok.length,
      results: ids.map((id) => (expected.get(id) === null ? { id, ok: true } : { id, ok: false, error: expected.get(id) })),
    });
    const after = new Map((await db.admin.query<{ id: string; visibility: string }>(
      `SELECT id, visibility FROM eureka.candidate WHERE id = ANY ($1::uuid[])`, [ids])).rows.map((x) => [x.id, x.visibility]));
    for (const id of ids) {
      if (expected.get(id) === null) expect(after.get(id)).toBe("selected_teams");
      else expect(after.get(id)).toBe(visBefore.get(id));
    }
    // One candidate.visibility row per success, none for a record rolled back to its savepoint; one summary row.
    const per = (await db.admin.query<{ entity_id: string; changes: unknown }>(
      `SELECT entity_id, changes FROM eureka.audit_event WHERE action = 'candidate.visibility' AND actor_id = $1`, [U.m1])).rows;
    expect(per.map((p) => p.entity_id).sort()).toEqual([...ok].sort());
    expect(per[0]!.changes).toEqual({ visibility: "selected_teams", teamIds: [T.t1] });
    const summary = (await db.admin.query(`SELECT changes FROM eureka.audit_event WHERE action = 'hotlist.bulk' AND actor_id = $1`, [U.m1])).rows;
    expect(summary).toEqual([{ changes: { action: "visibility", value: "selected_teams", requested: 100, succeeded: ok.length, failed: 100 - ok.length } }]);
  });

  it("status and priority over 100 ids: invalid moves and other teams' records are reported, the rest written", async () => {
    const ids = candidates.slice(0, 100).map((c) => c.id);
    const r = await call("l1", "POST", "/api/v1/hotlist/bulk/priority", { ids, priority: "P1" });
    expect(r.statusCode).toBe(200);
    const res = r.json() as { succeeded: number; results: { id: string; ok: boolean; error?: string }[] };
    expect(res.results.map((x) => x.id)).toEqual(ids);
    const done = res.results.filter((x) => x.ok).map((x) => x.id);
    expect(done.length).toBe(res.succeeded);
    expect(done.length).toBeGreaterThan(0);
    const p1 = (await db.admin.query<{ id: string }>(`SELECT id FROM eureka.candidate WHERE id = ANY ($1::uuid[]) AND priority = 'P1'`, [ids])).rows.map((x) => x.id);
    expect(p1.sort()).toEqual([...done].sort());
    const audited = (await db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM eureka.audit_event WHERE action = 'candidate.updated' AND actor_id = $1`, [U.l1])).rows[0]!.n;
    expect(audited).toBe(done.length);
    const s = await call("l1", "POST", "/api/v1/hotlist/bulk/status", { ids, to: "on_hold" });
    const sr = s.json() as { results: { ok: boolean; error?: string }[] };
    expect(new Set(sr.results.filter((x) => !x.ok).map((x) => x.error))).toEqual(new Set(["invalid_transition", "not_found", "forbidden"]));
  });
});
