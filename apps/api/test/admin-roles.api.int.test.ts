import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GRANTS, PERMISSIONS, ROLES } from "@eureka/shared";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { T, U, seedFixtures } from "./fixtures.js";

/** Custom roles, traits and ladders (docs/roles-api.md; migration 0311). */
let db: TestDb;
let app: NestFastifyApplication;
const SECRET = "test-secret-test-secret-test-secret-123";

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
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

async function login(key: keyof typeof U): Promise<Session> {
  const cached = sessions.get(key);
  if (cached) return cached;
  const res = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: `${key}@eureka.example` } });
  expect(res.statusCode).toBe(204);
  const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
  const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
  const s = { cookie, csrf: me.json().csrfToken as string };
  sessions.set(key, s);
  return s;
}

async function call(key: keyof typeof U, method: Method, url: string, payload?: unknown) {
  const s = await login(key);
  return app.inject({
    method, url, payload: payload as never,
    headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}) },
  });
}

const detail = (res: { json: () => { detail?: string } }) => res.json().detail;
const audits = async (action: string) =>
  (await db.admin.query<{ actor_id: string; changes: Record<string, unknown> }>(
    `SELECT actor_id, changes FROM eureka.audit_event WHERE action = $1 ORDER BY seq`, [action])).rows;

type RoleItem = {
  key: string; label: string; isSystem: boolean; restricted: boolean; holders: number; archivedAt: string | null;
  traits: { sales: boolean; locationBound: boolean; admin: boolean; recruiter: boolean; coach: boolean };
  track: string; level: number; grants: Record<string, string>; clonedFrom: string | null;
  department: { id: string; name: string } | null; rowVersion: number;
};
const roleOf = async (key: string, includeArchived = false): Promise<RoleItem | undefined> =>
  ((await call("admin", "GET", `/api/v1/admin/roles${includeArchived ? "?includeArchived=true" : ""}`)).json().items as RoleItem[])
    .find((r) => r.key === key);

describe("permission catalog", () => {
  it("lists every permission with its area and flags; scopes in order", async () => {
    const r = await call("admin", "GET", "/api/v1/admin/permissions");
    expect(r.statusCode).toBe(200);
    const items = r.json().items as { key: string; area: string; description: string; restricted: boolean; orgSensitive: boolean }[];
    expect(items.map((i) => i.key)).toEqual([...PERMISSIONS]);
    expect(items.find((i) => i.key === "visa:read")).toMatchObject({ area: "Documents", restricted: true, orgSensitive: false });
    expect(items.find((i) => i.key === "rate:read")).toMatchObject({ area: "Placements", restricted: false, orgSensitive: true });
    expect(items.find((i) => i.key === "notify.contract:receive")).toMatchObject({ area: "Notifications" });
    expect(items.every((i) => i.description.length > 0)).toBe(true);
    expect(r.json().scopes).toEqual(["own", "team", "coached", "coached_hierarchy", "hierarchy", "location", "org"]);
  });

  it("needs access:manage", async () => {
    expect((await call("l1", "GET", "/api/v1/admin/permissions")).statusCode).toBe(403);
    expect((await call("ceo", "GET", "/api/v1/admin/roles")).statusCode).toBe(403);
    expect((await call("hr", "POST", "/api/v1/admin/roles", { label: "X", cloneFrom: "hr" })).statusCode).toBe(403);
  });
});

describe("system roles", () => {
  it("are listed from the database with the catalog's grants, traits, ladder and holder counts", async () => {
    const r = await call("admin", "GET", "/api/v1/admin/roles");
    expect(r.statusCode).toBe(200);
    const items = r.json().items as RoleItem[];
    expect(items.map((i) => i.key).sort()).toEqual([...ROLES].sort());
    expect(items.every((i) => i.isSystem && i.archivedAt === null)).toBe(true);
    const lead = items.find((i) => i.key === "lead")!;
    expect(lead).toMatchObject({
      label: "Lead (Sales)", holders: 3, restricted: false, track: "sales", level: 2, clonedFrom: null, department: null,
      traits: { sales: true, locationBound: false, admin: false, recruiter: false, coach: false },
    });
    expect(lead.grants).toEqual(GRANTS.lead);
    expect(items.find((i) => i.key === "org_admin")).toMatchObject({ restricted: true, traits: { admin: true }, holders: 2 });
    expect(items.find((i) => i.key === "recruiter")).toMatchObject({ traits: { recruiter: true, sales: true }, level: 1 });
    expect(items.find((i) => i.key === "interview_lead")).toMatchObject({ traits: { coach: true }, track: "interview_prep", level: 2 });
    expect(items.find((i) => i.key === "hr")!.grants["notify.contract:receive"]).toBe("org");
    // Ladder order: track, then level.
    const sales = items.filter((i) => i.track === "sales").map((i) => i.key);
    expect(sales).toEqual(["recruiter", "lead", "manager", "assoc_director", "ceo"]);
  });

  it("cannot be edited, re-granted or archived", async () => {
    expect(detail(await call("admin", "PATCH", "/api/v1/admin/roles/lead", { label: "Team Lead" }))).toBe("system_role");
    expect(detail(await call("admin", "PUT", "/api/v1/admin/roles/lead/grants", { grants: { "rate:read": "org" } }))).toBe("system_role");
    expect(detail(await call("admin", "POST", "/api/v1/admin/roles/lead/archive"))).toBe("system_role");
    expect((await call("admin", "PATCH", "/api/v1/admin/roles/nope", { label: "x" })).statusCode).toBe(404);
    expect((await call("admin", "PATCH", "/api/v1/admin/roles/Bad-Key", { label: "x" })).statusCode).toBe(422);
  });

  it("appear in the admin meta with their ladder position", async () => {
    const meta = (await call("admin", "GET", "/api/v1/admin/meta")).json();
    expect(meta.roles.find((r: { key: string }) => r.key === "lead")).toMatchObject({
      label: "Lead (Sales)", restricted: false, locationBound: false, isSystem: true, track: "sales", level: 2, department: null,
    });
  });
});

describe("custom roles", () => {
  let key: string;

  it("are cloned from a role with its grants and traits; the key comes from the label", async () => {
    const r = await call("admin", "POST", "/api/v1/admin/roles", { label: " Senior Lead ", cloneFrom: "lead", description: "Leads with rates" });
    expect(r.statusCode, JSON.stringify(r.json())).toBe(201);
    key = r.json().key;
    expect(key).toBe("c_senior_lead");
    const role = (await roleOf(key))!;
    expect(role).toMatchObject({
      label: "Senior Lead", isSystem: false, restricted: false, holders: 0, clonedFrom: "lead", track: "sales", level: 2,
      traits: { sales: true, locationBound: false, admin: false, recruiter: false, coach: false },
    });
    expect(role.grants).toEqual(GRANTS.lead);
    expect(await audits("admin.role.created")).toMatchObject([{ actor_id: U.admin, changes: { key, clonedFrom: "lead", departmentId: null } }]);
    // A second role with the same label (ignoring case) is a conflict; a second key is derived when labels differ only in punctuation.
    expect(detail(await call("admin", "POST", "/api/v1/admin/roles", { label: "senior lead", cloneFrom: "lead" }))).toBe("role_exists");
    const r2 = await call("admin", "POST", "/api/v1/admin/roles", { label: "Senior-Lead!", cloneFrom: "lead" });
    expect(r2.json().key).toBe("c_senior_lead_2");
    expect((await call("admin", "POST", "/api/v1/admin/roles/c_senior_lead_2/archive")).statusCode).toBe(204);
    expect(detail(await call("admin", "POST", "/api/v1/admin/roles", { label: "Gone", cloneFrom: "c_senior_lead_2" }))).toBe("role_archived");
    expect(detail(await call("admin", "POST", "/api/v1/admin/roles", { label: "Gone", cloneFrom: "nope" }))).toBe("unknown_role");
  });

  it("edit label, ladder position and traits while nobody holds them", async () => {
    expect((await call("admin", "PATCH", `/api/v1/admin/roles/${key}`, { label: "Senior Lead II", level: 3, track: "sales" })).statusCode).toBe(204);
    expect((await call("admin", "PATCH", `/api/v1/admin/roles/${key}`, { traits: { recruiter: true } })).statusCode).toBe(204);
    expect(await roleOf(key)).toMatchObject({ label: "Senior Lead II", level: 3, traits: { recruiter: true, sales: true } });
    expect(detail(await call("admin", "PATCH", `/api/v1/admin/roles/${key}`, { label: "Lead (Sales)" }))).toBe("role_exists");
    expect((await call("admin", "PATCH", `/api/v1/admin/roles/${key}`, { level: 0 })).statusCode).toBe(422);
    expect(await audits("admin.role.updated")).toMatchObject([
      { changes: { key, fields: ["label", "track", "level"] } },
      { changes: { key, fields: ["traits"], traits: { recruiter: true } } },
    ]);
  });

  it("replace their grants; restricted is computed from them", async () => {
    const grants = { ...GRANTS.lead, "rate:read": "org", "candidate:read": null, "report:read": "hierarchy" };
    expect((await call("admin", "PUT", `/api/v1/admin/roles/${key}/grants`, { grants })).statusCode).toBe(204);
    const role = (await roleOf(key))!;
    expect(role.grants["rate:read"]).toBe("org");
    expect(role.grants["candidate:read"]).toBeUndefined();
    expect(role.grants["report:read"]).toBe("hierarchy");
    expect(role.restricted).toBe(true); // rate:read at org scope is org-sensitive (AD-3)
    expect(await audits("admin.role.grants_changed")).toMatchObject([
      { changes: { key, added: ["rate:read"], removed: ["candidate:read"], changed: ["report:read"] } },
    ]);
    expect(detail(await call("admin", "PUT", `/api/v1/admin/roles/${key}/grants`, { grants: { "nope:read": "org" } }))).toBe("unknown_permission");
    expect(detail(await call("admin", "PUT", `/api/v1/admin/roles/${key}/grants`, { grants: { "candidate:read": "location" } }))).toBe("location_scope_needs_location");
    expect((await call("admin", "PUT", `/api/v1/admin/roles/${key}/grants`, { grants: { "candidate:read": "galaxy" } })).statusCode).toBe(422);
    // Back to a non-restricted set for the grant below.
    expect((await call("admin", "PUT", `/api/v1/admin/roles/${key}/grants`, { grants: { ...GRANTS.lead, "report:read": "hierarchy" } })).statusCode).toBe(204);
    expect((await roleOf(key))!.restricted).toBe(false);
  });

  it("are granted like system roles and shape the holder's access", async () => {
    const req = await call("admin", "POST", "/api/v1/admin/role-requests", { userId: U.r1b, role: key });
    expect(req.statusCode).toBe(201);
    expect(req.json().status).toBe("applied");
    expect((await roleOf(key))!.holders).toBe(1);
    const me = (await call("r1b", "GET", "/api/v1/me")).json();
    expect(me.roles).toEqual(expect.arrayContaining([{ key, label: "Senior Lead II", locationId: null }]));
    expect(me.capabilities).toContain("candidate:create"); // a lead's grant the recruiter role lacks
    // Hierarchy-scoped report:read from the custom role: the dashboard groups by team like a manager would.
    expect((await call("r1b", "GET", "/api/v1/dashboard")).json().groupBy).toBe("team");
    const users = (await call("admin", "GET", `/api/v1/admin/users?role=${key}`)).json().items as { id: string; roles: { key: string; label: string }[] }[];
    expect(users.map((u) => u.id)).toEqual([U.r1b]);
    expect(users[0]!.roles).toEqual(expect.arrayContaining([{ key, label: "Senior Lead II", locationId: null, locationName: null }]));
    expect((await call("admin", "GET", "/api/v1/admin/users/summary")).json().roles).toEqual(
      expect.arrayContaining([{ key, label: "Senior Lead II", count: 1 }]));
  });

  it("in use: no new restricted grants, no trait changes, no archive; label and ladder still change", async () => {
    expect(detail(await call("admin", "PUT", `/api/v1/admin/roles/${key}/grants`, { grants: { ...GRANTS.lead, "visa:read": "org" } }))).toBe("role_in_use");
    expect(detail(await call("admin", "PUT", `/api/v1/admin/roles/${key}/grants`, { grants: { ...GRANTS.lead, "rate:read": "org" } }))).toBe("role_in_use");
    expect((await call("admin", "PUT", `/api/v1/admin/roles/${key}/grants`, { grants: { ...GRANTS.lead, "rate:read": "team" } })).statusCode).toBe(204);
    expect(detail(await call("admin", "PATCH", `/api/v1/admin/roles/${key}`, { traits: { coach: true } }))).toBe("role_in_use");
    expect((await call("admin", "PATCH", `/api/v1/admin/roles/${key}`, { traits: { recruiter: true } })).statusCode).toBe(204); // unchanged
    expect(detail(await call("admin", "POST", `/api/v1/admin/roles/${key}/archive`))).toBe("role_in_use");
    expect((await call("admin", "PATCH", `/api/v1/admin/roles/${key}`, { label: "Senior Lead III", level: 4 })).statusCode).toBe(204);
    // The holder's session sees the new grant on its next request (access_version bumped).
    expect((await call("r1b", "GET", "/api/v1/me")).json().capabilities).toContain("rate:read");
  });

  it("archive once revoked; archived roles leave the pickers and cannot be granted; restore brings them back", async () => {
    expect((await call("admin", "DELETE", `/api/v1/admin/users/${U.r1b}/roles/${key}`)).statusCode).toBe(204);
    expect((await call("admin", "POST", `/api/v1/admin/roles/${key}/archive`)).statusCode).toBe(204);
    expect(await roleOf(key)).toBeUndefined();
    expect((await roleOf(key, true))!.archivedAt).not.toBeNull();
    expect((await call("admin", "GET", "/api/v1/admin/meta")).json().roles.some((r: { key: string }) => r.key === key)).toBe(false);
    expect(detail(await call("admin", "POST", "/api/v1/admin/role-requests", { userId: U.r1b, role: key }))).toBe("role_archived");
    expect(detail(await call("admin", "PATCH", `/api/v1/admin/roles/${key}`, { label: "Back" }))).toBe("role_archived");
    expect((await call("admin", "POST", `/api/v1/admin/roles/${key}/restore`)).statusCode).toBe(204);
    expect((await roleOf(key))!.archivedAt).toBeNull();
    expect((await audits("admin.role.archived")).map((a) => a.changes.key)).toEqual(["c_senior_lead_2", key]);
    expect((await audits("admin.role.restored")).map((a) => a.changes.key)).toEqual([key]);
  });

  it("cloned from the admin role carry the admin trait: restricted, separated from data roles, counted as admins", async () => {
    const r = await call("admin", "POST", "/api/v1/admin/roles", { label: "Deputy Admin", cloneFrom: "org_admin" });
    expect(r.statusCode).toBe(201);
    expect(await roleOf("c_deputy_admin")).toMatchObject({ restricted: true, traits: { admin: true }, grants: GRANTS.org_admin });
    expect(detail(await call("admin", "POST", "/api/v1/admin/role-requests", { userId: U.r1a, role: "c_deputy_admin" }))).toBe("separation_of_duties");
    // The second admin may hold it (admin with admin); a restricted role waits for the other admin.
    const req = await call("admin", "POST", "/api/v1/admin/role-requests", { userId: U.admin2, role: "c_deputy_admin" });
    expect(req.json().status).toBe("pending_approval");
    expect((await call("admin2", "POST", `/api/v1/admin/role-requests/${req.json().id}/approve`)).statusCode).toBe(403);
    // Trait edits are refused while a request is pending? No: only holders count. But turning admin off while the
    // role still holds the admin-only permissions breaks admin separation (C-01); drop them first.
    expect(detail(await call("admin", "PATCH", "/api/v1/admin/roles/c_deputy_admin", { traits: { admin: false } })))
      .toBe("admin_permission_needs_admin_role");
    expect((await call("admin", "PUT", "/api/v1/admin/roles/c_deputy_admin/grants", { grants: { "chat:use": "own" } })).statusCode).toBe(204);
    expect((await call("admin", "PATCH", "/api/v1/admin/roles/c_deputy_admin", { traits: { admin: false } })).statusCode).toBe(204);
    expect((await roleOf("c_deputy_admin"))!.restricted).toBe(false);
  });

  it("bound to a department are granted only inside it, by key or by label in the bulk import", async () => {
    const dept = (await call("admin", "POST", "/api/v1/admin/departments", { name: "Healthcare BU" })).json().id as string;
    const sub = (await call("admin", "POST", "/api/v1/admin/departments", { name: "Healthcare East", parentId: dept })).json().id as string;
    const r = await call("admin", "POST", "/api/v1/admin/roles", { label: "Healthcare Recruiter", cloneFrom: "recruiter", departmentId: dept });
    expect(r.statusCode).toBe(201);
    expect(await roleOf("c_healthcare_recruiter")).toMatchObject({ department: { id: dept, name: "Healthcare BU" }, traits: { recruiter: true } });
    expect(detail(await call("admin", "POST", "/api/v1/admin/role-requests", { userId: U.r2a, role: "c_healthcare_recruiter" }))).toBe("role_department_mismatch");
    expect((await call("admin", "PUT", `/api/v1/admin/users/${U.r2a}/department`, { departmentId: sub })).statusCode).toBe(204);
    expect((await call("admin", "POST", "/api/v1/admin/role-requests", { userId: U.r2a, role: "c_healthcare_recruiter" })).json().status).toBe("applied");
    expect(detail(await call("admin", "PATCH", "/api/v1/admin/roles/c_healthcare_recruiter", { departmentId: null }))).toBe("role_in_use");
    const bulk = await call("admin", "POST", "/api/v1/admin/users/bulk", {
      dryRun: true, rows: [{ email: "newbie@eureka.example", displayName: "Newbie", roles: ["healthcare recruiter"] }],
    });
    expect(bulk.statusCode).toBe(200);
    expect(bulk.json().rows[0]).toMatchObject({ status: "error", error: "role_department_mismatch" });
    const unknown = await call("admin", "POST", "/api/v1/admin/users/bulk", {
      dryRun: true, rows: [{ email: "newbie@eureka.example", displayName: "Newbie", roles: ["c_senior_lead_2"] }],
    });
    expect(unknown.json().rows[0]).toMatchObject({ status: "error", error: "unknown_role" }); // archived: not offered
  });

  it("coach and recruiter traits drive eligibility: a cloned coach can be assigned, a cloned recruiter added to a team", async () => {
    expect((await call("admin", "POST", "/api/v1/admin/roles", { label: "Mock Interviewer", cloneFrom: "interview_coach" })).statusCode).toBe(201);
    expect((await call("admin", "POST", "/api/v1/admin/role-requests", { userId: U.acct, role: "c_mock_interviewer" })).json().status).toBe("applied");
    expect((await call("admin", "POST", `/api/v1/admin/teams/${T.t3}/coaches`, { userId: U.acct })).statusCode).toBe(204);
    expect(detail(await call("admin", "POST", `/api/v1/admin/teams/${T.t3}/coaches`, { userId: U.hr }))).toBe("not_a_coach");
    expect((await call("admin", "POST", "/api/v1/admin/roles", { label: "Sourcer", cloneFrom: "recruiter" })).statusCode).toBe(201);
    expect((await call("admin", "POST", "/api/v1/admin/role-requests", { userId: U.imm, role: "c_sourcer" })).json().status).toBe("applied");
    expect((await call("l3", "POST", `/api/v1/teams/${T.t3}/members`, { userId: U.imm })).statusCode).toBe(204);
    expect(detail(await call("l3", "POST", `/api/v1/teams/${T.t3}/members`, { userId: U.hr }))).toBe("not_a_recruiter");
  });
});

describe("admin separation (security review C-01)", () => {
  it("admin-only permissions go to admin-trait roles only, held or not", async () => {
    expect((await call("admin", "POST", "/api/v1/admin/roles", { label: "Ops Helper", cloneFrom: "recruiter" })).statusCode).toBe(201);
    for (const p of ["access:manage", "audit:read"]) {
      expect(detail(await call("admin", "PUT", "/api/v1/admin/roles/c_ops_helper/grants", { grants: { ...GRANTS.recruiter, [p]: "org" } })))
        .toBe("admin_permission_needs_admin_role");
    }
    // c_sourcer is held (previous block): no instant admin for its holders either.
    expect(detail(await call("admin", "PUT", "/api/v1/admin/roles/c_sourcer/grants", { grants: { ...GRANTS.recruiter, "access:manage": "org" } })))
      .toBe("admin_permission_needs_admin_role");
    expect((await roleOf("c_sourcer"))!.grants["access:manage"]).toBeUndefined();
    // A role with business permissions cannot take the admin trait.
    expect(detail(await call("admin", "PATCH", "/api/v1/admin/roles/c_ops_helper", { traits: { admin: true } })))
      .toBe("business_permission_on_admin_role");
    expect((await roleOf("c_ops_helper"))!.traits.admin).toBe(false);
  });

  it("admin-trait roles take no business permission; admin-compatible ones are fine", async () => {
    expect((await call("admin", "POST", "/api/v1/admin/roles", { label: "Access Admin", cloneFrom: "org_admin" })).statusCode).toBe(201);
    expect(detail(await call("admin", "PUT", "/api/v1/admin/roles/c_access_admin/grants", { grants: { ...GRANTS.org_admin, "candidate:read": "org" } })))
      .toBe("business_permission_on_admin_role");
    expect(detail(await call("admin", "PUT", "/api/v1/admin/roles/c_access_admin/grants", { grants: { ...GRANTS.org_admin, "rate:read": "own" } })))
      .toBe("business_permission_on_admin_role");
    // Removing an admin-compatible permission and putting it back is allowed.
    const { "chat:use": _chat, ...noChat } = GRANTS.org_admin;
    expect((await call("admin", "PUT", "/api/v1/admin/roles/c_access_admin/grants", { grants: noChat })).statusCode).toBe(204);
    expect((await call("admin", "PUT", "/api/v1/admin/roles/c_access_admin/grants", { grants: GRANTS.org_admin })).statusCode).toBe(204);
    expect((await roleOf("c_access_admin"))!.grants).toEqual(GRANTS.org_admin);
    const perms = (await call("admin", "GET", "/api/v1/admin/permissions")).json().items as { key: string; adminOnly: boolean; adminCompatible: boolean }[];
    expect(perms.filter((p) => p.adminOnly).map((p) => p.key).sort()).toEqual(["access:manage", "audit:read"]);
    expect(perms.find((p) => p.key === "chat:use")).toMatchObject({ adminOnly: false, adminCompatible: true });
  });

  describe("an older role that already breaks the rule", () => {
    beforeAll(async () => {
      await db.admin.query(`INSERT INTO eureka.role (key, label, cloned_from) VALUES ('c_legacy_mixed', 'Legacy Mixed', 'lead')`);
      await db.admin.query(`INSERT INTO eureka.role_permission (role_key, permission, scope)
        VALUES ('c_legacy_mixed', 'access:manage', 'org'), ('c_legacy_mixed', 'candidate:read', 'team')`);
      // HR holds it: access:manage without the admin trait.
      await db.admin.query(`INSERT INTO eureka.user_role (user_id, role_key) VALUES ($1, 'c_legacy_mixed')`, [U.hr]);
      await db.admin.query(`UPDATE eureka.app_user SET access_version = access_version + 1 WHERE id = $1`, [U.hr]);
    });

    it("is listed by GET /admin/roles/violations, with every built-in role compliant", async () => {
      const r = await call("admin", "GET", "/api/v1/admin/roles/violations");
      expect(r.statusCode).toBe(200);
      expect(r.json().items).toEqual([
        { key: "c_legacy_mixed", label: "Legacy Mixed", isSystem: false, admin: false, archived: false, holders: 1, permissions: ["access:manage"] },
      ]);
      expect((await call("r1a", "GET", "/api/v1/admin/roles/violations")).statusCode).toBe(403);
    });

    it("its holder passes the API's access:manage check but not authz.admin_guard (admin trait)", async () => {
      expect((await call("hr", "GET", "/api/v1/me")).json().capabilities).toContain("access:manage");
      const sneaky = await call("hr", "POST", "/api/v1/admin/roles", { label: "Sneaky", cloneFrom: "org_admin" });
      expect(sneaky.statusCode).toBe(403);
      expect((await call("hr", "GET", "/api/v1/admin/roles/violations")).statusCode).toBe(403);
      expect((await call("hr", "POST", "/api/v1/admin/role-requests", { userId: U.r1a, role: "c_legacy_mixed" })).statusCode).toBe(403);
      expect(await roleOf("c_sneaky")).toBeUndefined();
    });

    it("is not granted again (0510): 422 role_violates_admin_separation", async () => {
      const r = await call("admin", "POST", "/api/v1/admin/role-requests", { userId: U.r1a, role: "c_legacy_mixed" });
      expect(r.statusCode).toBe(422);
      expect(detail(r)).toBe("role_violates_admin_separation");
      const bulk = await call("admin", "POST", "/api/v1/admin/users/bulk", {
        dryRun: true, rows: [{ email: "legacy.bulk@eureka.example", displayName: "Legacy Bulk", roles: ["c_legacy_mixed"] }],
      });
      expect(bulk.statusCode, bulk.body).toBe(200);
      expect(bulk.json().rows[0]).toMatchObject({ status: "error", error: "role_violates_admin_separation" });
    });

    it("can still be edited without adding a violation, not cloned, and cleaned up", async () => {
      // Label and a business grant change: no new violation.
      expect((await call("admin", "PATCH", "/api/v1/admin/roles/c_legacy_mixed", { label: "Legacy Mixed II" })).statusCode).toBe(204);
      expect((await call("admin", "PUT", "/api/v1/admin/roles/c_legacy_mixed/grants",
        { grants: { "access:manage": "org", "candidate:read": "org" } })).statusCode).toBe(204);
      // Adding another admin-only permission is refused; so is a copy.
      expect(detail(await call("admin", "PUT", "/api/v1/admin/roles/c_legacy_mixed/grants",
        { grants: { "access:manage": "org", "candidate:read": "org", "audit:read": "org" } }))).toBe("admin_permission_needs_admin_role");
      expect(detail(await call("admin", "POST", "/api/v1/admin/roles", { label: "Legacy Copy", cloneFrom: "c_legacy_mixed" })))
        .toBe("admin_permission_needs_admin_role");
      // Dropping access:manage clears it from the report.
      expect((await call("admin", "PUT", "/api/v1/admin/roles/c_legacy_mixed/grants", { grants: { "candidate:read": "org" } })).statusCode).toBe(204);
      expect((await call("admin", "GET", "/api/v1/admin/roles/violations")).json().items).toEqual([]);
    });
  });
});

describe("admin is only admin, per user (migration 0510)", () => {
  it("GET /admin/roles classifies every role", async () => {
    const items = (await call("admin", "GET", "/api/v1/admin/roles?includeArchived=true")).json().items as
      (RoleItem & { classification: string })[];
    const cls = Object.fromEntries(items.map((r) => [r.key, r.classification]));
    expect(cls).toMatchObject({ org_admin: "admin", recruiter: "data", hr: "data", ceo: "data" });
    for (const r of items) expect(["admin", "data", "admin_compatible_only"], r.key).toContain(r.classification);
  });

  it("an admin-compatible role goes with an admin role; it then takes no business permission", async () => {
    expect((await call("admin", "POST", "/api/v1/admin/roles", { label: "Chat Only", cloneFrom: "recruiter" })).statusCode).toBe(201);
    expect((await call("admin", "PUT", "/api/v1/admin/roles/c_chat_only/grants", { grants: { "chat:use": "own" } })).statusCode).toBe(204);
    expect((await roleOf("c_chat_only")) as unknown).toMatchObject({ classification: "admin_compatible_only" });
    // Bulk import: Org Admin with the compatible role is fine, with a data role it is not (dry runs).
    const bulk = await call("admin", "POST", "/api/v1/admin/users/bulk", {
      dryRun: true, rows: [
        { email: "sep.ok@eureka.example", displayName: "Sep Ok", roles: ["Org Admin", "Chat Only"] },
        { email: "sep.bad@eureka.example", displayName: "Sep Bad", roles: ["Org Admin", "Recruiter"] },
      ],
    });
    expect(bulk.statusCode, bulk.body).toBe(200);
    expect(bulk.json().rows.map((r: { status: string; error?: string }) => r.error ?? r.status)).toEqual(["ok", "separation_of_duties"]);

    const req = await call("admin", "POST", "/api/v1/admin/role-requests", { userId: U.admin2, role: "c_chat_only" });
    expect(req.json(), req.body).toMatchObject({ status: "applied" });
    const r = await call("admin", "PUT", "/api/v1/admin/roles/c_chat_only/grants", { grants: { "chat:use": "own", "candidate:read": "own" } });
    expect(r.statusCode).toBe(422);
    expect(detail(r)).toBe("role_held_by_admin");
    expect((await roleOf("c_chat_only"))!.grants).toEqual({ "chat:use": "own" });
    // A data user may hold it too; an admin still may not get a data role.
    expect((await call("admin", "POST", "/api/v1/admin/role-requests", { userId: U.r1b, role: "c_chat_only" })).json()).toMatchObject({ status: "applied" });
    expect(detail(await call("admin", "POST", "/api/v1/admin/role-requests", { userId: U.admin2, role: "lead" }))).toBe("separation_of_duties");
    expect((await call("admin", "DELETE", `/api/v1/admin/users/${U.admin2}/roles/c_chat_only`)).statusCode).toBe(204);
    expect((await call("admin", "DELETE", `/api/v1/admin/users/${U.r1b}/roles/c_chat_only`)).statusCode).toBe(204);
  });

  it("GET /admin/users/violations lists users who already mix, for admins only; nothing is stripped", async () => {
    expect((await call("admin", "GET", "/api/v1/admin/users/violations")).json()).toEqual({ items: [] });
    await db.admin.query(`INSERT INTO eureka.user_role (user_id, role_key) VALUES ($1, 'immigration')`, [U.admin2]);
    try {
      const r = await call("admin", "GET", "/api/v1/admin/users/violations");
      expect(r.statusCode).toBe(200);
      expect(r.json().items).toEqual([
        { id: U.admin2, displayName: "admin2", status: "active", adminRoles: ["org_admin"], dataRoles: ["immigration"] },
      ]);
      expect((await call("r1a", "GET", "/api/v1/admin/users/violations")).statusCode).toBe(403);
      expect((await call("hr", "GET", "/api/v1/admin/users/violations")).statusCode).toBe(403);
    } finally {
      await db.admin.query(`DELETE FROM eureka.user_role WHERE user_id = $1 AND role_key = 'immigration'`, [U.admin2]);
    }
    expect((await call("admin", "GET", "/api/v1/admin/users/violations")).json()).toEqual({ items: [] });
  });
});

describe("optional If-Match on role edits (C-02)", () => {
  const version = async (key: string) => (await roleOf(key))!.rowVersion;
  const send = async (method: Method, url: string, payload: unknown, ifMatch?: string) => {
    const s = await login("admin");
    return app.inject({
      method, url, payload: payload as never,
      headers: { cookie: s.cookie, "x-csrf-token": s.csrf, ...(ifMatch !== undefined ? { "if-match": ifMatch } : {}) },
    });
  };

  it("GET /admin/roles returns rowVersion; a matching If-Match succeeds and the new version comes back as ETag", async () => {
    expect((await call("admin", "POST", "/api/v1/admin/roles", { label: "Versioned", cloneFrom: "lead" })).statusCode).toBe(201);
    expect(await version("c_versioned")).toBe(1);
    const put = await send("PUT", "/api/v1/admin/roles/c_versioned/grants", { grants: { ...GRANTS.lead, "report:read": "hierarchy" } }, `"1"`);
    expect(put.statusCode).toBe(204);
    expect(put.headers.etag).toBe(`"2"`);
    const patch = await send("PATCH", "/api/v1/admin/roles/c_versioned", { level: 3 }, "2");
    expect(patch.statusCode).toBe(204);
    expect(patch.headers.etag).toBe(`"3"`);
    expect(await version("c_versioned")).toBe(3);
    // A no-op edit keeps the version.
    expect((await send("PATCH", "/api/v1/admin/roles/c_versioned", { traits: { sales: true } }, "3")).headers.etag).toBe(`"3"`);
  });

  it("a stale If-Match is 412 and changes nothing; no header behaves as before", async () => {
    const before = (await roleOf("c_versioned"))!;
    const stale = await send("PUT", "/api/v1/admin/roles/c_versioned/grants", { grants: { "candidate:read": "own" } }, `"1"`);
    expect([stale.statusCode, detail(stale)]).toEqual([412, "stale"]);
    expect((await send("PATCH", "/api/v1/admin/roles/c_versioned", { label: "Lost" }, "2")).statusCode).toBe(412);
    expect(await roleOf("c_versioned")).toMatchObject({ label: before.label, grants: before.grants, rowVersion: before.rowVersion });
    // Two admins from the same screen: the first wins, the second is told.
    const v = before.rowVersion;
    const a = await send("PUT", "/api/v1/admin/roles/c_versioned/grants", { grants: GRANTS.lead }, `"${v}"`);
    const b = await send("PUT", "/api/v1/admin/roles/c_versioned/grants", { grants: { ...GRANTS.lead, "rate:read": "team" } }, `"${v}"`);
    expect([a.statusCode, b.statusCode]).toEqual([204, 412]);
    expect((await send("PATCH", "/api/v1/admin/roles/c_versioned", { label: "Versioned II" })).statusCode).toBe(204);
    expect((await roleOf("c_versioned"))!.grants).toEqual(GRANTS.lead);
  });
});
