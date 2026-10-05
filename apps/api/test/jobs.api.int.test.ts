import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { can, jobAllowed, type UserAccess } from "@eureka/shared";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { CLIENT_ID, T, U, seedFixtures, toUserAccess } from "./fixtures.js";

/** API and database checks for jobs (docs/jobs-portal-api.md JP-1..JP-9, migration 0060). */
let db: TestDb;
let app: NestFastifyApplication;
const SECRET = "test-secret-test-secret-test-secret-123";
const OTHER_CLIENT = "00000000-0000-0000-0000-000000000699";

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  await db.admin.query(`INSERT INTO eureka.client (id, name) VALUES ($1, 'Other Client')`, [OTHER_CLIENT]);
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
  return app.inject({ method, url, payload: payload as never,
    headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}), ...headers } });
}

const RICH = { blocks: [
  { type: "p", runs: [{ text: "Build " }, { text: "APIs", marks: ["b"] }, { text: " docs", href: "https://example.com/docs" }] },
  { type: "ul", items: [[{ text: "Java" }], [{ text: "SQL" }]] },
] };
const clientReq = (over: Record<string, unknown> = {}) => ({
  kind: "client_requirement", title: "Java Developer", category: "engineering", experienceLevel: "senior",
  employmentType: "contract", workMode: "hybrid", status: "open", clientId: CLIENT_ID, location: "Dallas, TX",
  skills: ["Java", "Spring", "java"], requirements: RICH, description: RICH, pay: { amount: 65.5, frequency: "hourly", currency: "USD" },
  ...over,
});
const internal = (over: Record<string, unknown> = {}) => ({
  kind: "internal_opening", title: "HR Generalist", category: "hr", experienceLevel: "mid", employmentType: "full_time",
  workMode: "on_site", status: "open", publishedToPortal: true, deadline: "2026-12-30", workHours: 40,
  pay: { amount: 60000, frequency: "yearly", currency: "USD" }, ...over,
});

async function created(key: Key, body: unknown): Promise<string> {
  const r = await call(key, "POST", "/api/v1/jobs", body);
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id;
}

describe("create and read (JP-1, JP-2)", () => {
  let reqId: string, ioId: string;
  beforeAll(async () => {
    reqId = await created("l1", clientReq());
    ioId = await created("hr", internal({ hiringManagerId: U.r2a }));
  });

  it("stores the job with server-managed owner, team and posted time; skills deduplicated", async () => {
    const r = await call("l1", "GET", `/api/v1/jobs/${reqId}`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      kind: "client_requirement", title: "Java Developer", client: { id: CLIENT_ID }, owner: { id: U.l1 }, team: { id: T.t1 },
      skills: ["Java", "Spring"], requirements: RICH, pay: { amount: 65.5, frequency: "hourly", currency: "USD" },
      rowVersion: 1, actions: { edit: true }, applicants: 0,
    });
    expect(r.json().postedAt).not.toBeNull();
  });

  it.each(Object.keys(U) as Key[])("visibility for %s matches the shared rule", async (k) => {
    const access: UserAccess = toUserAccess(k);
    const req = (await call(k, "GET", `/api/v1/jobs/${reqId}`)).statusCode;
    const io = (await call(k, "GET", `/api/v1/jobs/${ioId}`)).statusCode;
    expect(req, "client requirement").toBe(jobAllowed(access, "job:read", { kind: "client_requirement", ownerId: U.l1, teamId: T.t1, hiringManagerId: null }) ? 200 : 404);
    expect(io, "internal opening").toBe(jobAllowed(access, "job:read", { kind: "internal_opening", ownerId: U.hr, teamId: null, hiringManagerId: U.r2a }) ? 200 : 404);
    const list = await call(k, "GET", "/api/v1/jobs?limit=200");
    expect(list.statusCode).toBe(can(access, "job:read") ? 200 : 403);
  });

  it("hides a client requirement's pay from readers without rate:read who cannot manage it", async () => {
    const r = (await call("r1a", "GET", `/api/v1/jobs/${reqId}`)).json();
    expect(r.pay).toBeNull();
    expect(r.payHidden).toBe(true);
    expect(r.actions.edit).toBe(false);
    expect((await call("ceo", "GET", `/api/v1/jobs/${reqId}`)).json().pay).toMatchObject({ amount: 65.5 });
  });

  it("only the right roles create each kind", async () => {
    expect((await call("hr", "POST", "/api/v1/jobs", clientReq())).statusCode).toBe(403);
    expect((await call("l1", "POST", "/api/v1/jobs", internal())).statusCode).toBe(403);
    expect((await call("r1a", "POST", "/api/v1/jobs", clientReq())).statusCode).toBe(403);
    expect((await call("ceo", "POST", "/api/v1/jobs", clientReq())).statusCode).toBe(403);
  });

  it("audits ids and codes only (no title, pay, location or rich text)", async () => {
    const rows = (await db.admin.query(`SELECT changes::text AS c FROM eureka.audit_event WHERE entity_id = ANY($1)`, [[reqId, ioId]])).rows;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) expect(r.c).not.toMatch(/Java Developer|HR Generalist|65\.5|60000|Dallas|Build|example\.com/);
  });
});

describe("validation", () => {
  it.each([
    ["unsafe link", clientReq({ description: { blocks: [{ type: "p", runs: [{ text: "x", href: "javascript:alert(1)" }] }] } })],
    ["html in rich text", clientReq({ description: { blocks: [{ type: "p", runs: [{ text: "x" }], html: "<script>" }] } })],
    ["client requirement without client", clientReq({ clientId: undefined })],
    ["published client requirement", clientReq({ publishedToPortal: true })],
    ["server-managed field", clientReq({ ownerId: U.l2 })],
    ["unknown status", clientReq({ status: "archived" })],
    ["control characters", clientReq({ title: "a\u0007b" })],
  ])("422: %s", async (_name, body) => {
    expect((await call("l1", "POST", "/api/v1/jobs", body)).statusCode).toBe(422);
  });

  it("422 for an inactive hiring manager", async () => {
    await db.admin.query(`INSERT INTO eureka.app_user (id, email, display_name, status) VALUES ('00000000-0000-0000-0000-000000000777', 'gone@eureka.example', 'Gone', 'inactive')`);
    const r = await call("hr", "POST", "/api/v1/jobs", internal({ hiringManagerId: "00000000-0000-0000-0000-000000000777" }));
    expect(r.statusCode).toBe(422);
    expect(r.json().detail).toBe("invalid_hiring_manager");
  });

  it("Idempotency-Key replays the first response and refuses a different body", async () => {
    const h = { "idempotency-key": `jobs-${Date.now()}` };
    const a = await call("l1", "POST", "/api/v1/jobs", clientReq({ title: "Idem" }), h);
    const b = await call("l1", "POST", "/api/v1/jobs", clientReq({ title: "Idem" }), h);
    expect(a.statusCode).toBe(201);
    expect(b.json().id).toBe(a.json().id);
    expect((await call("l1", "POST", "/api/v1/jobs", clientReq({ title: "Other" }), h)).statusCode).toBe(409);
  });
});

describe("update (JP-3)", () => {
  let id: string;
  beforeAll(async () => { id = await created("l1", clientReq({ status: "draft" })); });

  it("needs If-Match and refuses a stale version", async () => {
    expect((await call("l1", "PATCH", `/api/v1/jobs/${id}`, { status: "open" })).statusCode).toBe(428);
    expect((await call("l1", "PATCH", `/api/v1/jobs/${id}`, { status: "open" }, { "if-match": '"9"' })).statusCode).toBe(412);
    const ok = await call("l1", "PATCH", `/api/v1/jobs/${id}`, { status: "open", title: "Java Lead" }, { "if-match": '"1"' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ status: "open", title: "Java Lead", rowVersion: 2 });
    expect(ok.json().postedAt).not.toBeNull();
  });

  it("is refused outside the manager's scope (403 visible, 404 invisible)", async () => {
    expect((await call("r1a", "PATCH", `/api/v1/jobs/${id}`, { title: "x" }, { "if-match": '"2"' })).statusCode).toBe(403);
    expect((await call("l3", "PATCH", `/api/v1/jobs/${id}`, { title: "x" }, { "if-match": '"2"' })).statusCode).toBe(404);
    expect((await call("m1", "PATCH", `/api/v1/jobs/${id}`, { kind: "internal_opening" }, { "if-match": '"2"' })).statusCode).toBe(422);
  });
});

describe("submissions name a client requirement (JP-8)", () => {
  let jobId: string, closedId: string, candidateId: string;
  beforeAll(async () => {
    jobId = await created("l1", clientReq());
    closedId = await created("l1", clientReq({ status: "closed" }));
    candidateId = (await db.admin.query(`SELECT id FROM eureka.candidate WHERE recruiter_id = $1 AND marketing_status = 'active' LIMIT 1`, [U.r1a])).rows[0].id;
  });

  it("accepts an open job of the same client and counts it", async () => {
    const r = await call("r1a", "POST", "/api/v1/submissions", { candidateId, clientId: CLIENT_ID, jobTitle: "Java Developer", jobId });
    expect(r.statusCode, r.body).toBe(201);
    expect((await call("l1", "GET", `/api/v1/jobs/${jobId}`)).json().applicants).toBe(1);
    const sub = await call("r1a", "GET", `/api/v1/submissions/${r.json().id}`);
    expect(sub.json().jobId).toBe(jobId);
  });

  it.each([
    ["another client", () => ({ clientId: OTHER_CLIENT, jobId }), "job_client_mismatch"],
    ["a closed job", () => ({ clientId: CLIENT_ID, jobId: closedId }), "job_not_open"],
  ])("refuses %s", async (_n, extra, code) => {
    const r = await call("r1a", "POST", "/api/v1/submissions", { candidateId, jobTitle: "x", ...extra() });
    expect(r.statusCode).toBe(422);
    expect(r.json().detail).toBe(code);
  });

  it("refuses a job the recruiter cannot read", async () => {
    const r3Cand = (await db.admin.query(`SELECT id FROM eureka.candidate WHERE recruiter_id = $1 AND marketing_status = 'active' LIMIT 1`, [U.r3a])).rows[0].id;
    const r = await call("r3a", "POST", "/api/v1/submissions", { candidateId: r3Cand, clientId: CLIENT_ID, jobTitle: "x", jobId });
    expect(r.statusCode).toBe(422);
    expect(r.json().detail).toBe("job_not_found");
  });
});

describe("RLS, direct SQL as eureka_app", () => {
  let jobId: string;
  beforeAll(async () => { jobId = await created("l1", clientReq()); });

  it("reads follow the policy", async () => {
    const seen = async (u: string) => asUser(db.app, u, async (c) => (await c.query(`SELECT id FROM eureka.job WHERE id = $1`, [jobId])).rowCount);
    expect(await seen(U.r1a)).toBe(1);
    expect(await seen(U.r3a)).toBe(0);
    expect(await seen(U.hr)).toBe(0);
    expect(await seen(U.coach)).toBe(0);
  });

  it("refuses writes outside job:manage and spoofed server-managed columns", async () => {
    const ins = (u: string, extra = "") => asUser(db.app, u, (c) => c.query(
      `INSERT INTO eureka.job (kind, title, category, experience_level, employment_type, work_mode, client_id${extra ? ", owner_id" : ""})
       VALUES ('client_requirement', 'x', 'other', 'mid', 'contract', 'remote', $1${extra ? ", $2" : ""})`, extra ? [CLIENT_ID, extra] : [CLIENT_ID]));
    await expect(ins(U.r1a)).rejects.toMatchObject({ code: "42501" });
    await expect(ins(U.l1, U.l2)).rejects.toMatchObject({ code: "42501" });
    await expect(ins(U.l1)).resolves.toBeTruthy();
    await expect(asUser(db.app, U.l1, (c) => c.query(`UPDATE eureka.job SET row_version = 99 WHERE id = $1`, [jobId]))).rejects.toMatchObject({ code: "42501" });
    await expect(asUser(db.app, U.l1, (c) => c.query(`DELETE FROM eureka.job WHERE id = $1`, [jobId]))).rejects.toMatchObject({ code: "42501" });
    const upd = await asUser(db.app, U.l3, (c) => c.query(`UPDATE eureka.job SET title = 'y' WHERE id = $1`, [jobId]));
    expect(upd.rowCount).toBe(0);
  });
});
