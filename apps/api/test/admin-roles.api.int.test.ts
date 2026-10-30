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
  department: { id: string; name: string } | null;
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
    // Trait edits are refused while a request is pending? No: only holders count. Turning admin off is fine here.
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
