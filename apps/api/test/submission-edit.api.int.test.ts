import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { CLIENT_ID, U, seedFixtures, type FixtureCandidate } from "./fixtures.js";

// PATCH /api/v1/submissions/:id (docs/submissions-api.md "Editing details", migration 0420).
let db: TestDb;
let app: NestFastifyApplication;
let candidates: FixtureCandidate[];
const SECRET = "test-secret-test-secret-test-secret-123";
const CLIENT2 = "00000000-0000-4000-8000-00000000e201";
const VENDOR = "00000000-0000-4000-8000-00000000e202";

beforeAll(async () => {
  db = await createTestDb();
  candidates = await seedFixtures(db.admin);
  await db.admin.query(`INSERT INTO eureka.client (id, name) VALUES ($1, 'Contoso Health')`, [CLIENT2]);
  await db.admin.query(`INSERT INTO eureka.vendor (id, name) VALUES ($1, 'Prime Vendor Co')`, [VENDOR]);
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

type Key = keyof typeof U;
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
async function call(key: Key, method: "GET" | "POST" | "PATCH", url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const s = await login(key);
  return app.inject({
    method, url, payload: payload as never,
    headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}), ...headers },
  });
}

const r1aCandidate = () => candidates.find((c) => c.recruiterId === U.r1a && c.marketingStatus === "active")!;
/** A fresh submission by r1a (team t1), optionally with one interview. */
async function submission(withInterview = false): Promise<string> {
  return asUser(db.app, U.r1a, async (c) => {
    const id = (await c.query<{ id: string }>(
      `INSERT INTO eureka.submission (candidate_id, job_title, client_id, rate) VALUES ($1,'Java Developer',$2,55) RETURNING id`,
      [r1aCandidate().id, CLIENT_ID])).rows[0]!.id;
    if (withInterview) {
      await c.query(`INSERT INTO eureka.interview (submission_id, round, starts_at, ends_at)
        VALUES ($1,'L1','2030-03-01T15:00:00Z','2030-03-01T16:00:00Z')`, [id]);
    }
    return id;
  }, true);
}

describe("submission detail edits", () => {
  it("lead of the team corrects title, client and vendor; the edit is stamped and audited without values", async () => {
    const id = await submission();
    const res = await call("l1", "PATCH", `/api/v1/submissions/${id}`, { jobTitle: "Senior Java Developer", clientId: CLIENT2, vendorId: VENDOR });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.changed.sort()).toEqual(["clientId", "jobTitle", "vendorId"]);
    expect(body.submission).toMatchObject({ jobTitle: "Senior Java Developer", clientId: CLIENT2, vendorId: VENDOR, client: "Contoso Health" });
    expect(body.submission.detailsEdited?.at).toBeTruthy();
    expect(body.submission.actions).toMatchObject({ editDetails: true, editRate: false });
    expect(body.submission).not.toHaveProperty("rate");
    const audit = await db.admin.query(`SELECT changes FROM eureka.audit_event WHERE action = 'submission.edited' AND entity_id = $1`, [id]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].changes).toEqual({ fields: expect.arrayContaining(["jobTitle", "clientId", "vendorId"]) });
    expect(JSON.stringify(audit.rows[0].changes)).not.toContain("Senior");
  });

  it("sending the same values changes nothing and writes no audit", async () => {
    const id = await submission();
    const res = await call("l1", "PATCH", `/api/v1/submissions/${id}`, { jobTitle: "Java Developer" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().changed).toEqual([]);
    expect(res.json().submission.detailsEdited).toBeNull();
  });

  it("the recruiter cannot edit details (status only); out-of-scope leads get 404", async () => {
    const id = await submission();
    expect((await call("r1a", "PATCH", `/api/v1/submissions/${id}`, { jobTitle: "X" })).statusCode).toBe(403);
    expect((await call("l3", "PATCH", `/api/v1/submissions/${id}`, { jobTitle: "X" })).statusCode).toBe(404);
    const r1a = (await call("r1a", "GET", `/api/v1/submissions/${id}`)).json();
    expect(r1a.actions).toMatchObject({ editDetails: false, editRate: false });
  });

  it("the rate needs rate:read: lead refused, manager allowed", async () => {
    const id = await submission();
    const lead = await call("l1", "PATCH", `/api/v1/submissions/${id}`, { rate: 60 });
    expect(lead.statusCode).toBe(403);
    expect(lead.json().detail).toBe("field_not_permitted");
    const mgr = await call("m1", "PATCH", `/api/v1/submissions/${id}`, { rate: 60.5 });
    expect(mgr.statusCode, mgr.body).toBe(200);
    expect(mgr.json().submission.rate).toBe(60.5);
    expect((await call("ceo", "PATCH", `/api/v1/submissions/${id}`, { rate: 1001 })).statusCode).toBe(422);
  });

  it("an interview locks the client but not the other fields", async () => {
    const id = await submission(true);
    const res = await call("l1", "PATCH", `/api/v1/submissions/${id}`, { clientId: CLIENT2 });
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toBe("client_locked");
    expect((await call("l1", "PATCH", `/api/v1/submissions/${id}`, { jobTitle: "Java Lead" })).statusCode).toBe(200);
  });

  it("rejects a future submitted time and unknown keys; status is not editable here", async () => {
    const id = await submission();
    const future = await call("l1", "PATCH", `/api/v1/submissions/${id}`, { submittedAt: "2999-01-01T00:00:00Z" });
    expect(future.statusCode).toBe(422);
    expect(future.json().detail).toBe("invalid_submitted_at");
    expect((await call("l1", "PATCH", `/api/v1/submissions/${id}`, { status: "selected" })).statusCode).toBe(422);
    expect((await call("l1", "PATCH", `/api/v1/submissions/${id}`, {})).statusCode).toBe(422);
    const past = await call("l1", "PATCH", `/api/v1/submissions/${id}`, { submittedAt: "2026-01-05T10:00:00Z" });
    expect(past.statusCode, past.body).toBe(200);
    expect(new Date(past.json().submission.submittedAt).toISOString()).toBe("2026-01-05T10:00:00.000Z");
  });

  it("a placement in progress freezes the submission", async () => {
    const id = await submission();
    for (const to of ["under_review", "interview_requested", "interview_scheduled", "interview_completed", "selected"]) {
      expect((await call("r1a", "PATCH", `/api/v1/submissions/${id}/status`, { to })).statusCode).toBe(200);
    }
    const pl = await call("r1a", "POST", "/api/v1/placements", {
      submissionId: id, placementType: "w2", rate: 62.5, workMode: "remote", tentativeStart: "2031-02-02",
    }, { "idempotency-key": `edit-${id}` });
    expect(pl.statusCode, pl.body).toBe(201);
    const res = await call("l1", "PATCH", `/api/v1/submissions/${id}`, { jobTitle: "Changed" });
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toBe("submission_placed");
  });

  it("the database refuses the stamps on insert and edits without the permission", async () => {
    await expect(asUser(db.app, U.r1a, (c) => c.query(
      `INSERT INTO eureka.submission (candidate_id, job_title, client_id, details_edited_at) VALUES ($1,'X',$2, now())`,
      [r1aCandidate().id, CLIENT_ID]), true)).rejects.toThrow(/server_managed_field/);
    const id = await submission();
    await expect(asUser(db.app, U.r1a, (c) => c.query(
      `SELECT authz.edit_submission($1, '{"jobTitle":"X"}'::jsonb)`, [id]), true)).rejects.toThrow(/not_permitted/);
    await expect(asUser(db.app, U.r1a, (c) => c.query(
      `UPDATE eureka.submission SET job_title = 'X' WHERE id = $1`, [id]), true)).rejects.toThrow(/permission denied/);
  });
});
