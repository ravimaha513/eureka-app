import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { can, type Permission } from "@eureka/shared";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, U, seedFixtures, toUserAccess, type FixtureCandidate } from "./fixtures.js";

let db: TestDb;
let app: NestFastifyApplication;
let candidates: FixtureCandidate[];
const SECRET = "test-secret-test-secret-test-secret-123";
const NIL = "00000000-0000-0000-0000-00000000beef";

beforeAll(async () => {
  db = await createTestDb();
  candidates = await seedFixtures(db.admin);
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test",
    AUTH_MODE: "dev",
    SESSION_SECRET: SECRET,
    GOOGLE_HOSTED_DOMAIN: "eureka.example",
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
}, 90_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

type Method = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
type Session = { cookie: string; csrf: string };
const sessions = new Map<string, Session>();

async function newSession(key: keyof typeof U): Promise<Session> {
  const res = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: `${key}@eureka.example` } });
  expect(res.statusCode).toBe(204);
  const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
  const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
  return { cookie, csrf: me.json().csrfToken as string };
}

async function login(key: keyof typeof U): Promise<Session> {
  const cached = sessions.get(key);
  if (cached) return cached;
  const s = await newSession(key);
  sessions.set(key, s);
  return s;
}

async function call(key: keyof typeof U, method: Method, url: string, payload?: unknown, csrf = true) {
  const s = await login(key);
  return app.inject({
    method, url, payload: payload as never,
    headers: { cookie: s.cookie, ...(csrf && method !== "GET" ? { "x-csrf-token": s.csrf } : {}) },
  });
}

const users = Object.keys(U) as (keyof typeof U)[];
const audits = async (action: string) =>
  (await db.admin.query(`SELECT actor_id, entity_id, changes FROM eureka.audit_event WHERE action = $1 ORDER BY seq`, [action])).rows;

/** Every admin endpoint, with a request that changes nothing when an admin makes it. */
const ADMIN_ENDPOINTS: { method: Method; url: string; body?: unknown; adminStatus: number }[] = [
  { method: "GET", url: "/api/v1/admin/meta", adminStatus: 200 },
  { method: "GET", url: "/api/v1/admin/users", adminStatus: 200 },
  { method: "POST", url: "/api/v1/admin/users", body: {}, adminStatus: 422 },
  { method: "POST", url: "/api/v1/admin/users/bulk", body: {}, adminStatus: 422 },
  { method: "POST", url: `/api/v1/admin/users/${NIL}/deactivate`, adminStatus: 404 },
  { method: "POST", url: `/api/v1/admin/users/${NIL}/reactivate`, adminStatus: 404 },
  { method: "PUT", url: `/api/v1/admin/users/${U.r1a}/manager`, body: {}, adminStatus: 422 },
  // performance (migration 0111): designation through Users & Access.
  { method: "PUT", url: `/api/v1/admin/users/${U.r1a}/designation`, body: {}, adminStatus: 422 },
  { method: "POST", url: "/api/v1/admin/role-requests", body: {}, adminStatus: 422 },
  { method: "GET", url: "/api/v1/admin/role-requests", adminStatus: 200 },
  { method: "POST", url: `/api/v1/admin/role-requests/${NIL}/approve`, adminStatus: 404 },
  { method: "POST", url: `/api/v1/admin/role-requests/${NIL}/reject`, adminStatus: 404 },
  { method: "DELETE", url: `/api/v1/admin/users/${U.r1a}/roles/bogus`, adminStatus: 422 },
  { method: "POST", url: "/api/v1/admin/locations", body: {}, adminStatus: 422 },
  { method: "GET", url: "/api/v1/admin/teams", adminStatus: 200 },
  { method: "POST", url: "/api/v1/admin/teams", body: {}, adminStatus: 422 },
  { method: "PATCH", url: `/api/v1/admin/teams/${T.t1}`, body: {}, adminStatus: 422 },
  { method: "PUT", url: `/api/v1/admin/teams/${T.t1}/lead`, body: {}, adminStatus: 422 },
  { method: "POST", url: `/api/v1/admin/teams/${T.t1}/members`, body: {}, adminStatus: 422 },
  { method: "POST", url: `/api/v1/admin/teams/${T.t1}/members/bulk`, body: {}, adminStatus: 422 },
  { method: "POST", url: `/api/v1/admin/teams/${T.t1}/coaches`, body: {}, adminStatus: 422 },
  { method: "DELETE", url: `/api/v1/admin/teams/${T.t1}/coaches/${NIL}`, adminStatus: 404 },
];
const MOVE = { method: "POST" as const, url: `/api/v1/teams/${T.t1}/move-member`, body: {} };

describe("authorization matrix (AD-1)", () => {
  const cases = users.flatMap((u) => ADMIN_ENDPOINTS.map((e) => [u, `${e.method} ${e.url}`, e] as const));
  it.each(cases)("%s → %s", async (key, _name, e) => {
    const res = await call(key, e.method, e.url, e.body);
    if (can(toUserAccess(key), "access:manage")) expect(res.statusCode, res.body).toBe(e.adminStatus);
    else {
      expect(res.statusCode, res.body).toBe(403);
      expect(res.headers["content-type"]).toContain("application/problem+json");
    }
  });

  it("only org_admin holds access:manage", () => {
    expect(users.filter((u) => can(toUserAccess(u), "access:manage")).sort()).toEqual(["admin", "admin2"]);
  });

  it.each(users)("%s → move-member (team:move_member)", async (key) => {
    const res = await call(key, MOVE.method, MOVE.url, MOVE.body);
    expect(res.statusCode, res.body).toBe(can(toUserAccess(key), "team:move_member" as Permission) ? 422 : 403);
  });

  it.each(users)("%s → lead team endpoints (team:add_member, AD-10)", async (key) => {
    const ok = can(toUserAccess(key), "team:add_member" as Permission);
    expect((await call(key, "GET", "/api/v1/teams/mine")).statusCode).toBe(ok ? 200 : 403);
    expect((await call(key, "POST", `/api/v1/teams/${T.t1}/members`, {})).statusCode).toBe(ok ? 422 : 403);
  });

  it.each(users)("%s → coach assignment endpoints (coach:assign, AD-11)", async (key) => {
    const ok = can(toUserAccess(key), "coach:assign" as Permission);
    expect((await call(key, "GET", "/api/v1/coach-assignments")).statusCode).toBe(ok ? 200 : 403);
    expect((await call(key, "POST", `/api/v1/teams/${T.t1}/coaches`, {})).statusCode).toBe(ok ? 422 : 403);
    // Nobody unknown is in anyone's subtree: 403 either way, nothing changes.
    expect((await call(key, "DELETE", `/api/v1/teams/${T.t1}/coaches/${NIL}`)).statusCode).toBe(403);
  });

  it("only the Interview Lead holds coach:assign", () => {
    expect(users.filter((u) => can(toUserAccess(u), "coach:assign" as Permission))).toEqual(["il"]);
  });

  it.each([...ADMIN_ENDPOINTS, MOVE])("unauthenticated $method $url → 401", async (e) => {
    const res = await app.inject({ method: e.method, url: e.url, payload: e.body as never });
    expect(res.statusCode).toBe(401);
  });

  it.each([...ADMIN_ENDPOINTS.filter((e) => e.method !== "GET"), MOVE])("missing CSRF $method $url → 403", async (e) => {
    const key = e === MOVE ? "m1" : "admin";
    const res = await call(key, e.method, e.url, e.body, false);
    expect(res.statusCode).toBe(403);
    expect(res.json().detail).toBe("Invalid CSRF token");
  });
});

describe("metadata and listings", () => {
  it("meta lists roles with restricted and location-bound flags, and locations", async () => {
    const r = (await call("admin", "GET", "/api/v1/admin/meta")).json();
    const byKey = Object.fromEntries(r.roles.map((x: { key: string }) => [x.key, x]));
    expect(byKey.hr).toEqual({ key: "hr", label: "HR", restricted: true, locationBound: false });
    expect(byKey.org_admin.restricted).toBe(true);
    expect(byKey.recruiter.restricted).toBe(false);
    expect(byKey.location_incharge).toMatchObject({ restricted: false, locationBound: true });
    expect(r.locations).toEqual([{ id: LOC.austin, name: "Austin" }, { id: LOC.dallas, name: "Dallas" }]);
  });

  it("meta reports single-admin mode (off by default)", async () => {
    expect((await call("admin", "GET", "/api/v1/admin/meta")).json().singleAdminMode).toBe(false);
  });

  it("users carry manager, roles and teams", async () => {
    const r = await call("admin", "GET", "/api/v1/admin/users?limit=200");
    expect(r.statusCode).toBe(200);
    const items = r.json().items as { id: string }[];
    const r1a = items.find((i) => i.id === U.r1a);
    expect(r1a).toMatchObject({
      email: "r1a@eureka.example", displayName: "r1a", status: "active", primaryLocation: null,
      manager: { id: U.l1, displayName: "l1" },
      roles: [{ key: "recruiter", label: "Recruiter", locationId: null, locationName: null }],
      teams: [{ id: T.t1, name: "Team Rohit", asLead: false }],
    });
    expect(items.find((i) => i.id === U.l1)).toMatchObject({ teams: [{ id: T.t1, asLead: true }] });
    expect(items.find((i) => i.id === U.locD)).toMatchObject({
      roles: [{ key: "location_ops_admin", locationId: LOC.dallas, locationName: "Dallas" }],
    });
  });

  it("users support search and cursor pagination", async () => {
    const s = (await call("admin", "GET", "/api/v1/admin/users?search=r1")).json();
    expect(s.items.map((i: { id: string }) => i.id).sort()).toEqual([U.r1a, U.r1b].sort());
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { items: { id: string }[]; nextCursor: string | null } =
        (await call("admin", "GET", `/api/v1/admin/users?limit=7${cursor ? `&cursor=${cursor}` : ""}`)).json();
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.length).toBe(users.length);
    expect((await call("admin", "GET", "/api/v1/admin/users?limit=500")).statusCode).toBe(422);
  });

  it("teams list lead, current members and coaches, plus the users who can be coaches (AD-11)", async () => {
    const r = (await call("admin", "GET", "/api/v1/admin/teams")).json();
    expect(r.items.find((t: { id: string }) => t.id === T.t1)).toEqual({
      id: T.t1, name: "Team Rohit", location: null, lead: { id: U.l1, displayName: "l1" }, department: null,
      members: [{ id: U.r1a, displayName: "r1a" }, { id: U.r1b, displayName: "r1b" }],
      coaches: [{ id: U.il, displayName: "il" }],
    });
    expect(r.coaches).toEqual([
      { id: U.coach, displayName: "coach", email: "coach@eureka.example", role: "interview_coach" },
      { id: U.il, displayName: "il", email: "il@eureka.example", role: "interview_lead" },
    ]);
  });
});

describe("locations", () => {
  it("org_admin creates a location, audited; duplicate names are 409, bad kind or timezone 422", async () => {
    const r = await call("admin", "POST", "/api/v1/admin/locations",
      { name: "Houston", kind: "office", state: "TX", timezone: "America/Chicago" });
    expect(r.statusCode).toBe(201);
    const { id } = r.json();
    const row = (await db.admin.query(`SELECT name, kind, state, timezone FROM eureka.location WHERE id = $1`, [id])).rows[0];
    expect(row).toEqual({ name: "Houston", kind: "office", state: "TX", timezone: "America/Chicago" });
    expect((await audits("admin.location.created")).at(-1)).toMatchObject({ actor_id: U.admin, entity_id: id });

    expect((await call("admin", "POST", "/api/v1/admin/locations", { name: "Houston", kind: "office" })).statusCode).toBe(409);
    expect((await call("admin", "POST", "/api/v1/admin/locations", { name: "Nowhere", kind: "warehouse" })).statusCode).toBe(422);
    expect((await call("admin", "POST", "/api/v1/admin/locations", { name: "Nowhere", kind: "remote", timezone: "Mars/Olympus" })).statusCode).toBe(422);
  });

  it("is refused to every other role", async () => {
    expect((await call("m1", "POST", "/api/v1/admin/locations", { name: "Sneaky", kind: "remote" })).statusCode).toBe(403);
    expect((await call("r1b", "POST", "/api/v1/admin/locations", { name: "Sneaky", kind: "remote" })).statusCode).toBe(403);
  });
});

describe("users", () => {
  it("creates a user in the hosted domain; duplicates are 409, other domains 422", async () => {
    const r = await call("admin", "POST", "/api/v1/admin/users",
      { email: "new.hire@eureka.example", displayName: "New Hire", designation: "Recruiter", primaryLocationId: LOC.dallas });
    expect(r.statusCode).toBe(201);
    const id = r.json().id as string;
    const dup = await call("admin", "POST", "/api/v1/admin/users", { email: "NEW.HIRE@eureka.example", displayName: "Again" });
    expect(dup.statusCode).toBe(409);
    const other = await call("admin", "POST", "/api/v1/admin/users", { email: "someone@gmail.com", displayName: "X" });
    expect(other.statusCode).toBe(422);
    const list = (await call("admin", "GET", "/api/v1/admin/users?search=new.hire")).json();
    expect(list.items).toEqual([expect.objectContaining({
      id, designation: "Recruiter", primaryLocation: { id: LOC.dallas, name: "Dallas" }, roles: [], teams: [], manager: null,
    })]);
    expect((await audits("admin.user.created")).at(-1)).toMatchObject({ actor_id: U.admin, entity_id: id });
  });

  describe("bulk create", () => {
    const bulk = (dryRun: boolean, rows: unknown[]) => call("admin", "POST", "/api/v1/admin/users/bulk", { dryRun, rows });
    const count = async (like: string) =>
      Number((await db.admin.query(`SELECT count(*) FROM eureka.app_user WHERE email LIKE $1`, [like])).rows[0].count);

    it("dry run reports every row and creates nothing", async () => {
      const r = await bulk(true, [
        { email: "bulk.dry1@eureka.example", displayName: "Dry One", location: "dallas" },
        { email: "bulk.dry2@eureka.example", displayName: "Dry Two" },
      ]);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ dryRun: true, committed: false, created: 0, failed: 0 });
      expect(await count("bulk.dry%")).toBe(0);
    });

    it("creates all rows with location by name, one audit event each", async () => {
      const before = (await audits("admin.user.created")).length;
      const r = await bulk(false, [
        { email: "bulk.ok1@eureka.example", displayName: "Ok One", designation: "Recruiter", location: "Dallas" },
        { email: "bulk.ok2@eureka.example", displayName: "Ok Two" },
      ]);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ committed: true, created: 2, failed: 0 });
      const list = (await call("admin", "GET", "/api/v1/admin/users?search=bulk.ok1")).json();
      expect(list.items[0]).toMatchObject({ designation: "Recruiter", primaryLocation: { id: LOC.dallas } });
      expect((await audits("admin.user.created")).length).toBe(before + 2);
      expect((await audits("admin.user.bulk_created")).at(-1)).toMatchObject({ actor_id: U.admin });
    });

    it("any bad row creates nobody and each failure is named", async () => {
      const r = await bulk(false, [
        { email: "bulk.good@eureka.example", displayName: "Good" },
        { email: "not-an-email", displayName: "Bad" },
        { email: "x@gmail.com", displayName: "Wrong domain" },
        { email: "bulk.noname@eureka.example", displayName: "  " },
        { email: "bulk.good@eureka.example", displayName: "Twice" },
        { email: "bulk.loc@eureka.example", displayName: "Loc", location: "Mars" },
        { email: "NEW.HIRE@eureka.example", displayName: "Exists" },
      ]);
      expect(r.statusCode, r.body).toBe(200);
      const body = r.json();
      expect(body).toMatchObject({ committed: false, created: 0, failed: 6 });
      expect(body.rows.map((x: { error?: string }) => x.error)).toEqual([
        undefined, "invalid_email", "email_domain", "name_required", "duplicate_in_file", "unknown_location", "email_exists",
      ]);
      expect(await count("bulk.good%")).toBe(0);
    });

    it("grants roles by label or key; restricted roles wait for a second approver", async () => {
      const rows = [
        { email: "bulk.role1@eureka.example", displayName: "Role One", location: "Dallas", roles: ["Recruiter", "location_incharge"] },
        { email: "bulk.role2@eureka.example", displayName: "Role Two", roles: ["hr"] },
      ];
      const dry = (await bulk(true, rows)).json();
      expect(dry).toMatchObject({ committed: false, failed: 0 });
      expect(dry.rows[1].roles).toEqual([{ role: "hr", label: "HR", status: "pending_approval" }]);
      expect(await count("bulk.role%")).toBe(0);

      const r = await bulk(false, rows);
      expect(r.statusCode, r.body).toBe(200);
      const body = r.json();
      expect(body).toMatchObject({ committed: true, created: 2, failed: 0 });
      expect(body.rows[0].roles).toEqual([
        { role: "recruiter", label: "Recruiter", status: "applied" },
        { role: "location_incharge", label: "Location Incharge", status: "applied" },
      ]);
      const held = (await db.admin.query(
        `SELECT role_key, location_id FROM eureka.user_role WHERE user_id = $1 ORDER BY role_key`, [body.rows[0].id])).rows;
      expect(held).toEqual([{ role_key: "location_incharge", location_id: LOC.dallas }, { role_key: "recruiter", location_id: null }]);
      const pending = (await db.admin.query(
        `SELECT role_key, status, requested_by FROM eureka.role_request WHERE user_id = $1`, [body.rows[1].id])).rows;
      expect(pending).toEqual([{ role_key: "hr", status: "pending", requested_by: U.admin }]);
      expect((await db.admin.query(`SELECT count(*)::int AS n FROM eureka.user_role WHERE user_id = $1`, [body.rows[1].id])).rows[0].n).toBe(0);
      const requested = (await audits("admin.role.requested")).at(-1);
      expect(requested).toMatchObject({ entity_id: body.rows[1].id, changes: { role: "hr", bulk: true } });
      // Withdraw it so later tests see only their own pending requests.
      expect((await call("admin", "POST", `/api/v1/admin/role-requests/${requested.changes.requestId}/reject`)).statusCode).toBe(200);
    });

    it("names role problems per row and creates nobody", async () => {
      const r = await bulk(false, [
        { email: "bulk.rgood@eureka.example", displayName: "Good", roles: ["Recruiter"] },
        { email: "bulk.r1@eureka.example", displayName: "Unknown", roles: ["Wizard"] },
        { email: "bulk.r2@eureka.example", displayName: "Twice", roles: ["Recruiter", "recruiter"] },
        { email: "bulk.r3@eureka.example", displayName: "Admin and data", roles: ["Org Admin", "Recruiter"] },
        { email: "bulk.r4@eureka.example", displayName: "No location", roles: ["Location Ops Admin"] },
      ]);
      expect(r.statusCode, r.body).toBe(200);
      const body = r.json();
      expect(body).toMatchObject({ committed: false, created: 0, failed: 4 });
      expect(body.rows.map((x: { error?: string }) => x.error)).toEqual([
        undefined, "unknown_role", "duplicate_role", "separation_of_duties", "location_required",
      ]);
      expect(await count("bulk.r%good%")).toBe(0);
    });

    it("serves the template as an .xlsx to admins only", async () => {
      const r = await call("admin", "GET", "/api/v1/admin/users/bulk/template");
      expect(r.statusCode).toBe(200);
      expect(r.headers["content-type"]).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      expect(r.rawPayload.subarray(0, 2).toString()).toBe("PK");
      expect((await call("ceo", "GET", "/api/v1/admin/users/bulk/template")).statusCode).toBe(403);
    });

    it("rejects an empty or oversized request", async () => {
      expect((await bulk(true, [])).statusCode).toBe(422);
      const many = Array.from({ length: 501 }, (_, i) => ({ email: `m${i}@eureka.example`, displayName: "M" }));
      expect((await bulk(true, many)).statusCode).toBe(422);
    });
  });

  it.each([
    ["deactivate self", "POST", `/api/v1/admin/users/${U.admin}/deactivate`, undefined],
    ["reactivate self", "POST", `/api/v1/admin/users/${U.admin}/reactivate`, undefined],
    ["own manager", "PUT", `/api/v1/admin/users/${U.admin}/manager`, { managerId: U.ceo }],
    ["someone to report to me", "PUT", `/api/v1/admin/users/${U.r1a}/manager`, { managerId: U.admin }],
    ["grant myself a role", "POST", "/api/v1/admin/role-requests", { userId: U.admin, role: "hr" }],
    ["revoke my own role", "DELETE", `/api/v1/admin/users/${U.admin}/roles/org_admin`, undefined],
    ["lead a team", "POST", "/api/v1/admin/teams", { name: "Mine", leadId: U.admin }],
    ["become a team lead", "PUT", `/api/v1/admin/teams/${T.t1}/lead`, { leadId: U.admin }],
    ["join a team", "POST", `/api/v1/admin/teams/${T.t1}/members`, { userId: U.admin }],
  ] as const)("self-change refused: %s", async (_n, method, url, body) => {
    const r = await call("admin", method, url, body);
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json().detail).toBe("self_change");
  });

  it("reporting line changes rebuild the closure; cycles are 422", async () => {
    expect((await call("admin", "PUT", `/api/v1/admin/users/${U.r1a}/manager`, { managerId: U.l2 })).statusCode).toBe(204);
    const { rows } = await db.admin.query(`SELECT 1 FROM eureka.reporting_closure WHERE ancestor_id = $1 AND descendant_id = $2`, [U.l2, U.r1a]);
    expect(rows).toHaveLength(1);
    const cyc = await call("admin", "PUT", `/api/v1/admin/users/${U.ceo}/manager`, { managerId: U.r1a });
    expect(cyc.statusCode).toBe(422);
    expect(cyc.json().detail).toBe("cycle");
    expect((await call("admin", "PUT", `/api/v1/admin/users/${U.r1a}/manager`, { managerId: U.l1 })).statusCode).toBe(204);
    expect((await audits("admin.user.manager")).length).toBe(2);
  });

  it("deactivation ends the user's existing session on the next request (AD-5)", async () => {
    const s = await newSession("acct");
    expect((await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: s.cookie } })).statusCode).toBe(200);
    expect((await call("admin", "POST", `/api/v1/admin/users/${U.acct}/deactivate`)).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: s.cookie } })).statusCode).toBe(401);
    const { rows } = await db.admin.query(`SELECT count(*)::int n FROM eureka.session WHERE user_id = $1 AND revoked_at IS NULL`, [U.acct]);
    expect(rows[0].n).toBe(0);
    expect((await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: "acct@eureka.example" } })).statusCode).toBe(403);

    expect((await call("admin", "POST", `/api/v1/admin/users/${U.acct}/reactivate`)).statusCode).toBe(204);
    // The old session stays revoked; roles must be granted again.
    expect((await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: s.cookie } })).statusCode).toBe(401);
    const fresh = await newSession("acct");
    const me = (await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: fresh.cookie } })).json();
    expect(me.roles).toEqual([]);
    expect((await audits("admin.user.deactivated")).at(-1)).toMatchObject({ actor_id: U.admin, entity_id: U.acct });
  });
});

describe("role requests (AD-3, AD-4, AD-6, AD-7)", () => {
  it("a non-restricted role applies immediately", async () => {
    const r = await call("admin", "POST", "/api/v1/admin/role-requests", { userId: U.coach, role: "recruiter" });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toEqual({ id: expect.any(String), status: "applied" });
    const me = (await call("coach", "GET", "/api/v1/me")).json();
    expect(me.roles.map((x: { key: string }) => x.key).sort()).toEqual(["interview_coach", "recruiter"]);
  });

  it("a restricted role needs a second admin: requester and grantee cannot approve, another admin can", async () => {
    const r = await call("admin", "POST", "/api/v1/admin/role-requests", { userId: U.r2a, role: "hr" });
    expect(r.json().status).toBe("pending_approval");
    const id = r.json().id as string;
    expect((await call("r2a", "GET", "/api/v1/me")).json().roles).toEqual([{ key: "recruiter", label: "Recruiter", locationId: null }]);

    const self = await call("admin", "POST", `/api/v1/admin/role-requests/${id}/approve`);
    expect(self.statusCode).toBe(403);
    expect(self.json().detail).toBe("second_approver_required");
    expect((await call("r2a", "POST", `/api/v1/admin/role-requests/${id}/approve`)).statusCode).toBe(403);

    const pending = (await call("admin2", "GET", "/api/v1/admin/role-requests?status=pending")).json().items;
    expect(pending).toEqual([expect.objectContaining({
      id, user: { id: U.r2a, displayName: "r2a", email: "r2a@eureka.example" }, role: "hr", roleLabel: "HR",
      locationId: null, requestedBy: { id: U.admin, displayName: "admin" }, status: "pending", decidedBy: null, decidedAt: null,
    })]);

    const ok = await call("admin2", "POST", `/api/v1/admin/role-requests/${id}/approve`);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ status: "approved" });
    expect((await call("r2a", "GET", "/api/v1/me")).json().capabilities).toContain("candidate.dob:read");
    const approved = (await call("admin", "GET", "/api/v1/admin/role-requests?status=approved")).json().items;
    expect(approved[0]).toMatchObject({ id, status: "approved", decidedBy: { id: U.admin2, displayName: "admin2" } });
    expect((await audits("admin.role_request.approved")).at(-1)).toMatchObject({ actor_id: U.admin2, entity_id: id });
    expect((await call("admin2", "POST", `/api/v1/admin/role-requests/${id}/approve`)).statusCode).toBe(409);
  });

  it("separation of duties: an admin cannot be given a business role (and so cannot approve their own)", async () => {
    const r = await call("admin", "POST", "/api/v1/admin/role-requests", { userId: U.admin2, role: "accounts" });
    expect(r.statusCode).toBe(422);
    expect(r.json().detail).toBe("separation_of_duties");
  });

  it("org_admin is itself restricted", async () => {
    const created = await call("admin", "POST", "/api/v1/admin/users", { email: "fresh-admin@eureka.example", displayName: "Fresh Admin" });
    expect(created.statusCode).toBe(201);
    const r = await call("admin", "POST", "/api/v1/admin/role-requests", { userId: created.json().id, role: "org_admin" });
    expect(r.json().status).toBe("pending_approval");
    expect((await call("admin2", "POST", `/api/v1/admin/role-requests/${r.json().id}/reject`)).statusCode).toBe(200);
  });

  it("a pending request expires after 7 days", async () => {
    const r = await call("admin", "POST", "/api/v1/admin/role-requests", { userId: U.r3a, role: "immigration" });
    const id = r.json().id as string;
    await db.admin.query(`UPDATE eureka.role_request SET requested_at = now() - interval '8 days', expires_at = now() - interval '1 day' WHERE id = $1`, [id]);
    const res = await call("admin2", "POST", `/api/v1/admin/role-requests/${id}/approve`);
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toBe("request_expired");
    const expired = (await call("admin", "GET", "/api/v1/admin/role-requests?status=expired")).json().items;
    expect(expired.map((i: { id: string }) => i.id)).toContain(id);
    const pending = (await call("admin", "GET", "/api/v1/admin/role-requests?status=pending")).json().items;
    expect(pending.map((i: { id: string }) => i.id)).not.toContain(id);
  });

  it("location-bound roles need a location; other roles reject one; revocation is immediate", async () => {
    const missing = await call("admin", "POST", "/api/v1/admin/role-requests", { userId: U.r3a, role: "location_incharge" });
    expect([missing.statusCode, missing.json().detail]).toEqual([422, "location_required"]);
    const extra = await call("admin", "POST", "/api/v1/admin/role-requests", { userId: U.r3a, role: "recruiter", locationId: LOC.dallas });
    expect([extra.statusCode, extra.json().detail]).toEqual([422, "location_not_allowed"]);
    const ok = await call("admin", "POST", "/api/v1/admin/role-requests", { userId: U.r3a, role: "location_incharge", locationId: LOC.austin });
    expect(ok.json().status).toBe("applied");
    expect((await call("r3a", "GET", "/api/v1/me")).json().roles).toContainEqual({ key: "location_incharge", label: "Location Incharge", locationId: LOC.austin });
    const bad = await call("admin", "DELETE", `/api/v1/admin/users/${U.r3a}/roles/recruiter?locationId=${LOC.austin}`);
    expect(bad.statusCode).toBe(422);
    const del = await call("admin", "DELETE", `/api/v1/admin/users/${U.r3a}/roles/location_incharge?locationId=${LOC.austin}`);
    expect(del.statusCode).toBe(204);
    expect((await call("r3a", "GET", "/api/v1/me")).json().roles.map((x: { key: string }) => x.key)).toEqual(["recruiter"]);
    expect((await call("admin", "DELETE", `/api/v1/admin/users/${U.r3a}/roles/location_incharge`)).statusCode).toBe(404);
    expect((await audits("admin.role.revoked")).at(-1)).toMatchObject({ entity_id: U.r3a, changes: { role: "location_incharge", locationId: LOC.austin } });
  });
});

describe("teams", () => {
  it("creates a team, changes its lead and adds a member; a member of another team is 409", async () => {
    const r = await call("admin", "POST", "/api/v1/admin/teams", { name: "Team New", leadId: U.l3, locationId: LOC.dallas });
    expect(r.statusCode).toBe(201);
    const id = r.json().id as string;
    expect((await call("admin", "PUT", `/api/v1/admin/teams/${id}/lead`, { leadId: U.m2 })).statusCode).toBe(204);
    expect((await call("admin", "POST", `/api/v1/admin/teams/${id}/members`, { userId: U.hr })).statusCode).toBe(204);
    const dup = await call("admin", "POST", `/api/v1/admin/teams/${T.t1}/members`, { userId: U.hr });
    expect([dup.statusCode, dup.json().detail]).toEqual([409, "already_member"]);
    const t = (await call("admin", "GET", "/api/v1/admin/teams")).json().items.find((x: { id: string }) => x.id === id);
    expect(t).toEqual({ id, name: "Team New", location: { id: LOC.dallas, name: "Dallas" }, lead: { id: U.m2, displayName: "m2" }, department: null, members: [{ id: U.hr, displayName: "hr" }], coaches: [] });
    expect((await call("admin", "PUT", `/api/v1/admin/teams/${NIL}/lead`, { leadId: U.m2 })).statusCode).toBe(404);
  });

  it("bulk add: adds each person on its own and reports the ones it skipped", async () => {
    const { id } = (await call("admin", "POST", "/api/v1/admin/teams", { name: "Team Bulk", leadId: U.l3 })).json() as { id: string };
    const before = (await call("admin", "GET", "/api/v1/admin/teams")).json().unassignedCount as number;
    const free = (await call("admin", "GET", "/api/v1/admin/users?status=active&team=none&limit=200")).json().items as { id: string; teams: unknown[] }[];
    expect(free.length).toBe(before);
    expect(free.every((u) => u.teams.length === 0)).toBe(true);
    const pick = free.filter((u) => u.id !== U.admin).slice(0, 2).map((u) => u.id);
    expect(pick).toHaveLength(2);
    const r = await call("admin", "POST", `/api/v1/admin/teams/${id}/members/bulk`, { userIds: [...pick, U.r1a, NIL, U.admin] });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({
      added: pick,
      failed: [{ userId: U.r1a, error: "already_member" }, { userId: NIL, error: "user_not_found" }, { userId: U.admin, error: "self_change" }],
    });
    const members = (await call("admin", "GET", `/api/v1/admin/users?team=${id}`)).json().items.map((u: { id: string }) => u.id);
    expect(members.sort()).toEqual([...pick].sort());
    expect((await call("admin", "GET", "/api/v1/admin/teams")).json().unassignedCount).toBe(before - 2);
    expect((await audits("admin.team.member_added")).slice(-2).map((a) => (a.changes as { userId: string }).userId)).toEqual(pick);
    expect((await call("admin", "POST", `/api/v1/admin/teams/${NIL}/members/bulk`, { userIds: [U.r3a] })).statusCode).toBe(404);
    expect((await call("admin", "POST", `/api/v1/admin/teams/${id}/members/bulk`, { userIds: [] })).statusCode).toBe(422);
  });

  it("users filter by role and primary location", async () => {
    const recruiters = (await call("admin", "GET", "/api/v1/admin/users?role=recruiter&limit=200")).json().items as { roles: { key: string }[] }[];
    expect(recruiters.length).toBeGreaterThan(0);
    expect(recruiters.every((u) => u.roles.some((x) => x.key === "recruiter"))).toBe(true);
    const dallas = (await call("admin", "GET", `/api/v1/admin/users?locationId=${LOC.dallas}&limit=200`)).json().items as { primaryLocation: { id: string } | null }[];
    expect(dallas.every((u) => u.primaryLocation?.id === LOC.dallas)).toBe(true);
  });

  it("renames a team; the audit row carries no name", async () => {
    const { id } = (await call("admin", "POST", "/api/v1/admin/teams", { name: "Team Old", leadId: U.l3 })).json() as { id: string };
    expect((await call("admin", "PATCH", `/api/v1/admin/teams/${id}`, { name: "  Team Renamed " })).statusCode).toBe(204);
    const t = (await call("admin", "GET", "/api/v1/admin/teams")).json().items.find((x: { id: string }) => x.id === id);
    expect(t.name).toBe("Team Renamed");
    expect((await audits("admin.team.renamed")).at(-1)).toMatchObject({ entity_id: id, changes: null });
    expect((await call("admin", "PATCH", `/api/v1/admin/teams/${id}`, { name: "   " })).statusCode).toBe(422);
    expect((await call("admin", "PATCH", `/api/v1/admin/teams/${NIL}`, { name: "X" })).statusCode).toBe(404);
    expect((await call("l1", "PATCH", `/api/v1/admin/teams/${T.t1}`, { name: "X" })).statusCode).toBe(403);
  });
});

describe("move member (OD-07, AD-8)", () => {
  const recruitedBy = async (user: string, team: string) =>
    (await db.admin.query(`SELECT id FROM eureka.candidate WHERE recruiter_id = $1 AND team_id = $2`, [user, team])).rows.map((r) => r.id as string);

  it("refuses teams outside the actor's scope and invalid reassign targets", async () => {
    const out = await call("m2", "POST", `/api/v1/teams/${T.t2}/move-member`, { userId: U.r2a, toTeamId: T.t3 });
    expect([out.statusCode, out.json().detail]).toEqual([403, "not_in_scope"]);
    const out2 = await call("m1", "POST", `/api/v1/teams/${T.t1}/move-member`, { userId: U.r1a, toTeamId: T.t3 });
    expect([out2.statusCode, out2.json().detail]).toEqual([403, "not_in_scope"]);
    const bad = await call("m1", "POST", `/api/v1/teams/${T.t1}/move-member`, { userId: U.r1a, toTeamId: T.t2, reassignTo: U.r2a });
    expect([bad.statusCode, bad.json().detail]).toEqual([422, "invalid_reassign_target"]);
    expect((await call("r1b", "POST", `/api/v1/teams/${T.t1}/move-member`, { userId: U.r1a, toTeamId: T.t2 })).statusCode).toBe(403);
    expect((await call("admin", "POST", `/api/v1/teams/${T.t1}/move-member`, { userId: U.r1a, toTeamId: T.t2 })).statusCode).toBe(403);
  });

  it("with reassignTo: candidates stay with the old team under the chosen recruiter", async () => {
    const mine = await recruitedBy(U.r1a, T.t1);
    expect(mine.length).toBe(candidates.filter((c) => c.recruiterId === U.r1a).length);
    const r = await call("m1", "POST", `/api/v1/teams/${T.t1}/move-member`, { userId: U.r1a, toTeamId: T.t2, reassignTo: U.r1b });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ movedCandidates: mine.length, reassignedTo: { id: U.r1b, displayName: "r1b" } });
    expect(await recruitedBy(U.r1a, T.t1)).toEqual([]);
    expect((await recruitedBy(U.r1b, T.t1))).toEqual(expect.arrayContaining(mine));
    const t2 = (await call("admin", "GET", "/api/v1/admin/teams")).json().items.find((x: { id: string }) => x.id === T.t2);
    expect(t2.members.map((m: { id: string }) => m.id).sort()).toEqual([U.r1a, U.r2a].sort());
    expect((await audits("team.member_moved")).at(-1)).toMatchObject({
      actor_id: U.m1, entity_id: T.t1,
      changes: { userId: U.r1a, fromTeamId: T.t1, toTeamId: T.t2, reassignedTo: U.r1b, movedCandidates: mine.length },
    });
  });

  it("without reassignTo: the old team's lead gets the candidates", async () => {
    const mine = await recruitedBy(U.r1b, T.t1);
    const r = await call("m1", "POST", `/api/v1/teams/${T.t1}/move-member`, { userId: U.r1b, toTeamId: T.t2 });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ movedCandidates: mine.length, reassignedTo: { id: U.l1, displayName: "l1" } });
    expect((await recruitedBy(U.l1, T.t1)).sort()).toEqual(mine.sort());
  });

  it("a user who is not in the source team is 422", async () => {
    const r = await call("m1", "POST", `/api/v1/teams/${T.t1}/move-member`, { userId: U.r2a, toTeamId: T.t2 });
    expect(r.statusCode).toBe(422);
  });
});

describe("lead adds members to their own team (AD-10)", () => {
  const NEW1 = "00000000-0000-0000-0000-0000000ad101";
  const NEW2 = "00000000-0000-0000-0000-0000000ad102";
  const GONE = "00000000-0000-0000-0000-0000000ad103";
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

  beforeAll(async () => {
    for (const [id, key, status] of [[NEW1, "new1", "active"], [NEW2, "new2", "active"], [GONE, "gone", "inactive"]] as const) {
      await db.admin.query(`INSERT INTO eureka.app_user (id, email, display_name, status) VALUES ($1, $2, $3, $4)`,
        [id, `${key}@eureka.example`, key, status]);
      await db.admin.query(`INSERT INTO eureka.user_role (user_id, role_key) VALUES ($1, 'recruiter')`, [id]);
    }
  });

  it("leads (team), managers and associate directors (hierarchy) hold team:add_member", () => {
    expect(users.filter((u) => can(toUserAccess(u), "team:add_member" as Permission)).sort()).toEqual(["ad", "l1", "l2", "l3", "m1", "m2"]);
  });

  it("managers and associate directors list the teams led in their hierarchy", async () => {
    // Earlier tests in this file change reporting lines, so read the expected teams from the closure.
    for (const key of ["m1", "m2", "ad"] as const) {
      const expected = (await db.admin.query(
        `SELECT t.id FROM eureka.team t WHERE t.lead_id = $1
            OR t.lead_id IN (SELECT descendant_id FROM eureka.reporting_closure WHERE ancestor_id = $1)`, [U[key]])).rows.map((r) => r.id);
      expect(expected.length, key).toBeGreaterThan(0);
      expect(ids((await call(key, "GET", "/api/v1/teams/mine")).json().items).sort(), key).toEqual(expected.sort());
    }
  });

  it("lists the lead's own team and only active recruiters in no team", async () => {
    const res = await call("l1", "GET", "/api/v1/teams/mine");
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(ids(body.items)).toEqual([T.t1]);
    const addable = ids(body.addable);
    expect(addable).toEqual(expect.arrayContaining([NEW1, NEW2]));
    expect(addable).not.toContain(GONE);
    expect(addable).not.toContain(U.l1);
    const inTeams = (await db.admin.query(`SELECT user_id FROM eureka.team_member WHERE valid @> now()`)).rows.map((r) => r.user_id);
    expect(addable.filter((id: string) => inTeams.includes(id))).toEqual([]);
    expect(body.addable[0]).toEqual({ id: expect.any(String), displayName: expect.any(String), email: expect.stringContaining("@") });
  });

  it("adds an unassigned recruiter, audited, and they leave the addable list", async () => {
    const r = await call("l1", "POST", `/api/v1/teams/${T.t1}/members`, { userId: NEW1 });
    expect(r.statusCode, r.body).toBe(204);
    expect((await audits("team.member_added")).at(-1)).toMatchObject({ actor_id: U.l1, entity_id: T.t1, changes: { userId: NEW1 } });
    const body = (await call("l1", "GET", "/api/v1/teams/mine")).json();
    expect(ids(body.items[0].members)).toContain(NEW1);
    expect(ids(body.addable)).not.toContain(NEW1);
    expect(ids(body.addable)).toContain(NEW2);
  });

  it("refuses other teams, non-recruiters, members of a team, inactive users, self and unknown teams", async () => {
    const add = async (key: keyof typeof U, team: string, userId: string) => {
      const r = await call(key, "POST", `/api/v1/teams/${team}/members`, { userId });
      return [r.statusCode, r.statusCode === 204 ? null : r.json().detail];
    };
    expect(await add("l1", T.t2, NEW2)).toEqual([403, "not_in_scope"]);
    expect(await add("l1", T.t1, U.hr)).toEqual([422, "not_a_recruiter"]);
    expect(await add("l1", T.t1, U.r3a)).toEqual([409, "already_member"]);
    expect(await add("l1", T.t1, GONE)).toEqual([422, "user_inactive"]);
    expect(await add("l1", T.t1, U.l1)).toEqual([403, "self_change"]);
    expect((await add("l1", NIL, NEW2))[0]).toBe(404);
    expect(await add("m2", T.t1, NEW2)).toEqual([403, "not_in_scope"]);
    expect((await add("admin", T.t1, NEW2))[0]).toBe(403);
    expect((await add("r1b", T.t1, NEW2))[0]).toBe(403);
    expect((await db.admin.query(`SELECT 1 FROM eureka.team_member WHERE user_id = $1`, [NEW2])).rowCount).toBe(0);
  });

  it("a manager adds to a team led by someone in their hierarchy", async () => {
    const r = await call("m1", "POST", `/api/v1/teams/${T.t2}/members`, { userId: NEW2 });
    expect(r.statusCode, r.body).toBe(204);
    expect((await audits("team.member_added")).at(-1)).toMatchObject({ actor_id: U.m1, entity_id: T.t2, changes: { userId: NEW2 } });
  });
});

describe("coach assignments (AD-11)", () => {
  const assign = async (key: keyof typeof U, url: string, userId: string) => {
    const r = await call(key, "POST", url, { userId });
    return [r.statusCode, r.statusCode === 204 ? null : r.json().detail];
  };
  const drop = async (key: keyof typeof U, url: string) => {
    const r = await call(key, "DELETE", url);
    return [r.statusCode, r.statusCode === 204 ? null : r.json().detail];
  };
  const open = async (coach: string) => (await db.admin.query<{ team_id: string }>(
    `SELECT team_id FROM eureka.coach_assignment WHERE coach_id = $1 AND valid @> now() ORDER BY team_id`, [coach])).rows.map((r) => r.team_id);

  it("lists every team with the lead's own coaches on it, and those coaches", async () => {
    const body = (await call("il", "GET", "/api/v1/coach-assignments")).json();
    expect(body.coaches).toEqual([{ id: U.coach, displayName: "coach", email: "coach@eureka.example", role: "interview_coach" }]);
    expect(body.items.map((t: { id: string }) => t.id).sort()).toEqual(expect.arrayContaining([T.t1, T.t2, T.t3]));
    const byId = new Map(body.items.map((t: { id: string; coaches: unknown[] }) => [t.id, t.coaches]));
    expect(byId.get(T.t2)).toEqual([{ id: U.coach, displayName: "coach" }]);
    // The lead's own assignment is the admin's to change, so it is not listed as theirs to manage.
    expect(byId.get(T.t1)).toEqual([]);
  });

  it("the Interview Lead assigns and unassigns a coach below them, audited with ids only; the coach's scope follows", async () => {
    expect(await assign("il", `/api/v1/teams/${T.t3}/coaches`, U.coach)).toEqual([204, null]);
    expect((await audits("team.coach_assigned")).at(-1)).toMatchObject({ actor_id: U.il, entity_id: T.t3, changes: { coachId: U.coach } });
    expect(await open(U.coach)).toEqual([T.t2, T.t3].sort());
    expect((await call("coach", "GET", "/api/v1/me")).statusCode).toBe(200);
    expect(await assign("il", `/api/v1/teams/${T.t3}/coaches`, U.coach)).toEqual([409, "already_assigned"]);
    expect(await drop("il", `/api/v1/teams/${T.t3}/coaches/${U.coach}`)).toEqual([204, null]);
    expect((await audits("team.coach_unassigned")).at(-1)).toMatchObject({ actor_id: U.il, entity_id: T.t3, changes: { coachId: U.coach } });
    expect(await open(U.coach)).toEqual([T.t2]);
    expect(await drop("il", `/api/v1/teams/${T.t3}/coaches/${U.coach}`)).toEqual([404, "not_assigned"]);
  });

  it("the Interview Lead cannot change themself or people outside their subtree", async () => {
    expect(await assign("il", `/api/v1/teams/${T.t3}/coaches`, U.il)).toEqual([403, "self_change"]);
    expect(await drop("il", `/api/v1/teams/${T.t1}/coaches/${U.il}`)).toEqual([403, "self_change"]);
    expect(await assign("il", `/api/v1/teams/${T.t3}/coaches`, U.r1a)).toEqual([403, "not_in_scope"]);
    expect((await assign("il", `/api/v1/teams/${NIL}/coaches`, U.coach))[0]).toBe(404);
    expect((await assign("ad", `/api/v1/teams/${T.t3}/coaches`, U.coach))[0]).toBe(403);
    expect(await open(U.il)).toEqual([T.t1]);
  });

  it("an org admin assigns any coach-role holder, refuses others, and unassigns", async () => {
    expect(await assign("admin", `/api/v1/admin/teams/${T.t3}/coaches`, U.il)).toEqual([204, null]);
    expect((await audits("admin.team.coach_assigned")).at(-1)).toMatchObject({ actor_id: U.admin, entity_id: T.t3, changes: { coachId: U.il } });
    expect(await assign("admin", `/api/v1/admin/teams/${T.t3}/coaches`, U.r1a)).toEqual([422, "not_a_coach"]);
    expect((await assign("admin", `/api/v1/admin/teams/${NIL}/coaches`, U.il))[0]).toBe(404);
    expect(await drop("admin", `/api/v1/admin/teams/${T.t3}/coaches/${U.il}`)).toEqual([204, null]);
    expect((await audits("admin.team.coach_unassigned")).at(-1)).toMatchObject({ actor_id: U.admin, entity_id: T.t3, changes: { coachId: U.il } });
    expect(await open(U.il)).toEqual([T.t1]);
  });
});
