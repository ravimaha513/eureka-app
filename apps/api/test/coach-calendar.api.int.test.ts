import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, U, seedFixtures } from "./fixtures.js";
import { extraUser, newCandidate, selectedSubmission } from "./placement-seed.js";

/** Coach calendar (docs/coach-calendar-api.md): only the CEO decides who sees which coach. */
let db: TestDb;
let app: NestFastifyApplication;
let coach2: string;
const SECRET = "test-secret-test-secret-test-secret-123";
const FROM = "2033-03-01T00:00:00Z", TO = "2033-03-08T00:00:00Z";
const WINDOW = `?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`;
const sessions = new Map<string, { cookie: string; csrf: string }>();

async function session(user: string) {
  let s = sessions.get(user);
  if (!s) {
    const key = Object.entries(U).find(([, id]) => id === user)?.[0] ?? "coach2";
    const r = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: `${key}@eureka.example` } });
    expect(r.statusCode, r.body).toBe(204);
    const cookie = String(r.headers["set-cookie"]).split(";")[0]!;
    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
    s = { cookie, csrf: me.json<{ csrfToken: string }>().csrfToken };
    sessions.set(user, s);
  }
  return s;
}
async function call(user: string, method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) {
  const s = await session(user);
  return app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }), headers: { cookie: s.cookie, "x-csrf-token": s.csrf } });
}
const grid = async (user: string) => {
  const r = await call(user, "GET", `/api/v1/coach-calendar${WINDOW}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json<{ canManage: boolean; coaches: { id: string; name: string; detail: string }[]; events: { coachId: string; interviewId: string | null; candidateName: string | null; round: string | null; callStatus: string | null }[] }>();
};
const grant = async (b: object) => {
  const r = await call(U.ceo, "POST", "/api/v1/coach-calendar/grants", b);
  expect(r.statusCode, r.body).toBe(201);
  return r.json<{ id: string }>().id;
};
const clearGrants = () => db.admin.query(`DELETE FROM eureka.coach_calendar_grant`);
const interview = async (coachId: string, startsAt: string, callStatus = "scheduled") => {
  const cand = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
  const sub = await selectedSubmission(db, U.r1a, cand.id, "interview_requested");
  return asUser(db.app, U.r1a, async (c) => {
    const id = (await c.query<{ id: string }>(
      `INSERT INTO eureka.interview (submission_id, round, starts_at, ends_at)
       VALUES ($1, 'R1', $2::timestamptz, $2::timestamptz + interval '1 hour') RETURNING id`, [sub, startsAt])).rows[0]!.id;
    await c.query(`UPDATE eureka.interview SET coach_id = $2, call_status = $3 WHERE id = $1`, [id, coachId, callStatus]);
    return id;
  }, true);
};

let live: string;

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  coach2 = (await extraUser(db, "coach2", "interview_coach")).id;
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: SECRET, GOOGLE_HOSTED_DOMAIN: "eureka.example",
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
  live = await interview(U.coach, "2033-03-02T15:00:00Z");
  await interview(coach2, "2033-03-02T16:00:00Z");
  await interview(U.coach, "2033-03-03T15:00:00Z", "cancelled");
  await interview(U.coach, "2033-04-03T15:00:00Z");
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

describe("who sees the grid", () => {
  it("the CEO sees every coach at full detail, without cancelled interviews or ones outside the window", async () => {
    await clearGrants();
    const g = await grid(U.ceo);
    expect(g.canManage).toBe(true);
    expect(g.coaches.map((c) => c.id).sort()).toEqual([U.coach, coach2].sort());
    expect(g.coaches.every((c) => c.detail === "full")).toBe(true);
    expect(g.events).toHaveLength(2);
    const e = g.events.find((x) => x.coachId === U.coach)!;
    expect(e).toMatchObject({ interviewId: live, round: "R1", callStatus: "scheduled" });
    expect(e.candidateName).toEqual(expect.any(String));
  });

  it("the Interview Lead sees every coach at full detail without a grant, but cannot manage", async () => {
    await clearGrants();
    const g = await grid(U.il);
    expect(g.canManage).toBe(false);
    expect(g.coaches.map((c) => c.id).sort()).toEqual([U.coach, coach2].sort());
    expect(g.coaches.every((c) => c.detail === "full")).toBe(true);
    expect(g.events).toHaveLength(2);
    expect(g.events.find((x) => x.coachId === U.coach)).toMatchObject({ interviewId: live, round: "R1", callStatus: "scheduled" });
    const me = (await call(U.il, "GET", "/api/v1/me")).json<{ capabilities: string[] }>();
    expect(me.capabilities).toContain("coach_calendar:read");
  });

  it("a coach sees only themself; holding interview:read gives no access; nobody else is in by default", async () => {
    await clearGrants();
    const g = await grid(U.coach);
    expect(g.canManage).toBe(false);
    expect(g.coaches.map((c) => c.id)).toEqual([U.coach]);
    expect(g.events.every((e) => e.coachId === U.coach)).toBe(true);
    for (const u of [U.ad, U.m1, U.r1a, U.admin, U.hr]) {
      expect((await call(u, "GET", `/api/v1/coach-calendar${WINDOW}`)).statusCode, u).toBe(403);
    }
  });

  it("a busy-only grant carries times and nothing else", async () => {
    await clearGrants();
    await grant({ granteeRole: "hr", allCoaches: true, detail: "busy" });
    const g = await grid(U.hr);
    expect(g.coaches.every((c) => c.detail === "busy")).toBe(true);
    expect(g.events).toHaveLength(2);
    for (const e of g.events) expect(e).toMatchObject({ interviewId: null, candidateName: null, round: null, callStatus: null });
  });

  it("a user grant covers only the chosen coach and only that user", async () => {
    await clearGrants();
    await grant({ granteeUserId: U.m1, allCoaches: false, coachIds: [coach2], detail: "full" });
    const g = await grid(U.m1);
    expect(g.coaches.map((c) => c.id)).toEqual([coach2]);
    expect(g.events.map((e) => e.coachId)).toEqual([coach2]);
    expect((await call(U.m2, "GET", `/api/v1/coach-calendar${WINDOW}`)).statusCode).toBe(403);
  });

  it("role and user grants add up, at the highest detail per coach", async () => {
    await clearGrants();
    await grant({ granteeRole: "manager", allCoaches: true, detail: "busy" });
    await grant({ granteeUserId: U.m1, allCoaches: false, coachIds: [U.coach], detail: "full" });
    const detail = Object.fromEntries((await grid(U.m1)).coaches.map((c) => [c.id, c.detail]));
    expect(detail).toEqual({ [U.coach]: "full", [coach2]: "busy" });
  });

  it("removing a grant takes access away at once, and /me follows", async () => {
    await clearGrants();
    const caps = async () => (await call(U.m1, "GET", "/api/v1/me")).json<{ capabilities: string[] }>().capabilities;
    expect(await caps()).not.toContain("coach_calendar:read");
    const id = await grant({ granteeUserId: U.m1, allCoaches: true, detail: "busy" });
    expect(await caps()).toContain("coach_calendar:read");
    expect((await call(U.ceo, "DELETE", `/api/v1/coach-calendar/grants/${id}`)).statusCode).toBe(204);
    expect(await caps()).not.toContain("coach_calendar:read");
    expect((await call(U.m1, "GET", `/api/v1/coach-calendar${WINDOW}`)).statusCode).toBe(403);
    expect((await call(U.ceo, "DELETE", `/api/v1/coach-calendar/grants/${id}`)).statusCode).toBe(404);
  });

  it("refuses a window over 31 days, or one that ends before it starts", async () => {
    const bad = async (from: string, to: string) => call(U.ceo, "GET", `/api/v1/coach-calendar?from=${from}&to=${to}`);
    expect((await bad("2033-01-01", "2033-03-01")).statusCode).toBe(422);
    expect((await bad("2033-03-01", "2033-02-01")).statusCode).toBe(422);
  });
});

describe("only the CEO decides", () => {
  it("every other role is refused on the manage routes, including admin, the lead and a viewer with a grant", async () => {
    await clearGrants();
    await grant({ granteeUserId: U.il, allCoaches: true, detail: "full" });
    const id = (await db.admin.query<{ id: string }>(`SELECT id FROM eureka.coach_calendar_grant LIMIT 1`)).rows[0]!.id;
    for (const u of [U.il, U.admin, U.ad, U.coach, U.hr]) {
      expect((await call(u, "GET", "/api/v1/coach-calendar/grants")).statusCode, u).toBe(403);
      expect((await call(u, "GET", "/api/v1/coach-calendar/people?q=a")).statusCode, u).toBe(403);
      expect((await call(u, "POST", "/api/v1/coach-calendar/grants", { granteeUserId: u, allCoaches: true, detail: "full" })).statusCode, u).toBe(403);
      expect((await call(u, "DELETE", `/api/v1/coach-calendar/grants/${id}`)).statusCode, u).toBe(403);
    }
  });

  it("the database refuses too: no direct writes, and the functions re-check", async () => {
    const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
    const { default: pg } = await import("pg");
    const c = new pg.Client({ connectionString: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}` });
    await c.connect();
    try {
      await c.query(`SELECT set_config('eureka.user_id', $1, false)`, [U.il]);
      await expect(c.query(`INSERT INTO eureka.coach_calendar_grant (grantee_user, all_coaches, detail) VALUES ($1, true, 'full')`, [U.il])).rejects.toThrow(/permission denied/);
      await expect(c.query(`SELECT authz.coach_calendar_grant_set(NULL, $1, true, '{}', 'full')`, [U.il])).rejects.toThrow(/not_permitted/);
      await expect(c.query(`SELECT authz.coach_calendar_grant_delete(gen_random_uuid())`)).rejects.toThrow(/not_permitted/);
      expect((await c.query(`SELECT * FROM eureka.coach_calendar_grant`)).rows).toEqual([]);
      await c.query(`SELECT set_config('eureka.user_id', '', false)`);
      expect((await c.query(`SELECT * FROM authz.coach_calendar_visible()`)).rows).toEqual([]);
    } finally {
      await c.end();
    }
  });

  it("a permission on a custom role gives nothing: refused, not cloned, and powerless if forced in", async () => {
    await clearGrants();
    const clone = await call(U.admin, "POST", "/api/v1/admin/roles", { label: "Vice CEO", cloneFrom: "ceo" });
    expect(clone.statusCode, clone.body).toBe(201);
    const key = clone.json<{ key: string }>().key;
    const perms = await db.admin.query(`SELECT permission FROM eureka.role_permission WHERE role_key = $1 AND permission LIKE 'coach_calendar:%'`, [key]);
    expect(perms.rows).toEqual([]);
    const set = await call(U.admin, "PUT" as "POST", `/api/v1/admin/roles/${key}/grants`, { grants: { "coach_calendar:manage": "org" } });
    expect(set.statusCode, set.body).toBe(422);
    expect(set.json<{ detail: string }>().detail).toBe("ceo_only_permission");
    expect((await call(U.admin, "GET", "/api/v1/admin/permissions")).body).not.toContain("coach_calendar");
    // Even written straight into the table, it does not make someone the CEO.
    await db.admin.query(`INSERT INTO eureka.role_permission (role_key, permission, scope) VALUES ($1, 'coach_calendar:manage', 'org'), ($1, 'coach_calendar:read', 'org')`, [key]);
    const vice = (await extraUser(db, "vice", "accounts")).id;
    await db.admin.query(`INSERT INTO eureka.user_role (user_id, role_key) VALUES ($1, $2)`, [vice, key]);
    const app2 = async (m: "GET" | "POST", url: string, b?: object) => {
      const r = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: "vice@eureka.example" } });
      const cookie = String(r.headers["set-cookie"]).split(";")[0]!;
      const csrf = (await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } })).json<{ csrfToken: string }>().csrfToken;
      return app.inject({ method: m, url, ...(b ? { payload: b } : {}), headers: { cookie, "x-csrf-token": csrf } });
    };
    expect((await app2("GET", "/api/v1/coach-calendar/grants")).statusCode).toBe(403);
    expect((await app2("POST", "/api/v1/coach-calendar/grants", { granteeUserId: vice, allCoaches: true, detail: "full" })).statusCode).toBe(403);
    expect((await app2("GET", `/api/v1/coach-calendar${WINDOW}`)).statusCode).toBe(403);
    expect((await db.admin.query(`SELECT 1 FROM eureka.coach_calendar_grant`)).rows).toEqual([]);
  });

  it("admins can't be given access, by name or role, and a grant stops when its holder is an admin", async () => {
    await clearGrants();
    const post = (b: object) => call(U.ceo, "POST", "/api/v1/coach-calendar/grants", b);
    expect((await post({ granteeUserId: U.admin, allCoaches: true, detail: "full" })).json<{ detail: string }>().detail).toBe("invalid_grantee");
    expect((await call(U.ceo, "GET", "/api/v1/coach-calendar/grants")).json<{ roles: { key: string }[] }>().roles.map((r) => r.key)).not.toContain("org_admin");
    await db.admin.query(`BEGIN; SET LOCAL session_replication_role = replica;
      INSERT INTO eureka.coach_calendar_grant (grantee_user, all_coaches, detail, created_by, updated_by) VALUES ('${U.admin}', true, 'full', '${U.ceo}', '${U.ceo}'); COMMIT`);
    expect((await call(U.admin, "GET", `/api/v1/coach-calendar${WINDOW}`)).statusCode).toBe(403);
  });

  it("access ends with the role, and deactivating deletes a user grant for good", async () => {
    await clearGrants();
    const acct = (await extraUser(db, "acct2", "accounts")).id;
    const login = async () => String((await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: "acct2@eureka.example" } })).headers["set-cookie"]).split(";")[0]!;
    const view = async () => app.inject({ method: "GET", url: `/api/v1/coach-calendar${WINDOW}`, headers: { cookie: await login() } });
    await grant({ granteeRole: "accounts", allCoaches: true, detail: "busy" });
    expect((await view()).statusCode).toBe(200);
    await clearGrants();
    await grant({ granteeUserId: acct, allCoaches: true, detail: "busy" });
    expect((await view()).statusCode).toBe(200);
    await asUser(db.app, U.admin, (c) => c.query(`SELECT authz.admin_set_user_status($1, false)`, [acct]), true);
    expect((await db.admin.query(`SELECT 1 FROM eureka.coach_calendar_grant WHERE grantee_user = $1`, [acct])).rows).toEqual([]);
    await asUser(db.app, U.admin, (c) => c.query(`SELECT authz.admin_set_user_status($1, true)`, [acct]), true);
    expect((await db.admin.query(`SELECT 1 FROM eureka.coach_calendar_grant WHERE grantee_user = $1`, [acct])).rows).toEqual([]);

    await clearGrants();
    const hr2 = (await extraUser(db, "hr2", "documents_team")).id;
    await grant({ granteeRole: "documents_team", allCoaches: true, detail: "busy" });
    const hrView = async () => app.inject({ method: "GET", url: `/api/v1/coach-calendar${WINDOW}`, headers: { cookie: String((await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: "hr2@eureka.example" } })).headers["set-cookie"]).split(";")[0]! } });
    expect((await hrView()).statusCode).toBe(200);
    await db.admin.query(`UPDATE eureka.user_role SET valid = tstzrange(lower(valid), now()) WHERE user_id = $1`, [hr2]);
    expect((await hrView()).statusCode).toBe(403);
  });

  it("archiving a role deletes its grant, so restoring does not bring access back", async () => {
    await clearGrants();
    const made = await call(U.admin, "POST", "/api/v1/admin/roles", { label: "Calendar Watchers", cloneFrom: "accounts" });
    expect(made.statusCode, made.body).toBe(201);
    const key = made.json<{ key: string }>().key;
    await grant({ granteeRole: key, allCoaches: true, detail: "busy" });
    expect((await call(U.admin, "POST", `/api/v1/admin/roles/${key}/archive`)).statusCode).toBe(204);
    expect((await db.admin.query(`SELECT 1 FROM eureka.coach_calendar_grant`)).rows).toEqual([]);
  });

  it("the audit says who lost access", async () => {
    await clearGrants();
    const id = await grant({ granteeUserId: U.m1, allCoaches: false, coachIds: [U.coach], detail: "full" });
    expect((await call(U.ceo, "DELETE", `/api/v1/coach-calendar/grants/${id}`)).statusCode).toBe(204);
    const a = await db.admin.query<{ changes: object }>(`SELECT changes FROM eureka.audit_event WHERE action = 'coach_calendar.revoked' AND entity_id = $1`, [id]);
    expect(a.rows[0]!.changes).toEqual({ granteeType: "user", granteeRole: null, granteeUserId: U.m1, allCoaches: false, coachIds: [U.coach], detail: "full" });
  });

  it("validates the grant: role, person, coaches; the body is strict", async () => {
    const post = (b: object) => call(U.ceo, "POST", "/api/v1/coach-calendar/grants", b);
    const code = async (b: object) => { const r = await post(b); expect(r.statusCode, r.body).toBe(422); return r.json<{ detail: string }>().detail; };
    expect(await code({ granteeRole: "ceo", allCoaches: true, detail: "full" })).toBe("invalid_grantee");
    expect(await code({ granteeRole: "org_admin", allCoaches: true, detail: "full" })).toBe("invalid_grantee");
    expect(await code({ granteeRole: "nope", allCoaches: true, detail: "full" })).toBe("invalid_grantee");
    expect(await code({ granteeUserId: U.m1, allCoaches: false, coachIds: [U.m2], detail: "full" })).toBe("invalid_coaches");
    expect((await post({ allCoaches: true, detail: "full" })).statusCode).toBe(422);
    expect((await post({ granteeRole: "hr", granteeUserId: U.m1, allCoaches: true, detail: "full" })).statusCode).toBe(422);
    expect((await post({ granteeRole: "hr", allCoaches: true, coachIds: [U.coach], detail: "full" })).statusCode).toBe(422);
    expect((await post({ granteeRole: "hr", allCoaches: false, detail: "full" })).statusCode).toBe(422);
    expect((await post({ granteeRole: "hr", allCoaches: true, detail: "all" })).statusCode).toBe(422);
  });

  it("granting again replaces, lists names and audits settings without names", async () => {
    await clearGrants();
    const a = await grant({ granteeRole: "hr", allCoaches: true, detail: "busy" });
    const b = await grant({ granteeRole: "hr", allCoaches: false, coachIds: [U.coach, U.coach], detail: "full" });
    expect(b).toBe(a);
    const list = (await call(U.ceo, "GET", "/api/v1/coach-calendar/grants")).json<{ items: { id: string; grantee: { name: string }; allCoaches: boolean; coaches: { id: string }[]; detail: string }[]; roles: { key: string }[]; coaches: unknown[] }>();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ id: a, grantee: { type: "role", role: "hr", name: "HR" }, allCoaches: false, coaches: [{ id: U.coach }], detail: "full" });
    expect(list.roles.map((r) => r.key)).not.toEqual(expect.arrayContaining(["ceo"]));
    expect(list.coaches).toHaveLength(2);
    const audit = await db.admin.query<{ changes: object }>(`SELECT changes FROM eureka.audit_event WHERE action = 'coach_calendar.granted' AND entity_id = $1 ORDER BY seq DESC LIMIT 1`, [a]);
    expect(audit.rows[0]!.changes).toMatchObject({ granteeType: "role", granteeRole: "hr", allCoaches: false, detail: "full" });
  });

  it("person search returns active people by name only, and treats wildcards as text", async () => {
    const r = (await call(U.ceo, "GET", "/api/v1/coach-calendar/people?q=coach2")).json<{ items: Record<string, unknown>[] }>();
    expect(r.items.length).toBeGreaterThan(0);
    expect(Object.keys(r.items[0]!).sort()).toEqual(["id", "name"]);
    expect((await call(U.ceo, "GET", "/api/v1/coach-calendar/people?q=%25")).json<{ items: unknown[] }>().items).toEqual([]);
  });
});
