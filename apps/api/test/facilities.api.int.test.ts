import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { can } from "@eureka/shared";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { LocalDocumentStore } from "../src/worker/document-store.js";
import { documentScanJob } from "../src/worker/jobs/document-scan.js";
import { DEFAULT_SCAN_OPTIONS } from "../src/worker/jobs/scan-pipeline.js";
import { silentLogger } from "../src/worker/log.js";
import { JobRunner } from "../src/worker/runner.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { LOC, U, seedFixtures, toUserAccess } from "./fixtures.js";
import { joinedEmployee } from "./employee-seed.js";

/**
 * Companies, facilities, utilities and bills (docs/facilities-api.md,
 * migration 0054): location scope (Dallas admin never sees or changes Austin
 * rows: 404), other roles 403, If-Match, validation, voided bills out of
 * lists and totals, summary math, CSV injection safety, the password reveal
 * (permission + step-up, audited without the plaintext), invoices on the
 * document pipeline, and no PII in audit_event or outbox_event.
 */
let db: TestDb;
let app: NestFastifyApplication;
let docs: string;
/** A second Location Ops Admin, for Austin (not in the shared fixtures). */
let opsA: string;

const PASSWORD = "dev-Only-Pa55word!";
const SECRET_TEXTS = [PASSWORD, "ACCT-778899", "portal.user.dallas", "Quiet street notes", "Landlord Lee", "landlord@example.invalid",
  "+1 214 555 0199", "Duplicate entry by mistake"];

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  await db.admin.query(`INSERT INTO authz.policy_setting (key, value) VALUES ('dev_step_up', 'on')`);
  opsA = (await db.admin.query<{ id: string }>(
    `INSERT INTO eureka.app_user (email, display_name) VALUES ('opsA@eureka.example', 'opsA') RETURNING id`)).rows[0]!.id;
  await db.admin.query(`INSERT INTO eureka.user_role (user_id, role_key, location_id) VALUES ($1, 'location_ops_admin', $2)`, [opsA, LOC.austin]);
  docs = await mkdtemp(join(tmpdir(), "eureka-fac-docs-"));
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: "test-secret-test-secret-test-secret-123",
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`, LOCAL_STORAGE_DIR: docs,
  }));
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
  if (docs) await rm(docs, { recursive: true, force: true });
});

type Key = keyof typeof U | "opsA";
type Session = { cookie: string; csrf: string };
const sessions = new Map<string, Session>();
async function login(key: Key, fresh = false, stepUp = true): Promise<Session> {
  const cached = sessions.get(key);
  if (cached && !fresh) return cached;
  const res = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: `${key}@eureka.example` } });
  expect(res.statusCode).toBe(204);
  const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
  const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
  const s = { cookie, csrf: me.json().csrfToken as string };
  if (stepUp) {
    const g = await app.inject({ method: "POST", url: "/api/auth/step-up/dev", headers: { cookie, "x-csrf-token": s.csrf } });
    expect(g.statusCode).toBe(200);
  }
  if (!fresh) sessions.set(key, s);
  return s;
}
type Method = "GET" | "POST" | "PATCH" | "DELETE";
async function call(key: Key, method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}, session?: Session) {
  const s = session ?? await login(key);
  return app.inject({ method, url, payload: payload as never, headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}), ...headers } });
}
async function ok<T = Record<string, unknown>>(key: Key, method: Method, url: string, payload?: unknown, status = 200, headers: Record<string, string> = {}): Promise<T> {
  const r = await call(key, method, url, payload, headers);
  expect(r.statusCode, `${method} ${url}: ${r.body}`).toBe(status);
  return (r.body ? r.json() : undefined) as T;
}
const ifMatch = (v: number) => ({ "if-match": `"${v}"` });
let n = 0;
const uniq = (s: string) => `${s} ${++n}`;
const company = (key: Key, locationId: string, extra: Record<string, unknown> = {}) =>
  ok<{ id: string; rowVersion: number; name: string }>(key, "POST", "/api/v1/companies", { locationId, name: uniq("Co"), ...extra }, 201);
const facility = (key: Key, locationId: string, extra: Record<string, unknown> = {}) =>
  ok<{ id: string; rowVersion: number }>(key, "POST", "/api/v1/facilities", { locationId, name: uniq("Guest House"), ...extra }, 201);
const auditText = async () => (await db.admin.query<{ t: string }>(`SELECT coalesce(string_agg(action || ' ' || coalesce(changes::text, ''), ' '), '') AS t FROM eureka.audit_event`)).rows[0]!.t;
const outboxText = async () => (await db.admin.query<{ t: string }>(`SELECT coalesce(string_agg(type || ' ' || payload::text, ' '), '') AS t FROM eureka.outbox_event`)).rows[0]!.t;
const auditSince = async (seq: string) => (await db.admin.query(
  `SELECT actor_id, action, entity_type, entity_id, changes FROM eureka.audit_event WHERE seq > $1 ORDER BY seq`, [seq])).rows;
const auditHead = async () => (await db.admin.query<{ s: string }>(`SELECT coalesce(max(seq), 0)::text AS s FROM eureka.audit_event`)).rows[0]!.s;

describe("permissions and location scope", () => {
  const users = Object.keys(U) as (keyof typeof U)[];

  it.each(users)("%s: only holders of the read permission reach the lists (others 403)", async (key) => {
    const access = toUserAccess(key);
    for (const [path, perm] of [["companies", "company:read"], ["facilities", "facility:read"]] as const) {
      expect((await call(key, "GET", `/api/v1/${path}`)).statusCode).toBe(can(access, perm) ? 200 : 403);
      expect((await call(key, "GET", `/api/v1/${path}/stats`)).statusCode).toBe(can(access, perm) ? 200 : 403);
      expect((await call(key, "GET", `/api/v1/${path}/bills-summary`)).statusCode).toBe(can(access, "bill:read") ? 200 : 403);
    }
    expect((await call(key, "POST", "/api/v1/companies", { locationId: LOC.dallas, name: uniq("Matrix") })).statusCode)
      .toBe(can(access, "company:manage") ? 201 : 403);
  });

  it("only Location Ops Admin holds these permissions, at location scope", () => {
    for (const key of users) expect(can(toUserAccess(key), "company:read"), key).toBe(key === "locD");
  });

  it("Dallas admin: Austin rows are invisible (404) and cannot be created (403); Austin admin likewise for Dallas", async () => {
    const dal = await company("locD", LOC.dallas);
    const aus = await company("opsA", LOC.austin);
    expect((await call("locD", "POST", "/api/v1/companies", { locationId: LOC.austin, name: uniq("X") })).statusCode).toBe(403);
    expect((await call("opsA", "POST", "/api/v1/facilities", { locationId: LOC.dallas, name: uniq("X") })).statusCode).toBe(403);
    const listD = (await ok<{ items: { id: string; location: { id: string } }[] }>("locD", "GET", "/api/v1/companies?limit=200")).items;
    expect(listD.every((c) => c.location.id === LOC.dallas)).toBe(true);
    expect(listD.map((c) => c.id)).toContain(dal.id);
    expect(listD.map((c) => c.id)).not.toContain(aus.id);
    const listA = (await ok<{ items: { id: string }[] }>("opsA", "GET", "/api/v1/companies?limit=200")).items;
    expect(listA.map((c) => c.id)).toEqual(expect.arrayContaining([aus.id]));
    expect(listA.map((c) => c.id)).not.toContain(dal.id);
    for (const [method, url, body, headers] of [
      ["GET", `/api/v1/companies/${aus.id}`, undefined, {}],
      ["PATCH", `/api/v1/companies/${aus.id}`, { name: "Hijack" }, ifMatch(1)],
      ["GET", `/api/v1/companies/${aus.id}/utilities`, undefined, {}],
      ["POST", `/api/v1/companies/${aus.id}/utilities`, { utilityType: "water", serviceProvider: "X" }, {}],
      ["GET", `/api/v1/companies/${aus.id}/bills`, undefined, {}],
      ["GET", `/api/v1/companies/${aus.id}/incharges`, undefined, {}],
      ["POST", `/api/v1/companies/${aus.id}/incharges`, { userId: U.locD }, {}],
      ["GET", `/api/v1/companies/${aus.id}/employees`, undefined, {}],
      ["GET", `/api/v1/companies/${aus.id}/bills/export.csv`, undefined, {}],
    ] as const) {
      expect((await call("locD", method, url, body, headers)).statusCode, `${method} ${url}`).toBe(404);
    }
    // Moving a Dallas company to Austin needs company:manage in Austin too.
    expect((await call("locD", "PATCH", `/api/v1/companies/${dal.id}`, { locationId: LOC.austin }, ifMatch(dal.rowVersion))).statusCode).toBe(403);
    // An unknown id is 404 too.
    expect((await call("locD", "GET", "/api/v1/companies/00000000-0000-4000-8000-000000000999")).statusCode).toBe(404);
  });

  it("stats and summaries count only the caller's locations", async () => {
    await facility("opsA", LOC.austin, { capacity: 50, beds: 40 });
    const before = await ok<{ total: number }>("locD", "GET", "/api/v1/facilities/stats");
    await facility("opsA", LOC.austin, { capacity: 50, beds: 40 });
    expect((await ok<{ total: number }>("locD", "GET", "/api/v1/facilities/stats")).total).toBe(before.total);
  });
});

describe("companies and facilities: create, edit, validation", () => {
  it("company create returns the detail; name unique per location, case-insensitive (409 name_taken)", async () => {
    const name = uniq("Eureka Info Tech");
    const c = await ok<Record<string, unknown>>("locD", "POST", "/api/v1/companies",
      { locationId: LOC.dallas, name, street: "100 Fictional Way", city: "Dallas", state: "TX", zip: "75001", notes: "Quiet street notes" }, 201);
    expect(c).toMatchObject({
      name, location: { id: LOC.dallas, name: "Dallas" }, street: "100 Fictional Way", city: "Dallas", state: "TX", zip: "75001",
      country: "USA", status: "active", incharges: [], employeeCount: 0, rowVersion: 1, notes: "Quiet street notes", actions: { manage: true },
    });
    const dup = await call("locD", "POST", "/api/v1/companies", { locationId: LOC.dallas, name: name.toUpperCase() });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().detail).toBe("name_taken");
    // The same name in another location is fine.
    await ok("opsA", "POST", "/api/v1/companies", { locationId: LOC.austin, name }, 201);
  });

  it("PATCH needs If-Match: 428 without, 412 stale, 200 with the current version (null clears a field)", async () => {
    const c = await company("locD", LOC.dallas, { city: "Dallas" });
    expect((await call("locD", "PATCH", `/api/v1/companies/${c.id}`, { city: "Plano" })).statusCode).toBe(428);
    const stale = await call("locD", "PATCH", `/api/v1/companies/${c.id}`, { city: "Plano" }, ifMatch(7));
    expect(stale.statusCode).toBe(412);
    expect(stale.json().detail).toBe("stale");
    const r = await ok<{ city: string | null; status: string; rowVersion: number }>("locD", "PATCH", `/api/v1/companies/${c.id}`,
      { city: null, status: "inactive" }, 200, ifMatch(1));
    expect(r).toMatchObject({ city: null, status: "inactive", rowVersion: 2 });
    expect((await call("locD", "PATCH", `/api/v1/companies/${c.id}`, { city: "Plano" }, ifMatch(1))).statusCode).toBe(412);
  });

  it("facility: money as 2-decimal strings, owner contact only in the detail, monthly rent in stats", async () => {
    const f = await ok<Record<string, unknown>>("locD", "POST", "/api/v1/facilities", {
      locationId: LOC.dallas, name: uniq("Guest House 2013"), street: "2013 Fictional Ln", city: "Dallas", state: "TX", zip: "75002",
      ownerName: "Landlord Lee", ownerEmail: "landlord@example.invalid", ownerPhone: "+1 214 555 0199",
      rent: "2400", feeFrequency: "monthly", capacity: 8, beds: 6, baths: 2.5, startDate: "2025-01-01", endDate: "2026-12-31",
    }, 201);
    expect(f).toMatchObject({ rent: "2400.00", feeFrequency: "monthly", capacity: 8, beds: 6, baths: 2.5, ownerName: "Landlord Lee",
      ownerEmail: "landlord@example.invalid", startDate: "2025-01-01", endDate: "2026-12-31", actions: { manage: true } });
    const list = (await ok<{ items: Record<string, unknown>[] }>("locD", "GET", `/api/v1/facilities?q=${encodeURIComponent(String(f.name))}`)).items;
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("ownerName");
    expect(list[0]).not.toHaveProperty("ownerEmail");
    // Weekly rent counts 52/12 per month; yearly 1/12.
    const before = await ok<{ monthlyRent: string; capacity: number }>("locD", "GET", `/api/v1/facilities/stats?locationId=${LOC.dallas}`);
    await facility("locD", LOC.dallas, { rent: "120", feeFrequency: "weekly", capacity: 3 });
    await facility("locD", LOC.dallas, { rent: 1200, feeFrequency: "yearly" });
    const after = await ok<{ monthlyRent: string; capacity: number }>("locD", "GET", `/api/v1/facilities/stats?locationId=${LOC.dallas}`);
    expect(Number(after.monthlyRent) - Number(before.monthlyRent)).toBeCloseTo(520 + 100, 2);
    expect(after.monthlyRent).toMatch(/^\d+\.\d{2}$/);
    expect(after.capacity - before.capacity).toBe(3);
  });

  it.each([
    ["unknown key", "/api/v1/companies", { locationId: LOC.dallas, name: "V1", status: "inactive" }],
    ["blank name", "/api/v1/companies", { locationId: LOC.dallas, name: "  " }],
    ["bad zip", "/api/v1/companies", { locationId: LOC.dallas, name: "V2", zip: "!" }],
    ["control character", "/api/v1/companies", { locationId: LOC.dallas, name: "V3\u0007" }],
    ["rent with 3 decimals", "/api/v1/facilities", { locationId: LOC.dallas, name: "V4", rent: "12.345" }],
    ["negative capacity", "/api/v1/facilities", { locationId: LOC.dallas, name: "V5", capacity: -1 }],
    ["quarter bath", "/api/v1/facilities", { locationId: LOC.dallas, name: "V6", baths: 1.25 }],
    ["end before start", "/api/v1/facilities", { locationId: LOC.dallas, name: "V7", startDate: "2025-05-01", endDate: "2025-04-30" }],
    ["bad email", "/api/v1/facilities", { locationId: LOC.dallas, name: "V8", ownerEmail: "nope" }],
  ])("%s → 422, nothing written", async (_n, url, body) => {
    const before = await auditHead();
    expect((await call("locD", "POST", url, body)).statusCode).toBe(422);
    expect(await auditHead()).toBe(before);
  });

  it("lists page with an opaque cursor in name order", async () => {
    for (let i = 0; i < 3; i++) await company("locD", LOC.dallas);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { items: { id: string; name: string }[]; nextCursor: string | null } =
        await ok("locD", "GET", `/api/v1/companies?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...page.items.map((c) => c.name.toLowerCase()));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(new Set(seen).size).toBe(seen.length);
    expect((await call("locD", "GET", "/api/v1/companies?cursor=garbage")).statusCode).toBe(422);
  });
});

describe("incharges and employees", () => {
  it("incharges: active users with a role at the location; duplicate 409; outsider 422; remove 204 then 404", async () => {
    const c = await company("locD", LOC.dallas);
    const opts = (await ok<{ items: { id: string }[] }>("locD", "GET", `/api/v1/companies/${c.id}/incharge-options`)).items.map((x) => x.id);
    expect(opts).toContain(U.locD);
    expect(opts).not.toContain(U.r1a);
    expect(opts).not.toContain(opsA);
    expect(await ok("locD", "POST", `/api/v1/companies/${c.id}/incharges`, { userId: U.locD }, 201)).toMatchObject({ id: U.locD, name: "locD" });
    const dup = await call("locD", "POST", `/api/v1/companies/${c.id}/incharges`, { userId: U.locD });
    expect([dup.statusCode, dup.json().detail]).toEqual([409, "already_incharge"]);
    const bad = await call("locD", "POST", `/api/v1/companies/${c.id}/incharges`, { userId: U.r1a });
    expect([bad.statusCode, bad.json().detail]).toEqual([422, "invalid_incharge"]);
    expect((await ok<{ items: { id: string; name: string }[] }>("locD", "GET", `/api/v1/companies/${c.id}/incharges`)).items)
      .toEqual([expect.objectContaining({ id: U.locD, name: "locD" })]);
    expect((await ok<{ incharges: unknown[] }>("locD", "GET", `/api/v1/companies/${c.id}`)).incharges).toEqual([{ id: U.locD, name: "locD" }]);
    expect((await call("locD", "DELETE", `/api/v1/companies/${c.id}/incharges/${U.locD}`)).statusCode).toBe(204);
    expect((await call("locD", "DELETE", `/api/v1/companies/${c.id}/incharges/${U.locD}`)).statusCode).toBe(404);
    // Facilities work the same way.
    const f = await facility("locD", LOC.dallas);
    await ok("locD", "POST", `/api/v1/facilities/${f.id}/incharges`, { userId: U.locD }, 201);
    expect((await ok<{ incharges: unknown[] }>("locD", "GET", `/api/v1/facilities/${f.id}`)).incharges).toEqual([{ id: U.locD, name: "locD" }]);
  });

  it("employees: one open company per employee, location-bound, ended with a date; names and status without email", async () => {
    const c1 = await company("locD", LOC.dallas);
    const c2 = await company("locD", LOC.dallas);
    const e = await joinedEmployee(db);
    const austin = await joinedEmployee(db, { locationId: LOC.austin });
    const opts = (await ok<{ items: { employeeId: string; name: string }[] }>("locD", "GET", `/api/v1/companies/${c1.id}/employee-options`)).items;
    expect(opts.map((o) => o.employeeId)).toContain(e.personId);
    expect(opts.map((o) => o.employeeId)).not.toContain(austin.personId);
    await ok("locD", "POST", `/api/v1/companies/${c1.id}/employees`, { employeeId: e.personId, startDate: "2025-02-01" }, 201);
    const again = await call("locD", "POST", `/api/v1/companies/${c2.id}/employees`, { employeeId: e.personId, startDate: "2025-03-01" });
    expect([again.statusCode, again.json().detail]).toEqual([409, "employee_assigned"]);
    const far = await call("locD", "POST", `/api/v1/companies/${c1.id}/employees`, { employeeId: austin.personId, startDate: "2025-03-01" });
    expect([far.statusCode, far.json().detail]).toEqual([422, "invalid_employee"]);
    expect((await ok<{ items: { employeeId: string }[] }>("locD", "GET", `/api/v1/companies/${c1.id}/employee-options`)).items
      .map((o) => o.employeeId)).not.toContain(e.personId);
    const list = (await ok<{ items: Record<string, unknown>[] }>("locD", "GET", `/api/v1/companies/${c1.id}/employees`)).items;
    expect(list).toEqual([{ employeeId: e.personId, name: expect.stringMatching(/\S+ \S+/), startDate: "2025-02-01", endDate: null, status: "on_assignment" }]);
    expect((await ok<{ employeeCount: number }>("locD", "GET", `/api/v1/companies/${c1.id}`)).employeeCount).toBe(1);
    const early = await call("locD", "POST", `/api/v1/companies/${c1.id}/employees/${e.personId}/end`, { endDate: "2025-01-31" });
    expect([early.statusCode, early.json().detail]).toEqual([422, "invalid_end_date"]);
    expect(await ok("locD", "POST", `/api/v1/companies/${c1.id}/employees/${e.personId}/end`, { endDate: "2025-06-30" }))
      .toEqual({ employeeId: e.personId, startDate: "2025-02-01", endDate: "2025-06-30" });
    // A later start at another company is fine; one overlapping the ended assignment is not.
    const overlap = await call("locD", "POST", `/api/v1/companies/${c2.id}/employees`, { employeeId: e.personId, startDate: "2025-06-01" });
    expect([overlap.statusCode, overlap.json().detail]).toEqual([422, "invalid_start_date"]);
    await ok("locD", "POST", `/api/v1/companies/${c2.id}/employees`, { employeeId: e.personId, startDate: "2025-07-01" }, 201);
    expect((await ok<{ employeeCount: number }>("locD", "GET", `/api/v1/companies/${c1.id}`)).employeeCount).toBe(0);
    // A company with an open assignment cannot move location.
    expect((await call("locD", "PATCH", `/api/v1/companies/${c2.id}`, { locationId: LOC.austin }, ifMatch(1))).statusCode).toBe(403);
  });
});

describe("utilities and the password reveal", () => {
  it("the password is encrypted, never listed, revealed only with step-up, audited without the plaintext", async () => {
    const c = await company("locD", LOC.dallas);
    const u = await ok<Record<string, unknown>>("locD", "POST", `/api/v1/companies/${c.id}/utilities`, {
      utilityType: "electricity", serviceProvider: "Fictional Power", accountNumber: "ACCT-778899", websiteUrl: "https://power.example.invalid/login",
      username: "portal.user.dallas", password: PASSWORD, notes: "Meter in the garage",
    }, 201);
    expect(u).toMatchObject({ utilityType: "electricity", hasPassword: true, accountNumber: "ACCT-778899", rowVersion: 1 });
    expect(JSON.stringify(u)).not.toContain(PASSWORD);
    const list = await call("locD", "GET", `/api/v1/companies/${c.id}/utilities`);
    expect(list.body).not.toContain(PASSWORD);
    expect(list.json().actions).toEqual({ manage: true, revealPassword: true });
    const stored = (await db.admin.query(`SELECT password_enc, password_mac FROM eureka.utility WHERE id = $1`, [u.id])).rows[0];
    expect((stored.password_enc as Buffer).includes(Buffer.from(PASSWORD))).toBe(false);
    expect((stored.password_mac as Buffer).length).toBe(32);

    // No step-up on this session: 403 step_up_required, nothing audited.
    const head = await auditHead();
    const plain = await login("locD", true, false);
    const refused = await call("locD", "POST", `/api/v1/utilities/${u.id}/reveal-password`, undefined, {}, plain);
    expect([refused.statusCode, refused.json().detail]).toEqual([403, "step_up_required"]);
    expect(await auditSince(head)).toEqual([]);

    const r = await call("locD", "POST", `/api/v1/utilities/${u.id}/reveal-password`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ password: PASSWORD });
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(await auditSince(head)).toEqual([{
      actor_id: U.locD, action: "utility.password_revealed", entity_type: "utility", entity_id: u.id,
      changes: { ownerKind: "company", ownerId: c.id, stepUpGrantId: expect.any(String) },
    }]);
    // Other location, other roles.
    expect((await call("opsA", "POST", `/api/v1/utilities/${u.id}/reveal-password`)).statusCode).toBe(404);
    for (const key of ["hr", "imm", "r1a", "admin", "locA"] as const) {
      expect((await call(key, "POST", `/api/v1/utilities/${u.id}/reveal-password`)).statusCode, key).toBe(403);
    }
    expect(await auditText()).not.toContain(PASSWORD);
  });

  it("PATCH: omitted password keeps it, a new one replaces it, null clears it (then 409 no_password)", async () => {
    const f = await facility("locD", LOC.dallas);
    const u = await ok<{ id: string; rowVersion: number }>("locD", "POST", `/api/v1/facilities/${f.id}/utilities`,
      { utilityType: "internet", serviceProvider: "Fictional Fiber", password: "first-secret" }, 201);
    const v2 = await ok<{ rowVersion: number; hasPassword: boolean }>("locD", "PATCH", `/api/v1/utilities/${u.id}`, { status: "inactive" }, 200, ifMatch(1));
    expect(v2).toMatchObject({ rowVersion: 2, hasPassword: true });
    expect((await ok("locD", "POST", `/api/v1/utilities/${u.id}/reveal-password`)).password).toBe("first-secret");
    await ok("locD", "PATCH", `/api/v1/utilities/${u.id}`, { password: "second-secret" }, 200, ifMatch(2));
    expect((await ok("locD", "POST", `/api/v1/utilities/${u.id}/reveal-password`)).password).toBe("second-secret");
    expect(await ok("locD", "PATCH", `/api/v1/utilities/${u.id}`, { password: null }, 200, ifMatch(3))).toMatchObject({ hasPassword: false, rowVersion: 4 });
    const none = await call("locD", "POST", `/api/v1/utilities/${u.id}/reveal-password`);
    expect([none.statusCode, none.json().detail]).toEqual([409, "no_password"]);
    expect((await call("locD", "PATCH", `/api/v1/utilities/${u.id}`, { status: "active" }, ifMatch(1))).statusCode).toBe(412);
    expect((await call("locD", "PATCH", `/api/v1/utilities/${u.id}`, { websiteUrl: "http://plain.example.invalid" }, ifMatch(4))).statusCode).toBe(422);
    expect((await call("locD", "PATCH", `/api/v1/utilities/${u.id}`, { utilityType: "teleport" }, ifMatch(4))).statusCode).toBe(422);
    expect((await call("opsA", "PATCH", `/api/v1/utilities/${u.id}`, { status: "active" }, ifMatch(4))).statusCode).toBe(404);
  });

  it("a value whose MAC does not match is refused (500 integrity_check_failed), audited, nothing returned", async () => {
    const c = await company("locD", LOC.dallas);
    const a = await ok<{ id: string }>("locD", "POST", `/api/v1/companies/${c.id}/utilities`, { utilityType: "gas", serviceProvider: "G1", password: "aaa" }, 201);
    const b = await ok<{ id: string }>("locD", "POST", `/api/v1/companies/${c.id}/utilities`, { utilityType: "gas", serviceProvider: "G2", password: "bbb" }, 201);
    // Swap the MACs (superuser, triggers off): each ciphertext still decrypts, but its MAC is another row's.
    const macs = (await db.admin.query(`SELECT id, password_mac FROM eureka.utility WHERE id = ANY ($1::uuid[])`, [[a.id, b.id]])).rows;
    const c2 = await db.admin.connect();
    try {
      await c2.query("SET session_replication_role = replica");
      await c2.query(`UPDATE eureka.utility SET password_mac = $2 WHERE id = $1`, [a.id, macs.find((m) => m.id === b.id)!.password_mac]);
    } finally {
      await c2.query("RESET session_replication_role");
      c2.release();
    }
    const r = await call("locD", "POST", `/api/v1/utilities/${a.id}/reveal-password`);
    expect([r.statusCode, r.json().detail]).toEqual([500, "integrity_check_failed"]);
    expect(r.body).not.toContain("aaa");
    expect((await db.admin.query(`SELECT count(*)::int AS n FROM eureka.audit_event WHERE action = 'utility.integrity_failed' AND entity_id = $1`, [a.id])).rows[0].n).toBe(1);
  });
});

describe("bills", () => {
  async function setup() {
    const c = await company("locD", LOC.dallas);
    const water = await ok<{ id: string }>("locD", "POST", `/api/v1/companies/${c.id}/utilities`, { utilityType: "water", serviceProvider: "Fictional Water" }, 201);
    const power = await ok<{ id: string }>("locD", "POST", `/api/v1/companies/${c.id}/utilities`, { utilityType: "electricity", serviceProvider: "Fictional Power" }, 201);
    return { c, water, power };
  }
  const bill = (companyId: string, utilityId: string, amount: string, month: string, extra: Record<string, unknown> = {}) =>
    ok<{ id: string; rowVersion: number; status: string; amount: string }>("locD", "POST", `/api/v1/companies/${companyId}/bills`, {
      utilityId, paymentMethod: "ach", amount, billingStart: `${month}-01`, billingEnd: `${month}-28`, dueDate: "2099-12-01", ...extra,
    }, 201);

  it("create, derived status, If-Match edit, void excluded from list, export and totals", async () => {
    const { c, water, power } = await setup();
    const b1 = await bill(c.id, water.id, "100.10", "2025-01", { paidOn: "2025-02-05" });
    const b2 = await bill(c.id, power.id, "200", "2025-01", { dueDate: "2025-02-10" });
    const b3 = await bill(c.id, power.id, "50.5", "2025-03");
    const voidMe = await bill(c.id, water.id, "999.99", "2025-03");
    expect([b1.status, b2.status, b3.status]).toEqual(["paid", "overdue", "due"]);
    expect(b2.amount).toBe("200.00");

    const v = await call("locD", "POST", `/api/v1/bills/${voidMe.id}/void`, { reason: "Duplicate entry by mistake" });
    expect(v.statusCode, v.body).toBe(200);
    expect((await call("locD", "POST", `/api/v1/bills/${voidMe.id}/void`, { reason: "again" })).json().detail).toBe("bill_voided");
    expect((await call("locD", "PATCH", `/api/v1/bills/${voidMe.id}`, { amount: "1" }, ifMatch(2))).statusCode).toBe(409);
    expect((await call("locD", "POST", `/api/v1/bills/${b1.id}/void`, { reason: " " })).statusCode).toBe(422);

    const list = await ok<{ items: { id: string; utility: { utilityType: string } }[] }>("locD", "GET", `/api/v1/companies/${c.id}/bills`);
    // billing_start descending, then id descending.
    expect(list.items.map((b) => b.id)).toEqual([b3.id, ...[b1.id, b2.id].sort().reverse()]);
    expect(list.items.map((b) => b.id)).not.toContain(voidMe.id);
    expect((await ok<{ items: { id: string }[] }>("locD", "GET", `/api/v1/companies/${c.id}/bills?status=overdue`)).items.map((b) => b.id)).toEqual([b2.id]);
    expect((await ok<{ items: { id: string }[] }>("locD", "GET", `/api/v1/companies/${c.id}/bills?q=water`)).items.map((b) => b.id)).toEqual([b1.id]);
    expect((await ok<{ items: { id: string }[] }>("locD", "GET", `/api/v1/companies/${c.id}/bills?from=2025-02-01`)).items.map((b) => b.id)).toEqual([b3.id]);

    const sum = await ok<Record<string, unknown>>("locD", "GET", `/api/v1/companies/bills-summary?from=2025-01-01&to=2025-03-31&tz=America/Chicago`);
    const mine = (sum.byOwner as { id: string; amount: string; count: number }[]).find((o) => o.id === c.id);
    expect(mine).toMatchObject({ amount: "350.60", count: 3 });

    // Edit with If-Match; paidOn null clears; utility of another owner refused.
    expect((await call("locD", "PATCH", `/api/v1/bills/${b2.id}`, { paidOn: "2025-02-09" })).statusCode).toBe(428);
    const e = await ok<{ status: string; rowVersion: number; paidOn: string }>("locD", "PATCH", `/api/v1/bills/${b2.id}`, { paidOn: "2025-02-09" }, 200, ifMatch(1));
    expect(e).toMatchObject({ status: "paid", rowVersion: 2, paidOn: "2025-02-09" });
    expect((await ok<{ status: string }>("locD", "PATCH", `/api/v1/bills/${b2.id}`, { paidOn: null }, 200, ifMatch(2))).status).toBe("overdue");
    const other = await setup();
    const wrong = await call("locD", "PATCH", `/api/v1/bills/${b2.id}`, { utilityId: other.water.id }, ifMatch(3));
    expect([wrong.statusCode, wrong.json().detail]).toEqual([422, "invalid_utility"]);
    const wrongCreate = await call("locD", "POST", `/api/v1/companies/${c.id}/bills`, {
      utilityId: other.water.id, paymentMethod: "ach", amount: "1", billingStart: "2025-01-01", billingEnd: "2025-01-02", dueDate: "2025-01-03" });
    expect([wrongCreate.statusCode, wrongCreate.json().detail]).toEqual([422, "invalid_utility"]);
    expect((await call("locD", "PATCH", `/api/v1/bills/${b2.id}`, { billingEnd: "2024-12-31" }, ifMatch(3))).statusCode).toBe(422);
    for (const amount of ["0", "-5", "1.234", "abc"]) {
      expect((await call("locD", "POST", `/api/v1/companies/${c.id}/bills`, {
        utilityId: water.id, paymentMethod: "ach", amount, billingStart: "2025-01-01", billingEnd: "2025-01-02", dueDate: "2025-01-03" })).statusCode, amount).toBe(422);
    }
    expect((await call("opsA", "PATCH", `/api/v1/bills/${b2.id}`, { amount: "1" }, ifMatch(3))).statusCode).toBe(404);
    expect((await call("opsA", "POST", `/api/v1/bills/${b2.id}/void`, { reason: "x" })).statusCode).toBe(404);
  });

  it("summaries: totals, months zero-filled, by type and by owner, voided excluded; facilities separate", async () => {
    const loc = (await db.admin.query<{ id: string }>(`INSERT INTO eureka.location (name, kind, timezone) VALUES ('Fort Worth', 'office', 'America/Chicago') RETURNING id`)).rows[0]!.id;
    const ops = (await db.admin.query<{ id: string }>(`INSERT INTO eureka.app_user (email, display_name) VALUES ('opsF@eureka.example', 'opsF') RETURNING id`)).rows[0]!.id;
    await db.admin.query(`INSERT INTO eureka.user_role (user_id, role_key, location_id) VALUES ($1, 'location_ops_admin', $2)`, [ops, loc]);
    const s = async (key: "opsF", q: string) => ok<{
      totalBills: number; totalAmount: string; averagePerMonth: string; byMonth: { month: string; amount: string; count: number }[];
      byType: { utilityType: string; amount: string; count: number }[]; byOwner: { id: string; name: string; amount: string; count: number }[];
    }>(key as Key, "GET", `/api/v1/companies/bills-summary?${q}`);
    // An empty location: zeros.
    expect(await s("opsF", "from=2025-01-01&to=2025-06-30")).toMatchObject({
      totalBills: 0, totalAmount: "0.00", averagePerMonth: "0.00", byType: [], byOwner: [],
      byMonth: ["01", "02", "03", "04", "05", "06"].map((m) => ({ month: `2025-${m}`, amount: "0.00", count: 0 })),
    });
    const c1 = await company("opsF" as Key, loc);
    const c2 = await company("opsF" as Key, loc);
    const w = await ok<{ id: string }>("opsF" as Key, "POST", `/api/v1/companies/${c1.id}/utilities`, { utilityType: "water", serviceProvider: "W" }, 201);
    const e = await ok<{ id: string }>("opsF" as Key, "POST", `/api/v1/companies/${c2.id}/utilities`, { utilityType: "electricity", serviceProvider: "E" }, 201);
    const add = (owner: string, utilityId: string, amount: string, start: string) => ok<{ id: string }>("opsF" as Key, "POST", `/api/v1/companies/${owner}/bills`,
      { utilityId, paymentMethod: "card", amount, billingStart: start, billingEnd: start, dueDate: start }, 201);
    await add(c1.id, w.id, "10.05", "2025-01-15");
    await add(c1.id, w.id, "20.10", "2025-03-01");
    await add(c2.id, e.id, "100.00", "2025-03-31");
    await add(c2.id, e.id, "7.00", "2025-07-01"); // outside the period
    const gone = await add(c2.id, e.id, "500.00", "2025-02-01");
    await ok("opsF" as Key, "POST", `/api/v1/bills/${gone.id}/void`, { reason: "wrong" });
    const r = await s("opsF", "from=2025-01-01&to=2025-06-30&tz=America/Chicago");
    expect(r.totalBills).toBe(3);
    expect(r.totalAmount).toBe("130.15");
    expect(r.averagePerMonth).toBe("21.69"); // 130.15 / 6 = 21.6916..
    expect(r.byMonth).toEqual([
      { month: "2025-01", amount: "10.05", count: 1 }, { month: "2025-02", amount: "0.00", count: 0 },
      { month: "2025-03", amount: "120.10", count: 2 }, { month: "2025-04", amount: "0.00", count: 0 },
      { month: "2025-05", amount: "0.00", count: 0 }, { month: "2025-06", amount: "0.00", count: 0 },
    ]);
    expect(r.byType).toEqual([{ utilityType: "electricity", amount: "100.00", count: 1 }, { utilityType: "water", amount: "30.15", count: 2 }]);
    expect(r.byOwner).toEqual([{ id: c2.id, name: c2.name, amount: "100.00", count: 1 }, { id: c1.id, name: c1.name, amount: "30.15", count: 2 }]);
    // Facilities have their own summary (none here); bad periods are 422.
    expect((await s("opsF", "from=2025-01-01&to=2025-06-30")).totalBills).toBe(3);
    expect((await ok<{ totalBills: number }>("opsF" as Key, "GET", "/api/v1/facilities/bills-summary?from=2025-01-01&to=2025-06-30")).totalBills).toBe(0);
    expect((await call("opsF" as Key, "GET", "/api/v1/companies/bills-summary?from=2025-06-01&to=2025-01-01")).statusCode).toBe(422);
    expect((await call("opsF" as Key, "GET", "/api/v1/companies/bills-summary?tz=Mars/Base")).statusCode).toBe(422);
    expect((await call("opsF" as Key, "GET", "/api/v1/companies/bills-summary?from=2010-01-01&to=2025-01-01")).statusCode).toBe(422);
    // Default period: 12 months ending this month in tz.
    const def = await s("opsF", "tz=America/Chicago");
    expect(def.byMonth).toHaveLength(12);
    // Dallas admin sees none of Fort Worth's owners.
    const d = await ok<{ byOwner: { id: string }[] }>("locD", "GET", "/api/v1/companies/bills-summary?from=2025-01-01&to=2025-06-30");
    expect(d.byOwner.map((o) => o.id)).not.toContain(c1.id);
  });

  it("invoice: presigned upload, 409 while scanning, download link once clean, logged and audited", async () => {
    const { c, water } = await setup();
    const b = await bill(c.id, water.id, "42.00", "2025-05");
    expect((await call("locD", "GET", `/api/v1/bills/${b.id}/invoice`)).json().detail).toBe("no_invoice");
    const file = Buffer.from("%PDF-1.7\n% fictional invoice\n%%EOF\n");
    const start = await ok<{ id: string; documentId: string; fileId: string; status: string; upload: { url: string; fields: Record<string, string> } }>(
      "locD", "POST", `/api/v1/bills/${b.id}/invoice`, { fileName: "march.pdf", contentType: "application/pdf", size: file.length }, 201);
    expect(start).toMatchObject({ classification: "internal", status: "pending" });
    expect(start.documentId).toBe(start.id);
    const pending = await call("locD", "GET", `/api/v1/bills/${b.id}/invoice`);
    expect([pending.statusCode, pending.json().detail]).toEqual([409, "not_available"]);
    const boundary = "----facInvoice";
    const parts: Buffer[] = [];
    for (const [k, v] of Object.entries(start.upload.fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="Landlord Lee invoice.pdf"\r\nContent-Type: application/pdf\r\n\r\n`), file, Buffer.from(`\r\n--${boundary}--\r\n`));
    const up = await app.inject({ method: "POST", url: start.upload.url, payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } });
    expect(up.statusCode, up.body).toBe(204);
    await new JobRunner(db.worker, [documentScanJob(new LocalDocumentStore(docs), DEFAULT_SCAN_OPTIONS)], silentLogger).tick();
    const listed = (await ok<{ items: { id: string; invoice: unknown }[] }>("locD", "GET", `/api/v1/companies/${c.id}/bills`)).items.find((x) => x.id === b.id)!;
    expect(listed.invoice).toEqual({ documentId: start.id, fileName: `invoice-2025-05-01-${start.id.slice(0, 8)}.pdf`, status: "clean" });
    const head = await auditHead();
    const dl = await ok<{ url: string; expiresAt: string }>("locD", "GET", `/api/v1/bills/${b.id}/invoice`);
    const got = await app.inject({ method: "GET", url: dl.url });
    expect(got.statusCode).toBe(200);
    expect(got.rawPayload.equals(file)).toBe(true);
    expect(String(got.headers["content-disposition"])).not.toContain("Landlord");
    expect(await auditSince(head)).toEqual([expect.objectContaining({ action: "bill.invoice_downloaded", entity_id: b.id })]);
    expect((await db.admin.query(`SELECT count(*)::int AS n FROM eureka.document_access WHERE document_id = $1`, [start.id])).rows[0].n).toBe(1);
    // Other location and other roles.
    expect((await call("opsA", "GET", `/api/v1/bills/${b.id}/invoice`)).statusCode).toBe(404);
    expect((await call("opsA", "POST", `/api/v1/bills/${b.id}/invoice`, { contentType: "application/pdf", size: 10 })).statusCode).toBe(404);
    expect((await call("hr", "GET", `/api/v1/bills/${b.id}/invoice`)).statusCode).toBe(403);
    // HR (document:read everywhere) cannot reach the invoice through the candidate documents API either.
    expect((await call("hr", "POST", `/api/v1/documents/${start.id}/download`)).statusCode).toBe(404);
    expect((await call("locD", "POST", `/api/v1/bills/${b.id}/invoice`, { contentType: "text/html", size: 10 })).statusCode).toBe(422);
  });
});

describe("CSV exports", () => {
  it("formula-like cells are neutralised; no notes, owner contact, account numbers or passwords", async () => {
    const evil = `=HYPERLINK("http://evil.invalid","x") ${++n}`;
    const c = await ok<{ id: string }>("locD", "POST", "/api/v1/companies", { locationId: LOC.dallas, name: evil, city: "+cmd", state: "@SUM(1)", notes: "Quiet street notes" }, 201);
    const r = await call("locD", "GET", `/api/v1/companies/export.csv?q=${encodeURIComponent("hyperlink")}`);
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toMatch(/^text\/csv/);
    expect(String(r.headers["content-disposition"])).toMatch(/^attachment; filename="companies-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(r.body).toContain(`"'=HYPERLINK(""http://evil.invalid"",""x"") ${n}"`);
    expect(r.body).toContain(",'+cmd,'@SUM(1),");
    expect(r.body).not.toContain("Quiet street notes");
    expect(r.body.split("\r\n")[0]).toBe("﻿Name,Location,Street,City,State,ZIP,Country,Status,Incharges,Employees");

    const f = await ok<{ id: string }>("locD", "POST", "/api/v1/facilities", { locationId: LOC.dallas, name: `-2+3 ${n}`, ownerName: "Landlord Lee", ownerEmail: "landlord@example.invalid", rent: "10" }, 201);
    const fx = await call("locD", "GET", `/api/v1/facilities/export.csv`);
    expect(fx.body).toContain(`'-2+3 ${n}`);
    expect(fx.body).not.toContain("Landlord Lee");
    expect(fx.body).not.toContain("landlord@example.invalid");
    expect(fx.body).not.toContain(opsA);
    void f;

    const u = await ok<{ id: string }>("locD", "POST", `/api/v1/companies/${c.id}/utilities`,
      { utilityType: "other", serviceProvider: "=1+1", accountNumber: "ACCT-778899", password: PASSWORD }, 201);
    await ok("locD", "POST", `/api/v1/companies/${c.id}/bills`,
      { utilityId: u.id, paymentMethod: "cash", amount: "5", billingStart: "2025-01-01", billingEnd: "2025-01-31", dueDate: "2025-02-15" }, 201);
    const bx = await call("locD", "GET", `/api/v1/companies/${c.id}/bills/export.csv`);
    expect(bx.statusCode).toBe(200);
    expect(bx.body).toContain("other,'=1+1,cash,5.00,2025-01-01,2025-01-31,2025-02-15,,overdue");
    expect(bx.body).not.toContain("ACCT-778899");
    expect(bx.body).not.toContain(PASSWORD);
    expect((await call("opsA", "GET", `/api/v1/companies/${c.id}/bills/export.csv`)).statusCode).toBe(404);
    expect((await call("r1a", "GET", `/api/v1/companies/export.csv`)).statusCode).toBe(403);
    const exported = (await db.admin.query(`SELECT changes FROM eureka.audit_event WHERE action = 'company.exported' ORDER BY seq DESC LIMIT 1`)).rows[0].changes;
    expect(exported).toEqual({ rows: 1, truncated: false, status: null, locationId: null, searched: true });
  });
});

describe("rule 5: no PII or free text in audit_event or outbox_event", () => {
  it("names, addresses, owner contact, account numbers, usernames, passwords, notes and void reasons never reach them", async () => {
    // Earlier tests wrote all of these through every write endpoint; add the remaining ones.
    const c = await company("locD", LOC.dallas, { street: "1 Secret Street" });
    await ok("locD", "PATCH", `/api/v1/companies/${c.id}`, { name: "Renamed Secret Co", notes: "Quiet street notes" }, 200, ifMatch(1));
    const audit = await auditText();
    const outbox = await outboxText();
    for (const t of [...SECRET_TEXTS, "1 Secret Street", "Renamed Secret Co", c.name, "Fictional Power", "Meter in the garage"]) {
      expect(audit, t).not.toContain(t);
      expect(outbox, t).not.toContain(t);
    }
    const updated = (await db.admin.query(`SELECT changes FROM eureka.audit_event WHERE action = 'company.updated' AND entity_id = $1`, [c.id])).rows[0].changes;
    expect(updated).toEqual({ changed: ["name", "notes"], rowVersion: 2 });
    // Every action of this module, by name.
    const actions = (await db.admin.query<{ action: string }>(
      `SELECT DISTINCT action FROM eureka.audit_event WHERE action ~ '^(company|facility|utility|bill)\\.' ORDER BY 1`)).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining([
      "bill.created", "bill.invoice_downloaded", "bill.invoice_upload_requested", "bill.updated", "bill.voided", "company.created",
      "company.employee_added", "company.employee_ended", "company.exported", "company.incharge_added", "company.incharge_removed",
      "company.updated", "facility.created", "utility.created", "utility.password_revealed", "utility.updated",
    ]));
  });
});
