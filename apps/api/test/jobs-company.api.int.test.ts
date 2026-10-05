import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { LOC, U, seedFixtures } from "./fixtures.js";
import { portalCall, portalSignIn, type PortalSession } from "./portal-seed.js";

/**
 * Jobs and companies (docs/jobs-portal-api.md "Companies", migrations 0054,
 * 0060, 0062): job.company_id has a foreign key; the company NAME of a job
 * reaches job readers, application reviewers and the applicant portal through
 * narrow definer functions only, never another company column and never for a
 * job the caller cannot read; the picker lists id and name for HR only.
 */
let db: TestDb;
let app: NestFastifyApplication;
const SECRET = "test-secret-test-secret-test-secret-123";
const NAME = "Eureka Info Tech Test";
const STREET = "4100 Secret Street Suite 9";
const NOTES = "Landlord notes SECRETCO";
const ifMatch = (v: number) => ({ "if-match": `"${v}"` });

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
  return app.inject({ method, url, payload: payload as never,
    headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}), ...headers } });
}

const internal = (over: Record<string, unknown> = {}) => ({
  kind: "internal_opening", title: "HR Generalist", category: "hr", experienceLevel: "mid", employmentType: "full_time",
  workMode: "on_site", status: "open", publishedToPortal: true, ...over,
});

let companyId: string, jobId: string, draftId: string, otherCompanyId: string, appId: string, reqId: string;
let A: PortalSession, B: PortalSession;

beforeAll(async () => {
  const mk = async (name: string, extra: Record<string, unknown>) => {
    const r = await call("locD", "POST", "/api/v1/companies", { locationId: LOC.dallas, name, ...extra });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  };
  companyId = await mk(NAME, { street: STREET, city: "Dallas", state: "TX", zip: "75201", notes: NOTES });
  otherCompanyId = await mk("Austin Only Co", {});
  const mkJob = async (body: unknown) => {
    const r = await call("hr", "POST", "/api/v1/jobs", body);
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  };
  // l2 (a Sales lead) is the hiring manager: readable through that path only.
  jobId = await mkJob(internal({ companyId, hiringManagerId: U.l2 }));
  draftId = await mkJob(internal({ title: "Draft", status: "draft", publishedToPortal: false, companyId }));
  const clientId = (await db.admin.query<{ id: string }>(`INSERT INTO eureka.client (name) VALUES ('Co Client') RETURNING id`)).rows[0]!.id;
  reqId = (await call("l1", "POST", "/api/v1/jobs", { kind: "client_requirement", title: "Java", category: "engineering",
    experienceLevel: "mid", employmentType: "contract", workMode: "remote", status: "open", clientId })).json().id;
  A = await portalSignIn(app, "co-a@example.com", "Asha", "Iyer");
  B = await portalSignIn(app, "co-b@example.com", "Bala", "Raman");
  appId = (await portalCall(app, A, "POST", `/api/portal/jobs/${jobId}/apply`)).json().id;
}, 60_000);

const staffNames = (u: string, jobs: string[]) => asUser(db.app, u, async (c) =>
  (await c.query(`SELECT job_id, name FROM authz.job_company_names($1::uuid[])`, [jobs])).rows);

async function asPortal<T>(applicant: string | null, fn: (c: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const c = await db.app.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE eureka_portal");
    if (applicant) await c.query("SELECT set_config('eureka.applicant_id', $1, true)", [applicant]);
    return await fn(c);
  } finally { await c.query("ROLLBACK").catch(() => undefined); c.release(); }
}

describe("foreign key", () => {
  it("rejects an unknown company with invalid_company (422) on create and update", async () => {
    const bad = "00000000-0000-0000-0000-0000000f0f0f";
    const r = await call("hr", "POST", "/api/v1/jobs", internal({ companyId: bad }));
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json().detail).toBe("invalid_company");
    const cur = (await call("hr", "GET", `/api/v1/jobs/${jobId}`)).json();
    const u = await call("hr", "PATCH", `/api/v1/jobs/${jobId}`, { companyId: bad }, ifMatch(cur.rowVersion));
    expect(u.statusCode, u.body).toBe(422);
  });

  it("is ON DELETE RESTRICT", async () => {
    const r = await db.admin.query(`SELECT confdeltype FROM pg_constraint WHERE conname = 'job_company_id_fkey'`);
    expect(r.rows[0].confdeltype).toBe("r");
  });
});

describe("company name for job readers", () => {
  it("HR sees the name in the list, the job and the application; the company object is id and name only", async () => {
    const list = (await call("hr", "GET", "/api/v1/jobs?kind=internal_opening")).json().items as { id: string; company: unknown }[];
    expect(list.find((j) => j.id === jobId)!.company).toEqual({ id: companyId, name: NAME });
    expect((await call("hr", "GET", `/api/v1/jobs/${jobId}`)).json().company).toEqual({ id: companyId, name: NAME });
    const a = (await call("hr", "GET", `/api/v1/applications/${appId}`)).json();
    expect(a.company).toEqual({ id: companyId, name: NAME });
    expect(a.job.company).toEqual({ id: companyId, name: NAME });
    expect((await call("hr", "GET", "/api/v1/applications")).json().items[0].company).toEqual({ id: companyId, name: NAME });
  });

  it("the hiring manager (a Sales lead with no company right) sees the name of their job, not the company", async () => {
    expect((await call("l2", "GET", `/api/v1/jobs/${jobId}`)).json().company).toEqual({ id: companyId, name: NAME });
    expect((await call("l2", "GET", `/api/v1/applications/${appId}`)).json().company).toEqual({ id: companyId, name: NAME });
    expect((await call("l2", "GET", `/api/v1/companies/${companyId}`)).statusCode).toBeGreaterThanOrEqual(403);
  });

  it("an interview reviewer sees the name through the reviewed application", async () => {
    const r = await call("hr", "POST", `/api/v1/applications/${appId}/interviews`, { interviewType: "video", round: "screening",
      leadUserId: U.coach, panelUserIds: [U.r2a], startsAt: new Date(Date.now() + 86_400_000).toISOString(), durationMinutes: 30,
      meetingLink: "https://meet.example.com/x" });
    expect(r.statusCode, r.body).toBe(201);
    for (const k of ["r2a", "coach"] as const) {
      expect((await call(k, "GET", `/api/v1/applications/${appId}`)).json().company, k).toEqual({ id: companyId, name: NAME });
    }
  });

  it("someone who cannot read the job learns neither the job nor the name", async () => {
    for (const k of ["l1", "r1a", "m1", "locD", "acct"] as const) {
      expect((await call(k, "GET", `/api/v1/jobs/${jobId}`)).statusCode, k).toBe(404);
      expect(JSON.stringify((await call(k, "GET", "/api/v1/jobs")).json()), k).not.toContain(NAME);
      expect((await call(k, "GET", `/api/v1/applications/${appId}`)).statusCode, k).toBe(404);
    }
    // Directly against the database function: absent rows, whatever ids are asked for.
    for (const u of [U.l1, U.r1a, U.m1, U.locD, U.acct]) expect(await staffNames(u, [jobId, draftId, reqId]), u).toEqual([]);
    expect((await staffNames(U.hr, [jobId, draftId, reqId])).map((r) => r.job_id).sort()).toEqual([jobId, draftId].sort());
    expect(await staffNames(U.l2, [jobId, draftId, reqId])).toEqual([{ job_id: jobId, name: NAME }]);
    expect(await staffNames(U.hr, [])).toEqual([]);
  });

  it("no other company column is reachable by job readers, reviewers or the portal", async () => {
    for (const u of [U.hr, U.l2, U.r2a, U.coach]) {
      expect(await asUser(db.app, u, async (c) => (await c.query(`SELECT * FROM eureka.company`)).rows), u).toEqual([]);
    }
    const fn = await db.admin.query(`SELECT proname, proargnames FROM pg_proc
      WHERE pronamespace = 'authz'::regnamespace AND proname IN ('job_company_names', 'portal_job_company_names', 'company_options')
      ORDER BY proname`);
    expect(fn.rows.map((r) => [r.proname, r.proargnames])).toEqual([
      ["company_options", ["id", "name"]],
      ["job_company_names", ["p_jobs", "job_id", "name"]],
      ["portal_job_company_names", ["p_jobs", "job_id", "name"]],
    ]);
    const all = JSON.stringify([
      (await call("hr", "GET", `/api/v1/jobs/${jobId}`)).json(), (await call("hr", "GET", `/api/v1/applications/${appId}`)).json(),
      (await call("hr", "GET", "/api/v1/jobs/company-options")).json(), (await portalCall(app, A, "GET", `/api/portal/jobs/${jobId}`)).json(),
      (await portalCall(app, A, "GET", `/api/portal/applications/${appId}`)).json(),
    ]);
    for (const secret of [STREET, NOTES, "75201"]) expect(all).not.toContain(secret);
  });

  it("the portal function is not executable by the staff role, nor the staff ones by the portal role", async () => {
    await expect(asUser(db.app, U.hr, (c) => c.query(`SELECT * FROM authz.portal_job_company_names('{${jobId}}')`))).rejects.toMatchObject({ code: "42501" });
    for (const sql of [`SELECT * FROM authz.job_company_names('{${jobId}}')`, `SELECT * FROM authz.company_options()`, `SELECT name FROM eureka.company`]) {
      await expect(asPortal(A.id, (c) => c.query(sql)), sql).rejects.toMatchObject({ code: "42501" });
    }
  });
});

describe("portal", () => {
  it("shows the employer name of published open internal openings only", async () => {
    const list = (await portalCall(app, A, "GET", "/api/portal/jobs")).json().items as { id: string; employer: string | null }[];
    expect(list.map((j) => [j.id, j.employer])).toEqual([[jobId, NAME]]);
    expect((await portalCall(app, A, "GET", `/api/portal/jobs/${jobId}`)).json().employer).toBe(NAME);
    for (const id of [draftId, reqId]) expect((await portalCall(app, A, "GET", `/api/portal/jobs/${id}`)).statusCode).toBe(404);
    expect((await portalCall(app, A, "GET", `/api/portal/applications/${appId}`)).json().job.employer).toBe(NAME);
    expect((await portalCall(app, A, "GET", "/api/portal/applications")).json().items[0].job.employer).toBe(NAME);
  });

  it("the function returns nothing for drafts and client jobs, nor for closed jobs unless the applicant applied", async () => {
    const q = (id: string | null, jobs: string[]) => asPortal(id, async (c) =>
      (await c.query(`SELECT job_id, name FROM authz.portal_job_company_names($1::uuid[])`, [jobs])).rows);
    expect(await q(A.id, [jobId, draftId, reqId])).toEqual([{ job_id: jobId, name: NAME }]);
    expect(await q(B.id, [draftId, reqId])).toEqual([]);
    const cur = (await call("hr", "GET", `/api/v1/jobs/${jobId}`)).json();
    expect((await call("hr", "PATCH", `/api/v1/jobs/${jobId}`, { status: "closed" }, ifMatch(cur.rowVersion))).statusCode).toBe(200);
    expect(await q(B.id, [jobId])).toEqual([]);
    expect(await q(A.id, [jobId])).toEqual([{ job_id: jobId, name: NAME }]);
    expect((await portalCall(app, A, "GET", `/api/portal/applications/${appId}`)).json().job.employer).toBe(NAME);
    expect(await q(null, [jobId])).toEqual([]);
  });
});

describe("company options (GET /api/v1/jobs/company-options)", () => {
  it("HR gets id and name of every active company, whatever its location", async () => {
    const r = await call("hr", "GET", "/api/v1/jobs/company-options");
    expect(r.statusCode).toBe(200);
    const items = r.json().companies as Record<string, unknown>[];
    expect(items.map((c) => c.name)).toEqual(["Austin Only Co", NAME]);
    for (const c of items) expect(Object.keys(c).sort()).toEqual(["id", "name"]);
    expect(items[0]!.id).toBe(otherCompanyId);
    expect((await call("hr", "GET", `/api/v1/companies/${companyId}`)).statusCode).toBeGreaterThanOrEqual(403);
  });

  it("is for job managers who may create internal openings only", async () => {
    for (const k of ["l1", "m1", "r1a", "locD", "acct", "coach"] as const) {
      expect((await call(k, "GET", "/api/v1/jobs/company-options")).statusCode, k).toBe(403);
    }
    expect((await app.inject({ method: "GET", url: "/api/v1/jobs/company-options" })).statusCode).toBe(401);
    const opts = (u: string) => asUser(db.app, u, async (c) => (await c.query(`SELECT * FROM authz.company_options()`)).rows);
    for (const u of [U.l1, U.m1, U.locD, U.ceo, U.r1a]) expect(await opts(u), u).toEqual([]);
    expect(await opts(U.hr)).toHaveLength(2);
  });

  it("an inactive company is not offered, and its name still shows on its jobs", async () => {
    const cur = (await call("locD", "GET", `/api/v1/companies/${companyId}`)).json();
    const r = await call("locD", "PATCH", `/api/v1/companies/${companyId}`, { status: "inactive" }, ifMatch(cur.rowVersion));
    expect(r.statusCode, r.body).toBe(200);
    const items = (await call("hr", "GET", "/api/v1/jobs/company-options")).json().companies as { name: string }[];
    expect(items.map((c) => c.name)).toEqual(["Austin Only Co"]);
    expect((await call("hr", "GET", `/api/v1/jobs/${draftId}`)).json().company.name).toBe(NAME);
  });
});
