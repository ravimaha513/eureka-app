import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { BULK_CANDIDATE_CALLS_PER_MINUTE, BULK_CANDIDATE_ROWS_PER_DAY } from "../src/modules/candidates/candidates.service.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, TECH_ID, U, seedFixtures } from "./fixtures.js";

/** New candidates for a batch from the Excel template (docs/candidates-api.md). */
let db: TestDb;
let app: NestFastifyApplication;
let batchId: string;

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: "test-secret-test-secret-test-secret-123",
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
  const res = await call("m1", "POST", "/api/v1/training/batches", { name: "Java November", locationId: LOC.dallas, technologyId: TECH_ID, startDate: "2031-11-01" });
  expect(res.statusCode).toBe(201);
  batchId = res.json().id;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

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
async function call(key: keyof typeof U, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) {
  const s = await login(key);
  return app.inject({ method, url, payload: payload as never, headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}) } });
}
const bulk = (key: keyof typeof U, body: unknown, id = batchId) => call(key, "POST", `/api/v1/batches/${id}/candidates/bulk`, body);
const row = (n: number, extra: Record<string, string> = {}) => ({
  firstName: `Bulk${n}`, lastName: "Tester", phone: `+1 469 555 ${String(1000 + n)}`, email: `Bulk${n}@Example.com`, ...extra,
});
const count = async (email: string) => (await db.admin.query(`SELECT count(*)::int AS n FROM eureka.person WHERE personal_email = $1`, [email])).rows[0].n as number;

describe("batch candidate template", () => {
  it("gives candidate:create holders the .xlsx; others 403", async () => {
    const ok = await call("l1", "GET", "/api/v1/batches/candidate-template");
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toContain("spreadsheetml");
    expect(ok.rawPayload.subarray(0, 2).toString()).toBe("PK");
    expect((await call("r1a", "GET", "/api/v1/batches/candidate-template")).statusCode).toBe(403);
  });
});

describe("bulk add", () => {
  it("previews without creating, then creates in the batch's technology and location", async () => {
    const rows = [row(1), row(2)];
    const preview = await bulk("l1", { dryRun: true, rows });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ dryRun: true, committed: false, created: 0, failed: 0 });
    expect(preview.json().rows[0]).toMatchObject({ row: 1, status: "ok", phone: "+14695551001", email: "bulk1@example.com" });
    expect(await count("bulk1@example.com")).toBe(0);

    const done = await bulk("l1", { dryRun: false, rows });
    expect(done.json()).toMatchObject({ committed: true, created: 2, failed: 0 });
    const { rows: made } = await db.admin.query(
      `SELECT c.batch_id, c.technology_id, c.location_id, c.team_id FROM eureka.candidate c JOIN eureka.person p ON p.id = c.person_id WHERE p.personal_email = 'bulk1@example.com'`);
    expect(made).toEqual([{ batch_id: batchId, technology_id: TECH_ID, location_id: LOC.dallas, team_id: T.t1 }]);
  });

  it("creates with no team (teamId null), keeping the creator as recruiter so they still see them", async () => {
    const done = await bulk("l1", { dryRun: false, teamId: null, rows: [row(40)] });
    expect(done.json()).toMatchObject({ committed: true, created: 1, failed: 0 });
    const { rows: made } = await db.admin.query(
      `SELECT c.team_id, c.recruiter_id FROM eureka.candidate c JOIN eureka.person p ON p.id = c.person_id WHERE p.personal_email = 'bulk40@example.com'`);
    expect(made).toEqual([{ team_id: null, recruiter_id: U.l1 }]);
  });

  it("creates nothing when any row fails, and says why per row", async () => {
    const res = await bulk("l1", { dryRun: false, rows: [
      row(10),
      row(11, { firstName: " " }),
      row(12, { lastName: "" }),
      row(13, { phone: "4695550142" }),
      row(14, { email: "nope" }),
      row(15, { email: "bulk10@example.com" }),
      row(16, { email: "bulk1@example.com" }),
      row(17, { phone: "+1 469 555 1002" }),
    ] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ committed: false, created: 0, failed: 7 });
    expect(res.json().rows.map((r: { error?: string }) => r.error)).toEqual([
      undefined, "invalid_first_name", "invalid_last_name", "missing_country_code", "invalid_email", "duplicate_in_file", "duplicate_email", "duplicate_phone",
    ]);
    expect(await count("bulk10@example.com")).toBe(0);
  });

  it("keeps contact values out of the audit trail", async () => {
    const { rows } = await db.admin.query(`SELECT changes::text AS c FROM eureka.audit_event WHERE action LIKE 'batch.candidates_%' OR (action = 'candidate.created' AND changes ->> 'bulk' = 'true')`);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.c).join()).not.toMatch(/example\.com|\+1469/);
  });

  it("checks the team and permission: 403 outside scope, recruiter refused", async () => {
    expect((await bulk("l1", { dryRun: true, teamId: T.t2, rows: [row(20)] })).statusCode).toBe(403);
    expect((await bulk("r1a", { dryRun: true, rows: [row(20)] })).statusCode).toBe(403);
    expect((await bulk("m1", { dryRun: true, teamId: T.t2, rows: [row(20)] })).statusCode).toBe(200);
  });

  it("404 for an unknown batch, 422 for a closed one or a bad body", async () => {
    expect((await bulk("l2", { dryRun: true, rows: [row(30)] }, "00000000-0000-4000-8000-000000000000")).statusCode).toBe(404);
    expect((await bulk("l2", { dryRun: true, rows: [] })).statusCode).toBe(422);
    expect((await bulk("l2", { dryRun: true, rows: [{ ...row(30), technologyId: TECH_ID }] })).statusCode).toBe(422);
    const b = await call("m1", "POST", "/api/v1/training/batches", { name: "Closed", locationId: LOC.dallas, technologyId: TECH_ID, startDate: "2031-12-01" });
    expect((await call("m1", "PUT", `/api/v1/batches/${b.json().id}/status`, { to: "cancelled" })).statusCode).toBe(200);
    const closed = await bulk("l2", { dryRun: true, rows: [row(31)] }, b.json().id);
    expect(closed.statusCode).toBe(422);
    expect(closed.json().detail).toBe("batch_not_allowed");
  });

  it("limits calls per user", async () => {
    let last = 0;
    for (let i = 0; i <= BULK_CANDIDATE_CALLS_PER_MINUTE; i++) last = (await bulk("l3", { dryRun: true, rows: [row(40)] })).statusCode;
    expect(last).toBe(429);
  });
});

/** Daily row budget (A-01) and the set-based contact check (A-07), migration 0475. */
describe("bulk add: daily row budget and set-based check", () => {
  const used = async (id: string) => (await db.admin.query(
    `SELECT rows_checked FROM eureka.bulk_candidate_budget WHERE user_id = $1 AND day = (now() AT TIME ZONE 'UTC')::date`, [id])).rows[0]?.rows_checked as number | undefined;
  const lastAudit = async (actor: string, action: string) => (await db.admin.query(
    `SELECT changes FROM eureka.audit_event WHERE actor_id = $1 AND action = $2 ORDER BY seq DESC LIMIT 1`, [actor, action])).rows[0]?.changes;

  it("charges previews and real runs, only rows checked against existing contacts, and records the counts", async () => {
    const before = (await used(U.l1)) ?? 0;
    // Row 2 is refused in memory (not charged); row 3 has a contact an earlier test created (charged, taken).
    const res = await bulk("l1", { dryRun: true, rows: [row(60), row(61, { email: "nope" }), row(62, { email: "bulk1@example.com" })] });
    expect(res.statusCode).toBe(200);
    expect(res.json().rows.map((r: { error?: string }) => r.error)).toEqual([undefined, "invalid_email", "duplicate_email"]);
    expect(await used(U.l1)).toBe(before + 2);
    expect(await lastAudit(U.l1, "batch.candidates_checked")).toEqual({ rows: 3, failed: 2, checked: 2, taken: 1 });
    const done = await bulk("l1", { dryRun: false, rows: [row(63)] });
    expect(done.json()).toMatchObject({ committed: true, created: 1 });
    expect(await used(U.l1)).toBe(before + 3);
    expect(await lastAudit(U.l1, "batch.candidates_added")).toEqual({ teamId: T.t1, created: 1, checked: 1, taken: 0 });
  });

  it("answers 429 bulk_budget_exceeded past the budget, preview or not, and charges nothing then", async () => {
    await db.admin.query(`INSERT INTO eureka.bulk_candidate_budget (user_id, day, rows_checked) VALUES ($1, (now() AT TIME ZONE 'UTC')::date, $2)`,
      [U.m2, BULK_CANDIDATE_ROWS_PER_DAY - 1]);
    const over = await bulk("m2", { dryRun: true, teamId: T.t3, rows: [row(70), row(71)] });
    expect(over.statusCode).toBe(429);
    expect(over.json().detail).toBe("bulk_budget_exceeded");
    expect(await used(U.m2)).toBe(BULK_CANDIDATE_ROWS_PER_DAY - 1);
    expect((await bulk("m2", { dryRun: true, teamId: T.t3, rows: [row(70)] })).statusCode).toBe(200);
    expect(await used(U.m2)).toBe(BULK_CANDIDATE_ROWS_PER_DAY);
    expect((await bulk("m2", { dryRun: false, teamId: T.t3, rows: [row(72)] })).statusCode).toBe(429);
    expect(await count("bulk72@example.com")).toBe(0);
    // Rows refused in memory cost nothing, so a file of only bad rows is still answered.
    expect((await bulk("m2", { dryRun: true, teamId: T.t3, rows: [row(73, { email: "nope" })] })).statusCode).toBe(200);
    // 404 / 403 / 422 come before the budget.
    expect((await bulk("m2", { dryRun: true, rows: [row(74)] }, "00000000-0000-4000-8000-000000000000")).statusCode).toBe(404);
  });

  it("previews a full 500-row file in one pass and commits it all or nothing", async () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({
      firstName: `Big${i}`, lastName: "File", phone: `+1 972 555 ${String(1000 + i)}`, email: `big${i}@example.com` }));
    const t0 = Date.now();
    const preview = await bulk("ceo", { dryRun: true, teamId: T.t1, rows });
    expect(preview.statusCode).toBe(200);
    expect(Date.now() - t0).toBeLessThan(15_000); // smoke check, not a benchmark
    expect(preview.json()).toMatchObject({ dryRun: true, committed: false, created: 0, failed: 0 });
    expect(await count("big0@example.com")).toBe(0);
    const done = await bulk("ceo", { dryRun: false, teamId: T.t1, rows });
    expect(done.json()).toMatchObject({ committed: true, created: 500, failed: 0 });
    const { rows: audits } = await db.admin.query(
      `SELECT count(*)::int AS n FROM eureka.audit_event WHERE actor_id = $1 AND action = 'candidate.created' AND changes ->> 'bulk' = 'true'`, [U.ceo]);
    expect(audits[0].n).toBe(500);
    // A second run of the same file: every row taken, nothing created, per-row codes.
    const again = await bulk("ceo", { dryRun: false, teamId: T.t1, rows: rows.slice(0, 3) });
    expect(again.json()).toMatchObject({ committed: false, created: 0, failed: 3 });
    expect(again.json().rows.map((r: { error?: string }) => r.error)).toEqual(["duplicate_email", "duplicate_email", "duplicate_email"]);
  });

  it("reports a taken phone when only the phone matches (email checked first, as the trigger does)", async () => {
    const res = await bulk("l1", { dryRun: true, rows: [row(80, { phone: "+1 972 555 1000" }), row(81, { email: "big1@example.com", phone: "+1 972 555 1002" })] });
    expect(res.json().rows.map((r: { error?: string }) => r.error)).toEqual(["duplicate_phone", "duplicate_email"]);
  });

  it("keeps the budget table and the contact check to the definer functions", async () => {
    await expect(asUser(db.app, U.l1, (c) => c.query(`SELECT * FROM eureka.bulk_candidate_budget`))).rejects.toThrow(/permission denied/);
    await expect(asUser(db.app, U.r1a, (c) => c.query(`SELECT * FROM authz.candidate_contacts_taken(ARRAY['big1@example.com'], NULL)`)))
      .rejects.toThrow(/not_permitted/);
    await expect(asUser(db.app, U.r1a, (c) => c.query(`SELECT authz.bulk_candidate_budget_take(1, 2000)`))).rejects.toThrow(/not_permitted/);
    const found = await asUser(db.app, U.l1, (c) => c.query(
      `SELECT kind, value FROM authz.candidate_contacts_taken(ARRAY['BIG1@example.com', 'none@example.com'], ARRAY['+19725551003']) ORDER BY 1`));
    expect(found.rows).toEqual([{ kind: "email", value: "big1@example.com" }, { kind: "phone", value: "+19725551003" }]);
    await expect(asUser(db.app, U.l1, (c) => c.query(`SELECT authz.bulk_candidate_budget_take(-1, 2000)`))).rejects.toThrow(/invalid_budget/);
  });
});
