import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { backdate, joinedEmployee } from "./employee-seed.js";
import { CLIENT_ID, LOC, T, U, seedFixtures } from "./fixtures.js";
import { newCandidate } from "./placement-seed.js";

/**
 * Recruiter performance API (docs/performance-api.md PF-1..PF-8): counts per
 * person and their ratios in each role's scope, the drill-down rows behind a
 * count, active candidates on end-client projects, targets (set by managers and
 * associate directors, read-before-write), people with their actions, and
 * designation changes under designation:change and access:manage.
 */
let db: TestDb;
let app: NestFastifyApplication;
const SECRET = "test-secret-test-secret-test-secret-123";
const NIL = "00000000-0000-0000-0000-00000000beef";

const P_FROM = "2030-03-01T00:00:00.000Z";
const P_TO = "2030-03-08T00:00:00.000Z";
const PERIOD = `from=${encodeURIComponent(P_FROM)}&to=${encodeURIComponent(P_TO)}&tz=UTC`;
const inP = (day: number, hour = 12) => `2030-03-0${day}T${String(hour).padStart(2, "0")}:00:00Z`;
const HOUR = 3_600_000;

async function force(sql: string, params: unknown[]) {
  const c = await db.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query(sql, params);
    await c.query("COMMIT");
  } finally {
    c.release();
  }
}

const TEAM_OF: Record<string, string> = { [U.r1a]: T.t1, [U.r1b]: T.t1, [U.l1]: T.t1, [U.r2a]: T.t2, [U.r3a]: T.t3 };

async function submit(actor: string, at: string): Promise<string> {
  const cand = await newCandidate(db, { teamId: TEAM_OF[actor]!, recruiterId: actor, locationId: LOC.dallas });
  await force("UPDATE eureka.candidate SET created_at = '2020-01-01' WHERE id = $1", [cand.id]);
  const id = await asUser(db.app, actor, async (c) => (await c.query<{ id: string }>(
    `INSERT INTO eureka.submission (candidate_id, job_title, client_id) VALUES ($1,'Java Developer',$2) RETURNING id`,
    [cand.id, CLIENT_ID])).rows[0]!.id, true);
  await force("UPDATE eureka.submission SET submitted_at = $2 WHERE id = $1", [id, at]);
  return id;
}

let slot = 0;
async function interview(actor: string, submissionId: string, startsAt: string, state: { callStatus?: string; clearedAt?: string } = {}) {
  const placeholder = new Date(Date.parse("2035-01-01T00:00:00Z") + slot++ * 2 * HOUR);
  const id = await asUser(db.app, actor, async (c) => (await c.query<{ id: string }>(
    `INSERT INTO eureka.interview (submission_id, round, starts_at, ends_at) VALUES ($1,'L1',$2,$3) RETURNING id`,
    [submissionId, placeholder.toISOString(), new Date(placeholder.getTime() + HOUR).toISOString()])).rows[0]!.id, true);
  await force(`UPDATE eureka.interview SET starts_at = $2, ends_at = $3, call_status = $4, cleared = $5, cleared_at = $6 WHERE id = $1`,
    [id, startsAt, new Date(Date.parse(startsAt) + HOUR).toISOString(), state.callStatus ?? "scheduled", state.clearedAt !== undefined, state.clearedAt ?? null]);
  return id;
}

const ids = { r1aSubs: [] as string[], active: "", activeLater: "" };

/**
 * In the period: r1a 3 submissions (+1 before), interviews on two of them
 * (one cleared) and a cancelled one, 1 placement created; r1b 1; l1 1; r2a 2
 * (one interview); r3a 1. Active on projects: r1a's employee since 2030-02-15;
 * r3a's from 2030-03-20 (after the period).
 */
async function seed() {
  const s1 = await submit(U.r1a, inP(1));
  const s2 = await submit(U.r1a, inP(2));
  const s3 = await submit(U.r1a, inP(3));
  ids.r1aSubs = [s1, s2, s3];
  await submit(U.r1a, "2030-02-20T12:00:00Z");
  await submit(U.r1b, inP(4));
  await submit(U.l1, inP(4));
  const s5 = await submit(U.r2a, inP(5));
  await submit(U.r2a, inP(6));
  await submit(U.r3a, inP(6));
  await interview(U.r1a, s1, inP(2, 15), { callStatus: "completed", clearedAt: inP(3) });
  await interview(U.r1a, s2, inP(3, 15));
  await interview(U.r1a, s3, inP(4, 15), { callStatus: "cancelled" });
  await interview(U.r2a, s5, inP(6, 15));

  const j = await joinedEmployee(db, { actor: U.r1a });
  await backdate(db, j, "2030-02-15");
  await force("UPDATE eureka.placement SET created_at = $2, joined_at = '2030-02-15T12:00:00Z' WHERE id = $1", [j.placementId, inP(1, 9)]);
  ids.active = j.placementId;
  const later = await joinedEmployee(db, { actor: U.r3a, teamId: T.t3 });
  await backdate(db, later, "2030-03-20");
  await force("UPDATE eureka.placement SET created_at = '2030-01-01', joined_at = '2030-03-20T12:00:00Z' WHERE id = $1", [later.placementId]);
  ids.activeLater = later.placementId;
}

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  await seed();
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: SECRET, GOOGLE_HOSTED_DOMAIN: "eureka.example",
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
}, 180_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

type Key = keyof typeof U;
type Method = "GET" | "PUT" | "DELETE";
const sessions = new Map<string, { cookie: string; csrf: string }>();
async function call(key: Key, method: Method, url: string, payload?: unknown) {
  let s = sessions.get(key);
  if (!s) {
    const res = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: `${key}@eureka.example` } });
    expect(res.statusCode).toBe(204);
    const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
    s = { cookie, csrf: me.json().csrfToken as string };
    sessions.set(key, s);
  }
  return app.inject({ method, url, payload: payload as never, headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}) } });
}

interface Person { user: { id: string; name: string }; counts: Record<string, number>; ratios: Record<string, number | null> }
const summary = async (key: Key) => {
  const r = await call(key, "GET", `/api/v1/performance/summary?${PERIOD}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { totals: { counts: Record<string, number>; ratios: Record<string, number | null> }; people: Person[]; kinds: string[] };
};
const who = (people: Person[]) => people.map((p) => p.user.id).sort();

describe("PF-1..PF-3 summary", () => {
  it("a recruiter sees themself only, with counts and ratios", async () => {
    const s = await summary("r1a");
    expect(who(s.people)).toEqual([U.r1a]);
    expect(s.people[0]!.counts).toEqual({ submissions: 3, interviews: 2, interviewsCleared: 1, placements: 1, joined: 0 });
    expect(s.people[0]!.ratios).toEqual({ submissionToInterview: 0.667, interviewToPlacement: 0.5, placement: 0.333 });
    expect(s.kinds).toEqual(["submissions", "interviews", "interviewsCleared", "placements", "joined"]);
  });

  it("a lead sees the team; a manager the hierarchy; the AD and CEO everyone below", async () => {
    const lead = await summary("l1");
    expect(who(lead.people)).toEqual([U.l1, U.r1a, U.r1b].sort());
    expect(lead.totals.counts.submissions).toBe(5);
    const mgr = await summary("m1");
    expect(who(mgr.people)).toEqual([U.m1, U.l1, U.l2, U.r1a, U.r1b, U.r2a].sort());
    expect(mgr.totals.counts).toMatchObject({ submissions: 7, interviews: 3, interviewsCleared: 1, placements: 1 });
    const ad = await summary("ad");
    expect(who(ad.people)).toEqual([U.ad, U.m1, U.m2, U.l1, U.l2, U.l3, U.r1a, U.r1b, U.r2a, U.r3a].sort());
    expect(ad.totals.counts.submissions).toBe(8);
    const ceo = await summary("ceo");
    expect(who(ceo.people)).toEqual(who(ad.people));
    expect(ceo.totals.counts.submissions).toBe(8);
    const other = await summary("l3");
    expect(who(other.people)).toEqual([U.l3, U.r3a].sort());
    expect(other.totals.counts.submissions).toBe(1);
    expect(other.totals.ratios).toEqual({ submissionToInterview: 0, interviewToPlacement: null, placement: 0 });
  });

  it("roles without performance:read get 403; a bad period 422", async () => {
    for (const k of ["hr", "acct", "admin", "coach", "imm"] as Key[]) {
      expect((await call(k, "GET", `/api/v1/performance/summary?${PERIOD}`)).statusCode, k).toBe(403);
    }
    expect((await call("r1a", "GET", `/api/v1/performance/summary?from=${encodeURIComponent(P_TO)}&to=${encodeURIComponent(P_FROM)}`)).statusCode).toBe(422);
    expect((await call("r1a", "GET", `/api/v1/performance/summary?from=2029-01-01&to=2030-06-01`)).statusCode).toBe(422);
    expect((await call("r1a", "GET", `/api/v1/performance/summary?bogus=1`)).statusCode).toBe(422);
  });
});

describe("PF-2 drill-down", () => {
  const rows = async (key: Key, q: string) => {
    const r = await call(key, "GET", `/api/v1/performance/activity?${PERIOD}&${q}`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as { total: number; items: { id: string; recruiter: { id: string }; status: string; client: string; candidate: { name: string | null } }[] };
  };

  it("lists the rows behind each count, newest first, in the caller's scope", async () => {
    const mine = await rows("r1a", "kind=submissions");
    expect(mine.total).toBe(3);
    expect(mine.items.map((i) => i.id)).toEqual([...ids.r1aSubs].reverse());
    expect(mine.items[0]).toMatchObject({ client: "Northwind Financial", status: "submitted", recruiter: { id: U.r1a } });
    expect(mine.items[0]!.candidate.name).toMatch(/Placed$/);
    expect((await rows("l1", `kind=submissions&userId=${U.r1b}`)).total).toBe(1);
    expect((await rows("m1", "kind=interviews")).total).toBe(3);
    expect((await rows("m1", "kind=interviewsCleared")).total).toBe(1);
    expect((await rows("m1", "kind=placements")).total).toBe(1);
    // Outside the caller's scope: nothing, not an error.
    expect((await rows("r1a", `kind=submissions&userId=${U.r2a}`)).total).toBe(0);
    expect((await rows("l3", "kind=submissions")).items.map((i) => i.recruiter.id)).toEqual([U.r3a]);
  });

  it("pages with an exact total", async () => {
    const p1 = await rows("m1", "kind=submissions&limit=2");
    expect(p1.total).toBe(7);
    expect(p1.items).toHaveLength(2);
    const p4 = await rows("m1", "kind=submissions&limit=2&offset=6");
    expect(p4.items).toHaveLength(1);
    const past = await rows("m1", "kind=submissions&limit=2&offset=20");
    expect(past).toMatchObject({ total: 7, items: [] });
    expect((await call("m1", "GET", `/api/v1/performance/activity?${PERIOD}&kind=bogus`)).statusCode).toBe(422);
  });
});

describe("PF-5 active candidates on end-client projects", () => {
  const active = async (key: Key, period = PERIOD) => {
    const r = await call(key, "GET", `/api/v1/performance/active-candidates?${period}`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as { total: number; items: { placementId: string; client: string; joiningDate: string; endDate: string | null }[] };
  };

  it("shows placements on a project during the period to the recruiter's hierarchy", async () => {
    for (const k of ["r1a", "l1", "m1", "ad", "ceo"] as Key[]) {
      const a = await active(k);
      expect(a.items.map((i) => i.placementId), k).toEqual([ids.active]);
    }
    expect((await active("r1a")).items[0]).toMatchObject({ client: "Northwind Financial", joiningDate: "2030-02-15", endDate: null });
    for (const k of ["r1b", "l3", "r2a", "m2"] as Key[]) expect((await active(k)).total, k).toBe(0);
    // A later period: both, for the AD.
    const later = `from=2030-03-01T00:00:00Z&to=2030-04-01T00:00:00Z&tz=UTC`;
    expect((await active("ad", later)).items.map((i) => i.placementId).sort()).toEqual([ids.active, ids.activeLater].sort());
  });
});

describe("PF-4 targets", () => {
  let target = "";
  const body = (o: Record<string, unknown> = {}) => ({ userId: U.r1a, periodKind: "month", periodStart: "2030-03-01", submissions: 5, interviews: 2, placements: 1, ...o });
  const list = async (key: Key, q = "") => {
    const r = await call(key, "GET", `/api/v1/performance/targets${q}`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as { items: { id: string; status: string; canManage: boolean; actuals: Record<string, number | null>; periodEnd: string }[] };
  };

  it("a manager sets and replaces a target in their hierarchy; actuals follow the period", async () => {
    const r = await call("m1", "PUT", "/api/v1/performance/targets", body());
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ created: true, target: { user: { id: U.r1a }, periodKind: "month", periodStart: "2030-03-01", periodEnd: "2030-03-31",
      targets: { submissions: 5, interviews: 2, placements: 1 }, actuals: { submissions: 3, interviews: 2, placements: 1 }, status: "inProgress", canManage: true,
      setBy: { id: U.m1 } } });
    target = r.json().target.id;
    const again = await call("m1", "PUT", "/api/v1/performance/targets", body({ submissions: 3 }));
    expect(again.json()).toMatchObject({ created: false, target: { id: target, status: "met" } });
    const audit = (await db.admin.query("SELECT action, actor_id, changes FROM eureka.audit_event WHERE entity_id = $1 ORDER BY seq", [target])).rows;
    expect(audit.map((a) => a.action)).toEqual(["performance.target_created", "performance.target_updated"]);
  });

  it("a period that ended short shows as below", async () => {
    const r = await call("m1", "PUT", "/api/v1/performance/targets", { userId: U.r1b, periodKind: "week", periodStart: "2026-06-01", submissions: 2 });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().target).toMatchObject({ status: "below", actuals: { submissions: 0, interviews: null, placements: null }, periodEnd: "2026-06-07" });
  });

  it("everyone in scope reads; only the manage scope may change", async () => {
    expect((await list("r1a")).items.map((i) => [i.id, i.canManage])).toEqual([[target, false]]);
    expect((await list("l1")).items.map((i) => i.canManage)).toEqual([false, false]);
    expect((await list("m1")).items.every((i) => i.canManage)).toBe(true);
    expect((await list("m2")).items).toEqual([]);
    expect((await list("ceo")).items).toHaveLength(2);
    expect((await list("m1", `?userId=${U.r1a}&from=2030-03-15&through=2030-03-20`)).items.map((i) => i.id)).toEqual([target]);
    expect((await list("m1", "?from=2030-04-01")).items).toEqual([]);
    expect((await call("m1", "GET", "/api/v1/performance/targets?from=2030-04-01&through=2030-03-01")).statusCode).toBe(422);
  });

  it("read before write: 404 unknown, 403 outside scope, yourself or without the permission, 422 invalid", async () => {
    expect((await call("m1", "PUT", "/api/v1/performance/targets", body({ userId: NIL }))).statusCode).toBe(404);
    const out = await call("m1", "PUT", "/api/v1/performance/targets", body({ userId: U.r3a }));
    expect([out.statusCode, out.json().detail]).toEqual([403, "not_in_scope"]);
    const self = await call("m1", "PUT", "/api/v1/performance/targets", body({ userId: U.m1 }));
    expect([self.statusCode, self.json().detail]).toEqual([403, "self_change"]);
    for (const k of ["l1", "r1a", "ceo", "admin"] as Key[]) {
      expect((await call(k, "PUT", "/api/v1/performance/targets", body())).statusCode, k).toBe(403);
    }
    expect((await call("m1", "PUT", "/api/v1/performance/targets", body({ periodStart: "2030-03-02" }))).statusCode).toBe(422);
    expect((await call("m1", "PUT", "/api/v1/performance/targets", body({ periodKind: "week", periodStart: "2030-03-05" }))).statusCode).toBe(422);
    expect((await call("m1", "PUT", "/api/v1/performance/targets", body({ submissions: null, interviews: null, placements: null }))).statusCode).toBe(422);
    expect((await call("m1", "PUT", "/api/v1/performance/targets", body({ submissions: 1.5 }))).statusCode).toBe(422);
    expect((await call("m1", "PUT", "/api/v1/performance/targets", body({ extra: 1 }))).statusCode).toBe(422);
    // The AD may set the manager's target.
    expect((await call("ad", "PUT", "/api/v1/performance/targets", body({ userId: U.m1 }))).statusCode).toBe(200);
  });

  it("delete: 404 where not visible, 403 without the manage scope, 204 and audited", async () => {
    expect((await call("m2", "DELETE", `/api/v1/performance/targets/${target}`)).statusCode).toBe(404);
    expect((await call("l1", "DELETE", `/api/v1/performance/targets/${target}`)).statusCode).toBe(403);
    expect((await call("m1", "DELETE", `/api/v1/performance/targets/${NIL}`)).statusCode).toBe(404);
    expect((await call("m1", "DELETE", `/api/v1/performance/targets/${target}`)).statusCode).toBe(204);
    expect((await list("r1a")).items).toEqual([]);
    const audit = (await db.admin.query("SELECT action FROM eureka.audit_event WHERE entity_id = $1 ORDER BY seq", [target])).rows;
    expect(audit.at(-1)).toEqual({ action: "performance.target_deleted" });
  });
});

describe("PF-7 people, team moves and designations", () => {
  type P = { id: string; canSetTarget: boolean; canChangeDesignation: boolean; canMoveTeam: boolean; memberOfTeamId: string | null };
  const people = async (key: Key) => {
    const r = await call(key, "GET", "/api/v1/performance/people");
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as { people: P[]; moveTeams: { id: string }[] };
  };

  it("lists the people in scope with what the caller may do for each", async () => {
    const m = await people("m1");
    const by = Object.fromEntries(m.people.map((p) => [p.id, p]));
    expect(Object.keys(by).sort()).toEqual([U.m1, U.l1, U.l2, U.r1a, U.r1b, U.r2a].sort());
    expect(by[U.r1a]).toMatchObject({ canSetTarget: true, canChangeDesignation: true, canMoveTeam: true, memberOfTeamId: T.t1 });
    expect(by[U.l1]).toMatchObject({ canSetTarget: true, canChangeDesignation: true, canMoveTeam: false });
    expect(by[U.m1]).toMatchObject({ canSetTarget: false, canChangeDesignation: false, canMoveTeam: false });
    expect(m.moveTeams.map((t) => t.id).sort()).toEqual([T.t1, T.t2].sort());
    const l = await people("l1");
    expect(l.people.every((p) => !p.canSetTarget && !p.canChangeDesignation && !p.canMoveTeam)).toBe(true);
    expect(l.moveTeams).toEqual([]);
  });

  it("designation:change within the hierarchy (404, 403, 422) and access:manage through Users & Access", async () => {
    const put = (k: Key, user: string, designation: unknown, admin = false) =>
      call(k, "PUT", admin ? `/api/v1/admin/users/${user}/designation` : `/api/v1/users/${user}/designation`, { designation });
    const ok = await put("m1", U.r1a, " Senior Recruiter ");
    expect([ok.statusCode, ok.json()]).toEqual([200, { id: U.r1a, designation: "Senior Recruiter" }]);
    expect((await db.admin.query("SELECT designation FROM eureka.app_user WHERE id = $1", [U.r1a])).rows[0].designation).toBe("Senior Recruiter");
    const audit = (await db.admin.query(
      "SELECT actor_id, changes FROM eureka.audit_event WHERE action = 'user.designation_changed' AND entity_id = $1 ORDER BY seq", [U.r1a])).rows;
    expect(audit).toEqual([{ actor_id: U.m1, changes: { designation: "Senior Recruiter", previous: null, via: "hierarchy" } }]);

    expect((await put("ad", U.m1, "Manager II")).statusCode).toBe(200);
    const out = await put("m1", U.r3a, "X");
    expect([out.statusCode, out.json().detail]).toEqual([403, "not_in_scope"]);
    const self = await put("m1", U.m1, "X");
    expect([self.statusCode, self.json().detail]).toEqual([403, "self_change"]);
    expect((await put("m1", NIL, "X")).statusCode).toBe(404);
    for (const k of ["r1a", "l1", "ceo", "admin", "hr"] as Key[]) expect((await put(k, U.r1b, "X")).statusCode, k).toBe(403);
    expect((await put("m1", U.r1a, "bad\u0007")).statusCode).toBe(422);
    expect((await put("m1", U.r1a, "x".repeat(121))).statusCode).toBe(422);
    expect((await put("m1", U.r1a, undefined)).statusCode).toBe(422);

    // Users & Access: access:manage only; any user; null clears.
    expect((await put("m1", U.r1a, "X", true)).statusCode).toBe(403);
    const admin = await put("admin", U.r3a, "Recruiter", true);
    expect([admin.statusCode, admin.json()]).toEqual([200, { id: U.r3a, designation: "Recruiter" }]);
    expect((await put("admin", U.r1a, null, true)).json()).toEqual({ id: U.r1a, designation: null });
    expect((await put("admin", U.admin, "X", true)).statusCode).toBe(403);
    expect((await put("admin", NIL, "X", true)).statusCode).toBe(404);
  });
});
