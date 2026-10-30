import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { can, type Permission } from "@eureka/shared";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { CLIENT_ID, LOC, T, U, seedFixtures, toUserAccess } from "./fixtures.js";
import { createPlacement, extraUser, newCandidate, selectedSubmission, transitionPlacement } from "./placement-seed.js";

/**
 * API contract of docs/pipeline-vendors-api.md: candidate pipeline report
 * (PV-1, PV-2), assessments (PV-3, PV-4), "not responding" flags (PV-5, PV-6)
 * and preferred vendors (PV-9..PV-12).
 */
let db: TestDb;
let app: NestFastifyApplication;
const ZERO = "00000000-0000-4000-8000-000000000000";
let TECH = "";

/** Superuser write with triggers off (test setup only). */
async function force(sql: string, params: unknown[]) {
  const c = await db.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query(sql, params);
    await c.query("COMMIT");
  } finally { c.release(); }
}

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  await extraUser(db, "bu", "bu_head");
  TECH = (await db.admin.query<{ id: string }>(`INSERT INTO eureka.technology (name) VALUES ('Pipeline Tech') RETURNING id`)).rows[0]!.id;
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: "test-secret-test-secret-test-secret-123",
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

type Key = keyof typeof U | "bu";
type Session = { cookie: string; csrf: string };
const sessions = new Map<string, Session>();
async function login(key: Key): Promise<Session> {
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
type Method = "GET" | "POST" | "PATCH" | "DELETE";
async function call(key: Key, method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const s = await login(key);
  return app.inject({
    method, url, payload: payload as never,
    headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}), ...headers },
  });
}

const fixtureKeys = Object.keys(U) as (keyof typeof U)[];

describe("authorization matrix (route permission)", () => {
  const endpoints: { name: string; perm: Permission; method: Method; url: string; body?: unknown }[] = [
    { name: "GET pipeline", perm: "report:read", method: "GET", url: "/api/v1/reports/pipeline" },
    { name: "GET assessments", perm: "submission:read", method: "GET", url: `/api/v1/submissions/${ZERO}/assessments` },
    { name: "POST assessment", perm: "submission:update", method: "POST", url: `/api/v1/submissions/${ZERO}/assessments`,
      body: { platform: "glider", status: "assigned", assignedOn: "2030-01-01" } },
    { name: "GET non-response", perm: "candidate:read", method: "GET", url: `/api/v1/candidates/${ZERO}/non-response` },
    { name: "POST non-response", perm: "candidate:update", method: "POST", url: `/api/v1/candidates/${ZERO}/non-response`, body: { reason: "other" } },
    { name: "POST preferred vendor", perm: "vendor.preferred:create", method: "POST", url: "/api/v1/preferred-vendors", body: {} },
  ];
  it.each(fixtureKeys.flatMap((u) => endpoints.map((e) => [u, e.name, e] as const)))("%s → %s", async (key, _n, e) => {
    const res = await call(key, e.method, e.url, e.body);
    if (can(toUserAccess(key), e.perm)) expect(res.statusCode, res.body).not.toBe(403);
    else expect(res.statusCode, res.body).toBe(403);
  });

  it("the pipeline report also needs candidate:read; the vendor list needs either vendor permission", async () => {
    expect((await call("bu", "GET", "/api/v1/reports/pipeline")).statusCode).toBe(403);
    for (const k of fixtureKeys) {
      const a = toUserAccess(k);
      const res = await call(k, "GET", "/api/v1/preferred-vendors");
      expect(res.statusCode, k).toBe(can(a, "vendor.preferred:create") || can(a, "vendor.preferred:read") ? 200 : 403);
    }
  });
});

// ---------------------------------------------------------------- pipeline report

interface Item {
  candidate: { id: string; name: string | null };
  stage: string; notResponding: boolean;
  submissions: { count: number }; interviews: { count: number; cleared: number };
  assessments: { count: number; passed: number };
  placement: { status: string; paperwork: { done: number; total: number } | null } | null;
}
interface Report { total: number; funnel: Record<string, number>; byStage: Record<string, number>; notResponding: number; items: Item[] }

const ids: Record<string, string> = {};
let subA = "";
let assessmentA = "";

describe("pipeline report (PV-1, PV-2)", () => {
  beforeAll(async () => {
    const mk = async (k: string, c: Parameters<typeof newCandidate>[1]) => {
      const cand = await newCandidate(db, c);
      await force(`UPDATE eureka.candidate SET technology_id = $2 WHERE id = $1`, [cand.id, TECH]);
      ids[k] = cand.id;
      return cand.id;
    };
    // A: t1/r1a/Dallas: marketing start, submission, cleared interview, assessment, placement in paperwork.
    const A = await mk("A", { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
    await force(`UPDATE eureka.candidate SET marketing_start_date = '2030-03-01' WHERE id = $1`, [A]);
    subA = await asUser(db.app, U.r1a, async (c) => (await c.query<{ id: string }>(
      `INSERT INTO eureka.submission (candidate_id, job_title, client_id) VALUES ($1,'Java Developer',$2) RETURNING id`, [A, CLIENT_ID])).rows[0]!.id, true);
    await force(`UPDATE eureka.submission SET submitted_at = '2030-03-02T10:00:00Z' WHERE id = $1`, [subA]);
    const iv = await asUser(db.app, U.r1a, async (c) => (await c.query<{ id: string }>(
      `INSERT INTO eureka.interview (submission_id, round, starts_at, ends_at) VALUES ($1,'L1','2035-01-01T10:00:00Z','2035-01-01T11:00:00Z') RETURNING id`,
      [subA])).rows[0]!.id, true);
    await force(`UPDATE eureka.interview SET starts_at = '2030-03-03T10:00:00Z', ends_at = '2030-03-03T11:00:00Z', call_status = 'completed',
      cleared = true, cleared_at = '2030-03-03T12:00:00Z' WHERE id = $1`, [iv]);
    const selA = await selectedSubmission(db, U.r1a, A);
    await force(`UPDATE eureka.submission SET submitted_at = '2030-03-04T10:00:00Z' WHERE id = $1`, [selA]);
    const plA = await createPlacement(db, U.r1a, selA);
    await force(`UPDATE eureka.placement SET created_at = '2030-03-10T10:00:00Z' WHERE id = $1`, [plA.id]);
    await transitionPlacement(db, U.l1, plA.id, "paperwork");
    // B: t1/r1b/Austin: one submission, before March.
    const B = await mk("B", { teamId: T.t1, recruiterId: U.r1b, locationId: LOC.austin });
    const subB = await asUser(db.app, U.r1b, async (c) => (await c.query<{ id: string }>(
      `INSERT INTO eureka.submission (candidate_id, job_title, client_id) VALUES ($1,'Java Developer',$2) RETURNING id`, [B, CLIENT_ID])).rows[0]!.id, true);
    await force(`UPDATE eureka.submission SET submitted_at = '2030-02-01T10:00:00Z' WHERE id = $1`, [subB]);
    // C: t2/r2a/Austin, in training: nothing yet.
    await mk("C", { teamId: T.t2, recruiterId: U.r2a, locationId: LOC.austin, marketingStatus: "in_training" });
    // D: t3/r3a/Dallas: joined in March.
    const D = await mk("D", { teamId: T.t3, recruiterId: U.r3a, locationId: LOC.dallas });
    const selD = await selectedSubmission(db, U.r3a, D);
    await force(`UPDATE eureka.submission SET submitted_at = '2030-01-04T10:00:00Z' WHERE id = $1`, [selD]);
    const plD = await createPlacement(db, U.r3a, selD);
    await force(`UPDATE eureka.placement SET status = 'joined', joined_at = '2030-03-20T10:00:00Z', created_at = '2030-01-10T10:00:00Z' WHERE id = $1`, [plD.id]);
    // E: t1/r1a/Dallas, active, flagged as not responding.
    const E = await mk("E", { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
    expect((await call("r1a", "POST", `/api/v1/candidates/${E}/non-response`, { reason: "no_reply_calls" })).statusCode).toBe(201);
  });

  const report = async (key: Key, query = "") => {
    const res = await call(key, "GET", `/api/v1/reports/pipeline?technologyId=${TECH}${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as Report;
  };
  const names = (r: Report) => r.items.map((i) => Object.entries(ids).find(([, v]) => v === i.candidate.id)?.[0]).sort();

  it("records an assessment through the API first", async () => {
    const r = await call("r1a", "POST", `/api/v1/submissions/${subA}/assessments`,
      { platform: "glider", status: "passed", assignedOn: "2030-03-05", completedOn: "2030-03-06", score: 81 });
    expect(r.statusCode, r.body).toBe(201);
    assessmentA = r.json().id;
    expect(r.json()).toMatchObject({ platform: "glider", status: "passed", score: 81, rowVersion: 1, candidateId: ids.A });
  });

  it("is scoped like candidate reads, narrowed to report:read", async () => {
    expect(names(await report("r1a"))).toEqual(["A", "E"]);
    expect(names(await report("l1"))).toEqual(["A", "B", "E"]);
    expect(names(await report("m1"))).toEqual(["A", "B", "C", "E"]);
    expect(names(await report("m2"))).toEqual(["D"]);
    expect(names(await report("ceo"))).toEqual(["A", "B", "C", "D", "E"]);
    expect(names(await report("hr"))).toEqual(["A", "B", "C", "D", "E"]);
    expect(names(await report("locD"))).toEqual(["A", "D", "E"]);
    expect(names(await report("locA"))).toEqual(["B", "C"]);
  });

  it("computes stages, counts and the funnel", async () => {
    const r = await report("ceo");
    const by = Object.fromEntries(r.items.map((i) => [Object.entries(ids).find(([, v]) => v === i.candidate.id)![0], i]));
    expect(by.A).toMatchObject({ stage: "paperwork", submissions: { count: 2 }, interviews: { count: 1, cleared: 1 },
      assessments: { count: 1, passed: 1 }, placement: { status: "paperwork" }, notResponding: false });
    expect(by.B).toMatchObject({ stage: "submitted", submissions: { count: 1 }, placement: null });
    expect(by.C).toMatchObject({ stage: "not_started", submissions: { count: 0 } });
    expect(by.D).toMatchObject({ stage: "joined", placement: { status: "joined" } });
    expect(by.E).toMatchObject({ stage: "marketing", notResponding: true });
    expect(by.A!.candidate.name).toMatch(/^PlCand\d+ Placed$/);
    expect(r.total).toBe(5);
    expect(r.funnel).toEqual({ marketing: 4, submitted: 3, interviewing: 1, assessment: 1, confirmed: 2, paperwork: 2, joined: 1 });
    expect(r.byStage).toEqual({ paperwork: 1, submitted: 1, not_started: 1, joined: 1, marketing: 1 });
    expect(r.notResponding).toBe(1);
  });

  it("filters by period, stage, team, recruiter, location and the not-responding flag", async () => {
    const march = await report("ceo", "&from=2030-03-01&to=2030-03-31");
    expect(names(march)).toEqual(["A", "D"]);
    const a = march.items.find((i) => i.candidate.id === ids.A)!;
    expect(a.submissions.count).toBe(2);
    expect(names(await report("ceo", "&from=2030-02-01&to=2030-02-28"))).toEqual(["B"]);
    expect(names(await report("ceo", "&stage=joined"))).toEqual(["D"]);
    expect(names(await report("ceo", `&teamId=${T.t1}`))).toEqual(["A", "B", "E"]);
    expect(names(await report("ceo", `&recruiterId=${U.r1a}`))).toEqual(["A", "E"]);
    expect(names(await report("ceo", `&locationId=${LOC.austin}`))).toEqual(["B", "C"]);
    expect(names(await report("ceo", "&notResponding=true"))).toEqual(["E"]);
    expect(names(await report("ceo", "&marketingStatus=in_training"))).toEqual(["C"]);
    const page = await report("ceo", "&limit=2&offset=0");
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(5);
  });

  it("validates the query strictly", async () => {
    for (const q of ["&from=2030-03-01", "&from=2030-03-02&to=2030-03-01", "&stage=nope", "&limit=0", "&foo=1", "&from=2029-01-01&to=2030-06-01"]) {
      expect((await call("ceo", "GET", `/api/v1/reports/pipeline?technologyId=${TECH}${q}`)).statusCode, q).toBe(422);
    }
  });
});

// ---------------------------------------------------------------- assessments

describe("assessments (PV-3, PV-4)", () => {
  it("lists with actions; read-before-write 404 / 403; If-Match", async () => {
    const list = (await call("l1", "GET", `/api/v1/submissions/${subA}/assessments`)).json();
    expect(list.items).toHaveLength(1);
    expect(list.actions).toEqual({ create: true, update: true });
    expect((await call("locD", "GET", `/api/v1/submissions/${subA}/assessments`)).json().actions).toEqual({ create: false, update: false });
    expect((await call("r2a", "GET", `/api/v1/submissions/${subA}/assessments`)).statusCode).toBe(404);
    expect((await call("l2", "POST", `/api/v1/submissions/${subA}/assessments`, { platform: "glider", status: "assigned", assignedOn: "2030-03-05" })).statusCode).toBe(404);
    const body = { platform: "hackerrank", status: "failed", assignedOn: "2030-03-05", completedOn: "2030-03-07", score: 20 };
    expect((await call("r1a", "PATCH", `/api/v1/assessments/${assessmentA}`, body)).statusCode).toBe(428);
    expect((await call("r1a", "PATCH", `/api/v1/assessments/${assessmentA}`, body, { "if-match": '"9"' })).statusCode).toBe(412);
    expect((await call("l2", "PATCH", `/api/v1/assessments/${assessmentA}`, body, { "if-match": '"1"' })).statusCode).toBe(404);
    expect((await call("r1a", "PATCH", `/api/v1/assessments/${assessmentA}`, { ...body, completedOn: null }, { "if-match": '"1"' })).statusCode).toBe(422);
    const ok = await call("r1a", "PATCH", `/api/v1/assessments/${assessmentA}`, body, { "if-match": '"1"' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ platform: "hackerrank", status: "failed", rowVersion: 2 });
    const bad = [
      { platform: "glider", status: "assigned" },
      { platform: "glider", status: "assigned", assignedOn: "2030-03-05", candidateId: ids.A },
      { platform: "glider", status: "assigned", assignedOn: "2030-03-05", score: 101 },
      { platform: "glider", status: "assigned", assignedOn: "2030-03-05", dueOn: "2030-03-01" },
    ];
    for (const b of bad) expect((await call("r1a", "POST", `/api/v1/submissions/${subA}/assessments`, b)).statusCode, JSON.stringify(b)).toBe(422);
    const audit = (await db.admin.query(`SELECT action, changes FROM eureka.audit_event WHERE entity_id = $1 ORDER BY seq`, [assessmentA])).rows;
    expect(audit.map((a) => a.action)).toEqual(["assessment.created", "assessment.updated"]);
    expect(JSON.stringify(audit)).not.toMatch(/score|PlCand/);
    // Restore the passed result for the report tests that may run later.
    await call("r1a", "PATCH", `/api/v1/assessments/${assessmentA}`,
      { platform: "glider", status: "passed", assignedOn: "2030-03-05", completedOn: "2030-03-06", score: 81 }, { "if-match": '"2"' });
  });
});

// ---------------------------------------------------------------- not responding

describe("candidate not responding (PV-5, PV-6)", () => {
  it("shows the open flag with actions to the owners; 404 / 403 for others", async () => {
    const E = ids.E!;
    const r = (await call("r1a", "GET", `/api/v1/candidates/${E}/non-response`)).json();
    expect(r.current).toMatchObject({ reason: "no_reply_calls", status: "open", flaggedBy: "r1a", candidateWarnedAt: null });
    expect(r.actions).toEqual({ flag: false, resolve: true });
    expect((await call("hr", "GET", `/api/v1/candidates/${E}/non-response`)).json().actions).toEqual({ flag: false, resolve: false });
    expect((await call("r2a", "GET", `/api/v1/candidates/${E}/non-response`)).statusCode).toBe(404);
    expect((await call("r1b", "POST", `/api/v1/candidates/${E}/non-response/resolve`, { resolution: "responded" })).statusCode).toBe(403);
    expect((await call("l2", "POST", `/api/v1/candidates/${E}/non-response/resolve`, { resolution: "responded" })).statusCode).toBe(404);
    expect((await call("l1", "POST", `/api/v1/candidates/${E}/non-response`, { reason: "other" })).statusCode).toBe(409);
    expect((await call("l1", "POST", `/api/v1/candidates/${E}/non-response`, { reason: "other", note: "x" })).statusCode).toBe(422);
    const res = await call("l1", "POST", `/api/v1/candidates/${E}/non-response/resolve`, { resolution: "responded" });
    expect(res.statusCode, res.body).toBe(201);
    const after = (await call("l1", "GET", `/api/v1/candidates/${E}/non-response`)).json();
    expect(after.current).toBeNull();
    expect(after.history).toHaveLength(1);
    expect(after.actions).toEqual({ flag: true, resolve: false });
    const audit = (await db.admin.query(`SELECT action, changes FROM eureka.audit_event WHERE entity_id = $1 AND action LIKE 'candidate.nonresponse%' ORDER BY seq`, [E])).rows;
    expect(audit.map((a) => a.action)).toEqual(["candidate.nonresponse_flagged", "candidate.nonresponse_resolved"]);
  });
});

// ---------------------------------------------------------------- preferred vendors

describe("preferred vendors (PV-9..PV-12)", () => {
  let id = "";
  it("a recruiter enters a vendor; their superiors see it, peers do not", async () => {
    const res = await call("r1a", "POST", "/api/v1/preferred-vendors", {
      vendorName: "Acme Staffing", contactName: "Jo Vendor", contactEmail: "Jo@Acme.example", contactPhone: "+14695550123",
      clients: "Northwind", notes: "Answers fast",
    });
    expect(res.statusCode, res.body).toBe(201);
    id = res.json().id;
    expect(res.json()).toMatchObject({ vendorName: "Acme Staffing", contactEmail: "jo@acme.example", owner: { id: U.r1a }, actions: { edit: true, archive: true } });
    const seen = async (k: Key) => (await call(k, "GET", "/api/v1/preferred-vendors")).json().items.map((i: { id: string }) => i.id).includes(id);
    for (const k of ["r1a", "l1", "m1", "ad", "ceo"] as const) expect(await seen(k), k).toBe(true);
    for (const k of ["r1b", "r2a", "l2", "l3", "m2"] as const) expect(await seen(k), k).toBe(false);
    const asLead = (await call("l1", "GET", `/api/v1/preferred-vendors/${id}`)).json();
    expect(asLead.actions).toEqual({ edit: false, archive: false });
    expect((await call("r1b", "GET", `/api/v1/preferred-vendors/${id}`)).statusCode).toBe(404);
    const filtered = (await call("l1", "GET", `/api/v1/preferred-vendors?ownerId=${U.r1a}&q=acme`)).json();
    expect(filtered.items.map((i: { id: string }) => i.id)).toEqual([id]);
    expect(filtered.owners).toEqual(expect.arrayContaining([{ id: U.r1a, name: "r1a" }]));
  });

  it("only the owner edits or archives (If-Match); contacts never reach the audit log", async () => {
    const body = { vendorName: "Acme Staffing LLC", contactEmail: "jo@acme.example" };
    expect((await call("l1", "PATCH", `/api/v1/preferred-vendors/${id}`, body, { "if-match": '"1"' })).statusCode).toBe(403);
    expect((await call("r2a", "PATCH", `/api/v1/preferred-vendors/${id}`, body, { "if-match": '"1"' })).statusCode).toBe(404);
    expect((await call("r1a", "PATCH", `/api/v1/preferred-vendors/${id}`, body)).statusCode).toBe(428);
    expect((await call("r1a", "PATCH", `/api/v1/preferred-vendors/${id}`, body, { "if-match": '"5"' })).statusCode).toBe(412);
    expect((await call("r1a", "PATCH", `/api/v1/preferred-vendors/${id}`, { ...body, ownerId: U.l1 }, { "if-match": '"1"' })).statusCode).toBe(422);
    const ok = await call("r1a", "PATCH", `/api/v1/preferred-vendors/${id}`, body, { "if-match": '"1"' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ vendorName: "Acme Staffing LLC", contactName: null, rowVersion: 2 });
    expect((await call("r1a", "POST", "/api/v1/preferred-vendors", { vendorName: "acme staffing llc" })).statusCode).toBe(409);
    expect((await call("r1a", "POST", "/api/v1/preferred-vendors", { vendorName: "X", contactPhone: "555" })).statusCode).toBe(422);
    expect((await call("l1", "DELETE", `/api/v1/preferred-vendors/${id}`)).statusCode).toBe(403);
    expect((await call("r1a", "DELETE", `/api/v1/preferred-vendors/${id}`)).statusCode).toBe(204);
    expect((await call("r1a", "GET", "/api/v1/preferred-vendors")).json().items).toEqual([]);
    expect((await call("l1", "GET", "/api/v1/preferred-vendors?archived=true")).json().items.map((i: { id: string }) => i.id)).toEqual([id]);
    const audit = JSON.stringify((await db.admin.query(`SELECT action, changes FROM eureka.audit_event WHERE entity_id = $1 ORDER BY seq`, [id])).rows);
    expect(audit).toContain("preferred_vendor.created");
    expect(audit).toContain("preferred_vendor.archived");
    expect(audit).not.toMatch(/acme|Jo Vendor|5550123|Northwind|Answers/i);
  });

  it("superiors add their own vendors too", async () => {
    for (const k of ["m1", "ad", "ceo"] as const) {
      expect((await call(k, "GET", "/api/v1/preferred-vendors")).json().actions, k).toEqual({ create: true });
      const res = await call(k, "POST", "/api/v1/preferred-vendors", { vendorName: `Own ${k}` });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json()).toMatchObject({ owner: { id: U[k] }, actions: { edit: true, archive: true } });
    }
  });
});
