import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { can, resolveScope, type UserAccess } from "@eureka/shared";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, TECH_ID, U, seedFixtures, toUserAccess } from "./fixtures.js";
import { extraUser, newCandidate } from "./placement-seed.js";
import { backdate, force, joinedEmployee, type Joined } from "./employee-seed.js";
import { emitEvent } from "./notification-seed.js";

/**
 * Employees gaps (migration 0150, docs/employees-api.md "0150"): employment
 * facts per assignment (payroll company, E-Verify, onboarded, pay rate),
 * employment history search, lead/recruiter on the list, joinings/exits with
 * payroll company, technology and first vs later assignment, Immigration's
 * report, active employees per month, team assignment after a project, and
 * the bench-time POC.
 */
let db: TestDb;
let app: NestFastifyApplication;
let today: string;
const extras: Record<string, { id: string; access: UserAccess }> = {};
const SECRET = "test-secret-test-secret-test-secret-123";
const CO = { a: "00000000-0000-4000-8000-00000000c0a1", b: "00000000-0000-4000-8000-00000000c0b2", gone: "00000000-0000-4000-8000-00000000c0c3" };
const VENDOR = "00000000-0000-4000-8000-00000000fe01";
const CLIENT2 = "00000000-0000-4000-8000-00000000c1e2";

const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  extras.ahr = await extraUser(db, "ahr", "associate_hr");
  extras.bu = await extraUser(db, "bu", "bu_head");
  today = (await db.admin.query<{ d: string }>(`SELECT CURRENT_DATE::text AS d`)).rows[0]!.d;
  for (const [id, name, status] of [[CO.a, "Eureka Payroll LLC", "active"], [CO.b, "Eureka Tech Inc", "active"], [CO.gone, "Old Entity", "inactive"]]) {
    await force(db, `INSERT INTO eureka.company (id, location_id, name, status, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$5)`,
      [id, LOC.dallas, name, status, U.admin]);
  }
  await db.admin.query(`INSERT INTO eureka.vendor (id, name) VALUES ($1, 'Prime Vendor Co')`, [VENDOR]);
  await db.admin.query(`INSERT INTO eureka.client (id, name) VALUES ($1, 'Contoso Health')`, [CLIENT2]);
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: SECRET,
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

type Key = keyof typeof U | "ahr" | "bu";
const ALL_KEYS: Key[] = [...(Object.keys(U) as (keyof typeof U)[]), "ahr", "bu"];
const accessOf = (k: Key): UserAccess => (k in U ? toUserAccess(k as keyof typeof U) : extras[k]!.access);
const idOf = (k: Key) => (k in U ? U[k as keyof typeof U] : extras[k]!.id);
const sessions = new Map<string, { cookie: string; csrf: string }>();

async function login(key: Key) {
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
async function call(key: Key, method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: unknown) {
  const s = await login(key);
  return app.inject({ method, url, payload: payload as never, headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}) } });
}
const audits = async (action: string, entityId?: string) => (await db.admin.query(
  `SELECT actor_id, entity_type, entity_id, changes FROM eureka.audit_event WHERE action = $1 AND ($2::uuid IS NULL OR entity_id = $2) ORDER BY seq`,
  [action, entityId ?? null])).rows;

async function onAssignment(o: Parameters<typeof joinedEmployee>[1] = {}): Promise<Joined> {
  const j = await joinedEmployee(db, o);
  await backdate(db, j, addDays(today, -60));
  return j;
}
async function benched(o: Parameters<typeof joinedEmployee>[1] = {}): Promise<Joined> {
  const j = await onAssignment(o);
  expect((await call("hr", "POST", `/api/v1/assignments/${j.assignmentId}/end`, { endDate: addDays(today, -1), reason: "completed" })).statusCode).toBe(200);
  return j;
}
const employment = (id: string, body: unknown, k: Key = "hr") => call(k, "PATCH", `/api/v1/assignments/${id}/employment`, body);

describe("database: assignment_employment and the 0150 functions", () => {
  it("RLS forced, no app writes, no app column privilege on pay_rate; functions not PUBLIC, search_path pinned", async () => {
    const t = (await db.admin.query(`SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE oid = 'eureka.assignment_employment'::regclass`)).rows[0];
    expect(t).toEqual({ r: true, f: true });
    const j = await onAssignment();
    await expect(asUser(db.app, U.hr, (c) => c.query(`INSERT INTO eureka.assignment_employment (assignment_id) VALUES ($1)`, [j.assignmentId])))
      .rejects.toThrow(/permission denied/);
    await expect(asUser(db.app, U.acct, (c) => c.query(`SELECT pay_rate FROM eureka.assignment_employment`))).rejects.toThrow(/permission denied/);
    // Even the owner cannot write around the definer function, delete or truncate.
    await expect(db.admin.query(`INSERT INTO eureka.assignment_employment (assignment_id) VALUES ($1)`, [j.assignmentId])).rejects.toThrow(/employment functions/);
    await expect(db.admin.query(`TRUNCATE eureka.assignment_employment`)).rejects.toThrow(/never truncated/);
    const fns = (await db.admin.query<{ proname: string; cfg: string[]; acl: string; secdef: boolean }>(
      `SELECT p.proname, p.proconfig AS cfg, coalesce(p.proacl::text, '') AS acl, p.prosecdef AS secdef FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'authz' AND p.proname IN ('payroll_companies','set_assignment_employment','assignment_pay_rates',
         'employment_movements','assign_employee_team','notification_recipients') ORDER BY 1`)).rows;
    expect(fns.map((f) => f.proname)).toEqual(["assign_employee_team", "assignment_pay_rates", "employment_movements",
      "notification_recipients", "payroll_companies", "set_assignment_employment"]);
    for (const f of fns) {
      expect(f.secdef, f.proname).toBe(true);
      expect(f.cfg, f.proname).toContain("search_path=pg_catalog, pg_temp");
      expect(f.acl, f.proname).not.toMatch(/(^|[{,])=X/);
    }
    await expect(db.worker.query(`SELECT * FROM authz.set_assignment_employment($1, '{}')`, [j.assignmentId])).rejects.toThrow(/permission denied/);
    await expect(asUser(db.app, U.hr, (c) => c.query(`SELECT * FROM authz.employment_team_context`))).rejects.toThrow(/permission denied/);
  });

  it("the definer re-checks rights: recruiters 404/403, HR may not set the pay rate, Accounts may; NULL-safe", async () => {
    const j = await onAssignment();
    const run = (u: string, ch: unknown) => asUser(db.app, u, (c) => c.query(`SELECT authz.set_assignment_employment($1, $2::jsonb) AS f`, [j.assignmentId, ch]));
    await expect(run(U.r2a, { everifyDate: today })).rejects.toThrow(/assignment_not_found/);
    await expect(run(U.l1, { everifyDate: today })).rejects.toThrow(/not_permitted/);
    await expect(run(U.hr, { payRate: 40 })).rejects.toThrow(/not_permitted/);
    await expect(run(U.hr, null)).rejects.toThrow(/invalid_field/);
    await expect(run(U.hr, { everifyDate: "2026-02-30" })).rejects.toThrow(/invalid_date/);
    await expect(run(U.hr, { payrollCompanyId: 7 })).rejects.toThrow(/invalid_company/);
    await expect(run(U.acct, { payRate: 40.123 })).rejects.toThrow(/invalid_rate/);
    await expect(asUser(db.app, U.hr, (c) => c.query(`SELECT authz.set_assignment_employment(NULL, '{"everifyDate": null}')`))).rejects.toThrow(/assignment_not_found/);
    const ok = await asUser(db.app, U.acct, (c) => c.query(`SELECT authz.set_assignment_employment($1, $2::jsonb) AS f`,
      [j.assignmentId, { payRate: 40.5, everifyDate: today }]), true);
    expect(ok.rows[0].f).toEqual(["everifyDate", "payRate"]);
    // The app reads everything but the rate; the stamp is the server's.
    const row = (await asUser(db.app, U.hr, (c) => c.query(
      `SELECT everify_date::text, updated_by FROM eureka.assignment_employment WHERE assignment_id = $1`, [j.assignmentId]))).rows[0];
    expect(row).toEqual({ everify_date: today, updated_by: U.acct });
    // Pay rate: Accounts (rate:read org), CEO (no employee write, but reads); HR none.
    const rates = async (u: string) => (await asUser(db.app, u, (c) => c.query(`SELECT * FROM authz.assignment_pay_rates($1)`, [j.personId]))).rows;
    expect(await rates(U.acct)).toEqual([{ assignment_id: j.assignmentId, pay_rate: "40.50" }]);
    expect(await rates(U.ceo)).toHaveLength(1);
    expect(await rates(U.hr)).toEqual([]);
    expect(await rates(U.m1)).toEqual([]); // rate:read, but no employee:read
  });

  it("the candidate guard still refuses team changes without candidate:assign outside the employment function", async () => {
    const j = await benched();
    // HR holds no candidate:update: the row is not updatable (RLS); the owning recruiter is stopped by the guard.
    expect((await asUser(db.app, U.hr, (c) => c.query(`UPDATE eureka.candidate SET team_id = $2 WHERE id = $1`, [j.candidateId, T.t2]))).rowCount).toBe(0);
    await expect(asUser(db.app, U.r1a, (c) => c.query(`UPDATE eureka.candidate SET team_id = $2 WHERE id = $1`, [j.candidateId, T.t2])))
      .rejects.toThrow(/not permitted to reassign/);
    // A forged marker is not writable by the app.
    await expect(asUser(db.app, U.hr, (c) => c.query(`INSERT INTO authz.employment_team_context VALUES (pg_current_xact_id(), $1)`, [j.candidateId])))
      .rejects.toThrow(/permission denied/);
  });

  it("document types E-Verify copy and Form 1099 are restricted", async () => {
    const rows = (await db.admin.query(`SELECT key, classification FROM authz.document_type WHERE key IN ('everify', 'form_1099') ORDER BY key`)).rows;
    expect(rows).toEqual([{ key: "everify", classification: "restricted" }, { key: "form_1099", classification: "restricted" }]);
  });
});

describe("employment facts through the API", () => {
  it("permission matrix: PATCH needs assignment:update; payroll companies need employee:read at org scope", async () => {
    const j = await onAssignment();
    for (const k of ALL_KEYS) {
      const access = accessOf(k);
      const code = (await employment(j.assignmentId, { bogus: 1 }, k)).statusCode;
      expect(code, k).toBe(can(access, "assignment:update") ? 422 : 403);
      const pcs = await call(k, "GET", "/api/v1/employees/payroll-companies");
      expect(pcs.statusCode, k).toBe(resolveScope(access, "employee:read")?.all ? 200 : 403);
    }
    const list = (await call("hr", "GET", "/api/v1/employees/payroll-companies")).json().items;
    expect(list).toEqual([
      { id: CO.a, name: "Eureka Payroll LLC", status: "active" }, { id: CO.b, name: "Eureka Tech Inc", status: "active" },
      { id: CO.gone, name: "Old Entity", status: "inactive" },
    ]);
  });

  it("HR sets the payroll company and dates; Accounts the pay rate; detail shows them; audit holds field names only", async () => {
    const j = await onAssignment();
    const r1 = await employment(j.assignmentId, { payrollCompanyId: CO.a, everifyDate: addDays(today, -58), onboardedDate: addDays(today, -59) });
    expect(r1.statusCode, r1.body).toBe(200);
    expect(r1.json()).toEqual({
      id: j.assignmentId, changed: ["payrollCompanyId", "everifyDate", "onboardedDate"],
      payrollCompany: { id: CO.a, name: "Eureka Payroll LLC" }, everifyDate: addDays(today, -58), onboardedDate: addDays(today, -59),
    });
    expect((await employment(j.assignmentId, { payRate: 42 })).statusCode).toBe(403);
    const r2 = await employment(j.assignmentId, { payRate: 42.25 }, "acct");
    expect([r2.statusCode, r2.json().payRate]).toEqual([200, 42.25]);
    expect((await audits("assignment.employment_updated", j.assignmentId)).map((a) => a.changes)).toEqual([
      { fields: ["payrollCompanyId", "everifyDate", "onboardedDate"], payrollCompanyId: CO.a }, { fields: ["payRate"] },
    ]);
    expect(JSON.stringify(await audits("assignment.employment_updated", j.assignmentId))).not.toContain("42.25");

    const hr = (await call("hr", "GET", `/api/v1/employees/${j.personId}`)).json();
    expect(hr.assignments[0]).toMatchObject({
      id: j.assignmentId, payrollCompany: { id: CO.a, name: "Eureka Payroll LLC" }, everifyDate: addDays(today, -58), onboardedDate: addDays(today, -59),
    });
    expect(hr.assignments[0]).not.toHaveProperty("payRate");
    expect(hr.assignment).toMatchObject({ payrollCompany: { id: CO.a }, everifyDate: addDays(today, -58) });
    expect((await call("acct", "GET", `/api/v1/employees/${j.personId}`)).json().assignments[0].payRate).toBe(42.25);
    expect((await call("ceo", "GET", `/api/v1/employees/${j.personId}`)).json().assignments[0].payRate).toBe(42.25);
    // The list never carries rates.
    expect(JSON.stringify((await call("acct", "GET", "/api/v1/employees?limit=200")).json())).not.toMatch(/payRate|42\.25/);
    // Clearing works; an unchanged value and an inactive company are refused.
    expect((await employment(j.assignmentId, { onboardedDate: null })).json().onboardedDate).toBeNull();
    const same = await employment(j.assignmentId, { payrollCompanyId: CO.a });
    expect([same.statusCode, same.json().detail]).toEqual([422, "unchanged"]);
    const gone = await employment(j.assignmentId, { payrollCompanyId: CO.gone });
    expect([gone.statusCode, gone.json().detail]).toEqual([422, "invalid_company"]);
    expect((await employment(j.assignmentId, { payrollCompanyId: "00000000-0000-4000-8000-0000000000ff" })).json().detail).toBe("invalid_company");
    expect((await employment(j.assignmentId, {})).statusCode).toBe(422);
    expect((await employment(j.assignmentId, { payRate: 0 }, "acct")).statusCode).toBe(422);
    expect((await employment(j.assignmentId, { updatedBy: U.hr })).statusCode).toBe(422);
    expect((await employment("00000000-0000-4000-8000-0000000000ff", { everifyDate: today })).statusCode).toBe(404);
  });

  it("ended assignments can be corrected (history)", async () => {
    const j = await benched();
    const r = await employment(j.assignmentId, { everifyDate: addDays(today, -50) }, "ahr");
    expect([r.statusCode, r.json().everifyDate]).toEqual([200, addDays(today, -50)]);
  });
});

describe("employee list: lead and recruiter; employment history search", () => {
  let cur: Joined, past: Joined, vend: Joined;
  beforeAll(async () => {
    cur = await onAssignment({ actor: U.r1a });
    past = await benched({ actor: U.r2a, teamId: T.t2 });
    vend = await onAssignment({ actor: U.r1b });
    await force(db, `UPDATE eureka.placement SET vendor_id = $2 WHERE id = $1`, [vend.placementId, VENDOR]);
    await force(db, `UPDATE eureka.placement SET client_id = $2 WHERE id = $1`, [vend.placementId, CLIENT2]);
    expect((await employment(past.assignmentId, { payrollCompanyId: CO.b })).statusCode).toBe(200);
  });
  const ids = (r: { json(): { items: { id: string }[] } }) => r.json().items.map((i) => i.id);

  it("items carry the team's lead and the candidate's recruiter, and the latest assignment's vendor", async () => {
    const items = (await call("hr", "GET", "/api/v1/employees?limit=200")).json().items as Record<string, any>[];
    expect(items.find((i) => i.id === cur.personId)).toMatchObject({ lead: { id: U.l1, name: "l1" }, recruiter: { id: U.r1a, name: "r1a" } });
    expect(items.find((i) => i.id === past.personId)).toMatchObject({ lead: { id: U.l2, name: "l2" }, recruiter: { id: U.r2a, name: "r2a" },
      assignment: { payrollCompany: { id: CO.b, name: "Eureka Tech Inc" } } });
    expect(items.find((i) => i.id === vend.personId)!.assignment.vendor).toEqual({ id: VENDOR, name: "Prime Vendor Co" });
  });

  it("client search matches past assignments too; clientMatch=current keeps the old behaviour", async () => {
    const client = (await db.admin.query(`SELECT client_id FROM eureka.placement WHERE id = $1`, [past.placementId])).rows[0].client_id;
    const any = ids(await call("hr", "GET", `/api/v1/employees?clientId=${client}&limit=200`));
    expect(any).toEqual(expect.arrayContaining([cur.personId, past.personId]));
    expect(any).not.toContain(vend.personId);
    const current = ids(await call("hr", "GET", `/api/v1/employees?clientId=${client}&clientMatch=current&limit=200`));
    expect(current).toContain(cur.personId);
    expect(current).not.toContain(past.personId);
    expect((await call("hr", "GET", `/api/v1/employees?clientMatch=past`)).statusCode).toBe(422);
  });

  it("filters by vendor and payroll company (any assignment)", async () => {
    expect(ids(await call("hr", "GET", `/api/v1/employees?vendorId=${VENDOR}&limit=200`))).toEqual([vend.personId]);
    expect(ids(await call("hr", "GET", `/api/v1/employees?payrollCompanyId=${CO.b}&limit=200`))).toEqual([past.personId]);
    // Immigration cannot read placements: the vendor filter finds nothing for them.
    expect(ids(await call("imm", "GET", `/api/v1/employees?vendorId=${VENDOR}&limit=200`))).toEqual([]);
  });

  it("the CSV export adds lead, recruiter, vendor, payroll company and the dates", async () => {
    const res = await call("ceo", "POST", "/api/v1/employees/export", {});
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body.replace(/^﻿/, "").split("\r\n")[0]).toBe(
      "Name,Email,Phone,Status,Employee since,Status since,Location,Team,Client,Assignment no.,Start date,Planned end date,"
      + "Lead,Recruiter,Vendor,Payroll company,E-Verify date,Onboarded date");
    expect(res.body).toContain("Prime Vendor Co");
  });
});

describe("leaving a project: HR/Accounts assign a team", () => {
  it("benched employee: team moves, recruiter cleared, lead and manager notified; audited with ids", async () => {
    const j = await benched({ actor: U.r1a, teamId: T.t1 });
    const d = (await call("acct", "GET", `/api/v1/employees/${j.personId}`)).json();
    expect(d.actions).toMatchObject({ assignTeam: true, editEmployment: true });
    const res = await call("acct", "POST", `/api/v1/employees/${j.personId}/assign-team`, { teamId: T.t3 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ id: j.personId, candidateId: j.candidateId, team: { id: T.t3, name: expect.any(String) }, recruiter: null });
    const c = (await db.admin.query(`SELECT team_id, recruiter_id, marketing_status FROM eureka.candidate WHERE id = $1`, [j.candidateId])).rows[0];
    expect(c).toEqual({ team_id: T.t3, recruiter_id: null, marketing_status: "bench" });
    const ev = (await db.admin.query(`SELECT id, payload FROM eureka.outbox_event WHERE type = 'candidate.assigned' AND aggregate_id = $1`, [j.candidateId])).rows;
    expect(ev.map((e) => e.payload)).toEqual([{ candidateId: j.candidateId, teamId: T.t3, fromTeamId: T.t1 }]);
    const who = (await db.worker.query(`SELECT recipient_id, reason FROM authz.notification_recipients($1) ORDER BY reason`, [ev[0].id])).rows;
    expect(who).toEqual([{ recipient_id: U.l3, reason: "lead" }, { recipient_id: U.m2, reason: "manager" }]);
    expect((await audits("employee.team_assigned", j.personId)).map((a) => [a.actor_id, a.changes])).toEqual([
      [U.acct, { candidateId: j.candidateId, fromTeamId: T.t1, toTeamId: T.t3 }]]);
    const same = await call("hr", "POST", `/api/v1/employees/${j.personId}/assign-team`, { teamId: T.t3 });
    expect([same.statusCode, same.json().detail]).toEqual([422, "unchanged"]);
    // After returning to marketing the team can still be set.
    expect((await call("hr", "POST", `/api/v1/employees/${j.personId}/return-to-market`, {})).statusCode).toBe(200);
    expect((await call("ahr", "POST", `/api/v1/employees/${j.personId}/assign-team`, { teamId: T.t2 })).statusCode).toBe(200);
  });

  it("lists teams with their lead for the employment writers only", async () => {
    for (const k of ALL_KEYS) {
      const res = await call(k, "GET", "/api/v1/employees/teams");
      expect(res.statusCode, k).toBe(can(accessOf(k), "assignment:update") ? 200 : 403);
    }
    const items = (await call("hr", "GET", "/api/v1/employees/teams")).json().items;
    expect(items.find((t: { id: string }) => t.id === T.t2)).toMatchObject({ lead: { id: U.l2, name: "l2" } });
  });

  it("refuses employees on assignment, unknown teams, and callers without the employment grants", async () => {
    const j = await onAssignment();
    const on = await call("hr", "POST", `/api/v1/employees/${j.personId}/assign-team`, { teamId: T.t2 });
    expect([on.statusCode, on.json().detail]).toEqual([422, "invalid_transition"]);
    const b = await benched();
    const bad = await call("hr", "POST", `/api/v1/employees/${b.personId}/assign-team`, { teamId: "00000000-0000-4000-8000-0000000000ff" });
    expect([bad.statusCode, bad.json().detail]).toEqual([422, "invalid_team"]);
    for (const k of ["l1", "m1", "ceo", "imm", "bu", "r1a"] as Key[]) {
      expect((await call(k, "POST", `/api/v1/employees/${b.personId}/assign-team`, { teamId: T.t2 })).statusCode, k).toBe(403);
    }
    expect((await call("hr", "POST", `/api/v1/employees/${b.personId}/assign-team`, { teamId: T.t2, recruiterId: U.r2a })).statusCode).toBe(422);
    expect((await call("hr", "POST", `/api/v1/employees/00000000-0000-4000-8000-0000000000ff/assign-team`, { teamId: T.t2 })).statusCode).toBe(404);
    const t = (await db.admin.query(`SELECT team_id FROM eureka.candidate WHERE id = $1`, [b.candidateId])).rows[0].team_id;
    expect(t).toBe(T.t1);
  });
});

// ---- reports: fixed past dates ----
const PERIOD = { from: "2024-01-01", to: "2024-06-30" };
const Q = `from=${PERIOD.from}&to=${PERIOD.to}`;

describe("joinings/exits: payroll company, technology, first vs later assignment; Immigration", () => {
  const seeded: Record<string, Joined> = {};
  beforeAll(async () => {
    // P: first assignment 2024-01-10..2024-03-31 (company A), then a second one from 2024-05-01 (company B).
    const p1 = await joinedEmployee(db, { actor: U.r1a });
    await force(db, `UPDATE eureka.assignment SET start_date = '2024-01-10', end_date = '2024-03-31', end_reason = 'completed' WHERE id = $1`, [p1.assignmentId]);
    await force(db, `UPDATE eureka.candidate SET marketing_status = 'active' WHERE id = $1`, [p1.candidateId]);
    const p2 = await joinedEmployee(db, { actor: U.r1a, candidateId: p1.candidateId });
    await force(db, `UPDATE eureka.assignment SET start_date = '2024-05-01' WHERE id = $1`, [p2.assignmentId]);
    // Q: one assignment 2024-02-01, open (no company).
    const q1 = await joinedEmployee(db, { actor: U.r2a, teamId: T.t2 });
    await force(db, `UPDATE eureka.assignment SET start_date = '2024-02-01' WHERE id = $1`, [q1.assignmentId]);
    for (const [j, co] of [[p1, CO.a], [p2, CO.b]] as const) {
      await force(db, `INSERT INTO eureka.assignment_employment (assignment_id, payroll_company_id) VALUES ($1, $2)`, [j.assignmentId, co]);
    }
    Object.assign(seeded, { p1, p2, q1 });
  });

  it("HR: items carry technology, payroll company and first/later assignment; totals and byCompany", async () => {
    const r = (await call("hr", "GET", `/api/v1/reports/joinings-exits?${Q}`)).json();
    const mine = r.items.filter((i: { assignmentId: string }) => Object.values(seeded).some((s) => s.assignmentId === i.assignmentId));
    expect(mine.map((i: any) => [i.kind, i.date, i.assignmentNo, i.isFirstAssignment, i.technology, i.payrollCompany?.name ?? null])).toEqual([
      ["joining", "2024-05-01", 2, false, "Java", "Eureka Tech Inc"],
      ["exit", "2024-03-31", 1, true, "Java", "Eureka Payroll LLC"],
      ["joining", "2024-02-01", 1, true, "Java", null],
      ["joining", "2024-01-10", 1, true, "Java", "Eureka Payroll LLC"],
    ]);
    expect(r.totals).toMatchObject({ joinings: 3, firstAssignments: 2, laterAssignments: 1, exits: 1 });
    expect(r.byCompany).toEqual(expect.arrayContaining([
      { company: { id: CO.a, name: "Eureka Payroll LLC" }, joinings: 1, firstAssignments: 1, laterAssignments: 0, exits: 1 },
      { company: { id: CO.b, name: "Eureka Tech Inc" }, joinings: 1, firstAssignments: 0, laterAssignments: 1, exits: 0 },
      { company: null, joinings: 1, firstAssignments: 1, laterAssignments: 0, exits: 0 },
    ]));
    expect(r.byTeam.reduce((n: number, g: { joinings: number }) => n + g.joinings, 0)).toBe(3);
    void TECH_ID;
  });

  it("Immigration reads the report (report:read) with the same counts as HR, without clients or recruiters", async () => {
    const hr = (await call("hr", "GET", `/api/v1/reports/joinings-exits?${Q}`)).json();
    const res = await call("imm", "GET", `/api/v1/reports/joinings-exits?${Q}`);
    expect(res.statusCode, res.body).toBe(200);
    const imm = res.json();
    expect(imm.totals).toEqual(hr.totals);
    expect(imm.byCompany).toEqual(hr.byCompany);
    expect(imm.items.map((i: any) => [i.kind, i.assignmentId])).toEqual(hr.items.map((i: any) => [i.kind, i.assignmentId]));
    for (const i of imm.items) {
      expect(i.client).toBeNull();
      expect(i.recruiter).toBeNull();
      expect(typeof i.candidate.name).toBe("string");
    }
    expect((await call("imm", "POST", "/api/v1/reports/joinings-exits/export", PERIOD)).statusCode).toBe(403);
    // Only Immigration-like callers reach the definer: a sales lead calling it directly is refused.
    await expect(asUser(db.app, U.l1, (c) => c.query(`SELECT * FROM authz.employment_movements('2024-01-01', '2024-02-01', false)`)))
      .rejects.toThrow(/not_permitted/);
    await expect(asUser(db.app, U.imm, (c) => c.query(`SELECT * FROM authz.employment_movements('2020-01-01', '2024-02-01', false)`)))
      .rejects.toThrow(/invalid_period/);
  });

  it("CSV export adds assignment (first/later), technology and payroll company", async () => {
    const res = await call("ceo", "POST", "/api/v1/reports/joinings-exits/export", PERIOD);
    expect(res.statusCode, res.body).toBe(200);
    const lines = res.body.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe("Event,Date,Candidate,Assignment no.,Client,Team,Recruiter,Location,First placement,End reason,Assignment,Technology,Payroll company");
    expect(lines.find((l) => l.startsWith("Joining,2024-05-01"))).toMatch(/,Later,Java,Eureka Tech Inc$/);
  });

  it("active employees per month: distinct people with an assignment running in it, by client and company", async () => {
    const get = (k: Key, q: string) => call(k, "GET", `/api/v1/reports/active-employees?${q}`);
    const client = (await db.admin.query(`SELECT client_id FROM eureka.placement WHERE id = $1`, [seeded.q1!.placementId])).rows[0].client_id;
    // April 2024: P is between assignments, Q is on assignment.
    const apr = (await get("hr", "month=2024-04")).json();
    expect(apr).toMatchObject({ month: "2024-04", from: "2024-04-01", to: "2024-04-30", total: 1 });
    // March 2024: P (ends 03-31) and Q.
    const mar = (await get("hr", "month=2024-03")).json();
    expect(mar.total).toBe(2);
    expect(mar.byClient).toEqual([{ client: { id: client, name: "Northwind Financial" }, count: 2 }]);
    expect(mar.byCompany).toEqual(expect.arrayContaining([{ company: { id: CO.a, name: "Eureka Payroll LLC" }, count: 1 }, { company: null, count: 1 }]));
    expect((await get("hr", `month=2024-03&clientId=${CLIENT2}`)).json().total).toBe(0);
    expect((await get("hr", `month=2024-03&clientId=${client}`)).json().total).toBe(2);
    // Scoped like the report: r2a sees only Q; Immigration the total without clients; location roles nothing.
    expect((await get("r2a", "month=2024-03")).json().total).toBe(1);
    const imm = (await get("imm", "month=2024-03")).json();
    expect([imm.total, imm.byClient]).toEqual([2, [{ client: null, count: 2 }]]);
    expect((await get("locD", "month=2024-03")).json().total).toBe(0);
    expect((await get("coach", "month=2024-03")).statusCode).toBe(403);
    for (const q of ["month=2024-13", "month=2024-3", "", "month=2024-03&teamId=x"]) expect((await get("hr", q)).statusCode, q).toBe(422);
  });

  it("permission matrix for active employees: report:read", async () => {
    for (const k of ALL_KEYS) {
      expect((await call(k, "GET", "/api/v1/reports/active-employees?month=2023-01")).statusCode, k).toBe(can(accessOf(k), "report:read") ? 200 : 403);
    }
    void idOf;
  });
});

describe("bench alert POC", () => {
  it("employee.bench_time also reaches the recruiter who placed the candidate on the latest assignment (reason poc)", async () => {
    // Placed by r1b; the candidate's recruiter is then r1a.
    const cand = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1b, locationId: LOC.dallas });
    const j = await benched({ actor: U.r1b, candidateId: cand.id });
    await force(db, `UPDATE eureka.candidate SET recruiter_id = $2 WHERE id = $1`, [j.candidateId, U.r1a]);
    const ev = await emitEvent(db, "employee.bench_time", "candidate", j.candidateId,
      { candidateId: j.candidateId, benchSince: today, benchDays: 31, thresholdDays: 30 });
    const who = (await db.worker.query(`SELECT recipient_id, reason FROM authz.notification_recipients($1) ORDER BY reason, recipient_id`, [ev])).rows;
    expect(who).toEqual([
      { recipient_id: U.l1, reason: "lead" }, { recipient_id: U.m1, reason: "manager" },
      { recipient_id: U.ceo, reason: "notify.bench_time:receive" }, { recipient_id: U.r1b, reason: "poc" }, { recipient_id: U.r1a, reason: "recruiter" },
    ]);
  });
});
