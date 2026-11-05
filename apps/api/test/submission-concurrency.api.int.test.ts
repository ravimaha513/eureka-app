import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { CLIENT_ID, LOC, T, U, seedFixtures } from "./fixtures.js";
import { newCandidate } from "./placement-seed.js";

// docs/submissions-api.md "Concurrency and retries": optional If-Match on the two PATCH routes
// (row_version, migration 0477) and optional Idempotency-Key + serialised duplicate check on POST.
let db: TestDb;
let app: NestFastifyApplication;
const SECRET = "test-secret-test-secret-test-secret-123";

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
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

const candidate = () => newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
async function submission(): Promise<string> {
  const c = await candidate();
  const r = await call("r1a", "POST", "/api/v1/submissions", { candidateId: c.id, jobTitle: "Java Developer", clientId: CLIENT_ID });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}
const version = async (id: string) =>
  (await db.admin.query<{ v: number }>(`SELECT row_version AS v FROM eureka.submission WHERE id = $1`, [id])).rows[0]!.v;
const audits = async (action: string, id: string) =>
  (await db.admin.query(`SELECT 1 FROM eureka.audit_event WHERE action = $1 AND entity_id = $2`, [action, id])).rowCount;

describe("row_version (0477)", () => {
  it("starts at 1, is returned as rowVersion and bumps on every write", async () => {
    const id = await submission();
    expect((await call("r1a", "GET", `/api/v1/submissions/${id}`)).json().rowVersion).toBe(1);
    const list = (await call("r1a", "GET", `/api/v1/submissions?limit=200`)).json().items as { id: string; rowVersion: number }[];
    expect(list.find((s) => s.id === id)?.rowVersion).toBe(1);
    expect((await call("r1a", "PATCH", `/api/v1/submissions/${id}/status`, { to: "under_review" })).json().rowVersion).toBe(2);
    const edit = await call("l1", "PATCH", `/api/v1/submissions/${id}`, { jobTitle: "Java Lead" });
    expect(edit.json().submission.rowVersion).toBe(3);
    expect(await version(id)).toBe(3);
  });

  it("is server-managed: refused on insert, overwritten on update", async () => {
    const c = await candidate();
    await expect(asUser(db.app, U.r1a, (x) => x.query(
      `INSERT INTO eureka.submission (candidate_id, job_title, client_id, row_version) VALUES ($1,'X',$2,5)`, [c.id, CLIENT_ID])))
      .rejects.toThrow(/server_managed_field/);
    const id = await submission();
    await db.admin.query(`UPDATE eureka.submission SET row_version = 50 WHERE id = $1`, [id]);
    expect(await version(id)).toBe(2);
    // eureka_app holds no UPDATE on submission at all.
    await expect(asUser(db.app, U.r1a, (x) => x.query(`UPDATE eureka.submission SET row_version = 9 WHERE id = $1`, [id])))
      .rejects.toThrow(/permission denied/);
  });
});

describe("optional If-Match on PATCH /submissions/:id", () => {
  it("matching version: 200 with the new rowVersion; stale: 412 and nothing changes", async () => {
    const id = await submission();
    const ok = await call("l1", "PATCH", `/api/v1/submissions/${id}`, { jobTitle: "Senior Java" }, { "if-match": '"1"' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().submission).toMatchObject({ jobTitle: "Senior Java", rowVersion: 2 });
    const stale = await call("l1", "PATCH", `/api/v1/submissions/${id}`, { jobTitle: "Lost update" }, { "if-match": '"1"' });
    expect([stale.statusCode, stale.json().detail]).toEqual([412, "stale"]);
    expect((await call("l1", "GET", `/api/v1/submissions/${id}`)).json()).toMatchObject({ jobTitle: "Senior Java", rowVersion: 2 });
    expect(await audits("submission.edited", id)).toBe(1);
  });

  it("no header behaves as before; an unparseable header is stale", async () => {
    const id = await submission();
    expect((await call("l1", "PATCH", `/api/v1/submissions/${id}`, { jobTitle: "No header" })).statusCode).toBe(200);
    expect((await call("l1", "PATCH", `/api/v1/submissions/${id}`, { jobTitle: "Bad" }, { "if-match": "*" })).statusCode).toBe(412);
    expect((await call("l1", "PATCH", `/api/v1/submissions/${id}`, { jobTitle: "Weak ok" }, { "if-match": 'W/"2"' })).statusCode).toBe(200);
  });

  it("a no-op edit with the current version: 200, nothing bumped", async () => {
    const id = await submission();
    const r = await call("l1", "PATCH", `/api/v1/submissions/${id}`, { jobTitle: "Java Developer" }, { "if-match": "1" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().changed).toEqual([]);
    expect(r.json().submission.rowVersion).toBe(1);
  });

  it("404 and 403 come before 412", async () => {
    const id = await submission();
    expect((await call("l3", "PATCH", `/api/v1/submissions/${id}`, { jobTitle: "X" }, { "if-match": '"9"' })).statusCode).toBe(404);
    expect((await call("r1a", "PATCH", `/api/v1/submissions/${id}`, { jobTitle: "X" }, { "if-match": '"9"' })).statusCode).toBe(403);
  });

  it("two parallel edits from the same version: one wins, the other gets 412", async () => {
    const id = await submission();
    const res = await Promise.all(["A", "B"].map((t) =>
      call("l1", "PATCH", `/api/v1/submissions/${id}`, { jobTitle: `Parallel ${t}` }, { "if-match": '"1"' })));
    expect(res.map((r) => r.statusCode).sort()).toEqual([200, 412]);
    expect(await version(id)).toBe(2);
    expect(await audits("submission.edited", id)).toBe(1);
  });
});

describe("optional If-Match on PATCH /submissions/:id/status", () => {
  const move = (id: string, to: string, ifMatch?: string, key: Key = "r1a") =>
    call(key, "PATCH", `/api/v1/submissions/${id}/status`, { to }, ifMatch === undefined ? {} : { "if-match": ifMatch });

  it("matching version moves and returns the new rowVersion; stale is 412 and the status stays", async () => {
    const id = await submission();
    const ok = await move(id, "under_review", '"1"');
    expect([ok.statusCode, ok.json()]).toEqual([200, { id, status: "under_review", rejectionReason: null, rowVersion: 2 }]);
    const stale = await move(id, "interview_requested", '"1"');
    expect([stale.statusCode, stale.json().detail]).toEqual([412, "stale"]);
    expect((await call("r1a", "GET", `/api/v1/submissions/${id}`)).json().status).toBe("under_review");
    expect(await audits("submission.status", id)).toBe(1);
    // Without the header: as before.
    expect((await move(id, "interview_requested")).statusCode).toBe(200);
  });

  it("an edit in between makes a status change from the old version stale", async () => {
    const id = await submission();
    expect((await call("l1", "PATCH", `/api/v1/submissions/${id}`, { jobTitle: "Edited first" })).statusCode).toBe(200);
    expect((await move(id, "under_review", '"1"')).statusCode).toBe(412);
    expect((await move(id, "under_review", '"2"')).statusCode).toBe(200);
  });

  it("out of scope is 404 whatever the version; parallel moves from one version: one 412", async () => {
    const id = await submission();
    expect((await move(id, "under_review", '"7"', "r3a")).statusCode).toBe(404);
    const res = await Promise.all([move(id, "under_review", '"1"'), move(id, "withdrawn", '"1"')]);
    expect(res.map((r) => r.statusCode).sort()).toEqual([200, 412]);
    expect(await version(id)).toBe(2);
  });
});

describe("POST /submissions: Idempotency-Key and the serialised duplicate check", () => {
  it("same key and body: the first answer, one submission, one audit; another body: 409", async () => {
    const c = await candidate();
    const body = { candidateId: c.id, jobTitle: "Retry me", clientId: CLIENT_ID };
    const h = { "idempotency-key": `sub-${c.id}` };
    const a = await call("r1a", "POST", "/api/v1/submissions", body, h);
    const b = await call("r1a", "POST", "/api/v1/submissions", { clientId: CLIENT_ID, jobTitle: "Retry me", candidateId: c.id }, h);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(b.json()).toEqual(a.json());
    expect(a.json()).toMatchObject({ duplicateWarning: false, rowVersion: 1 });
    const n = await db.admin.query(`SELECT count(*)::int AS n FROM eureka.submission WHERE candidate_id = $1`, [c.id]);
    expect(n.rows[0].n).toBe(1);
    expect(await audits("submission.created", a.json().id)).toBe(1);
    const other = await call("r1a", "POST", "/api/v1/submissions", { ...body, jobTitle: "Other" }, h);
    expect([other.statusCode, other.json().detail]).toEqual([409, "idempotency_key_reused"]);
  });

  it("the key is optional; a malformed one is 400 invalid_idempotency_key before anything is written", async () => {
    const c = await candidate();
    const body = { candidateId: c.id, jobTitle: "Bad key", clientId: CLIENT_ID };
    const bad = await call("r1a", "POST", "/api/v1/submissions", body, { "idempotency-key": "has spaces" });
    expect([bad.statusCode, bad.json().detail]).toEqual([400, "invalid_idempotency_key"]);
    const n = await db.admin.query(`SELECT count(*)::int AS n FROM eureka.submission WHERE candidate_id = $1`, [c.id]);
    expect(n.rows[0].n).toBe(0);
  });

  it("the candidate visibility check comes before the key (404 out of scope)", async () => {
    const c = await candidate();
    const body = { candidateId: c.id, jobTitle: "Scoped", clientId: CLIENT_ID };
    const h = { "idempotency-key": `scoped-${c.id}` };
    expect((await call("r1a", "POST", "/api/v1/submissions", body, h)).statusCode).toBe(201);
    expect((await call("r3a", "POST", "/api/v1/submissions", body, h)).statusCode).toBe(404);
  });

  it("parallel creates with one key: one submission", async () => {
    const c = await candidate();
    const body = { candidateId: c.id, jobTitle: "Double click", clientId: CLIENT_ID };
    const h = { "idempotency-key": `dbl-${c.id}` };
    const res = await Promise.all([1, 2, 3].map(() => call("r1a", "POST", "/api/v1/submissions", body, h)));
    expect(res.map((r) => r.statusCode)).toEqual([201, 201, 201]);
    expect(new Set(res.map((r) => r.json().id)).size).toBe(1);
    const n = await db.admin.query(`SELECT count(*)::int AS n FROM eureka.submission WHERE candidate_id = $1`, [c.id]);
    expect(n.rows[0].n).toBe(1);
  });

  it("parallel creates of the same pair without a key: every one after the first carries the duplicate warning", async () => {
    const c = await candidate();
    const res = await Promise.all(["r1a", "l1", "r1a", "l1"].map((k) =>
      call(k as Key, "POST", "/api/v1/submissions", { candidateId: c.id, jobTitle: "Race", clientId: CLIENT_ID })));
    expect(res.map((r) => r.statusCode)).toEqual([201, 201, 201, 201]);
    expect(res.map((r) => r.json().duplicateWarning).sort()).toEqual([false, true, true, true]);
  });
});
