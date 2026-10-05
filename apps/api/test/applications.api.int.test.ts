import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { CLIENT_ID, LOC, TECH_ID, T, U, seedFixtures } from "./fixtures.js";
import { deliverInbox } from "./notification-seed.js";
import { mailboxOf, portalCall, portalSignIn, type PortalSession } from "./portal-seed.js";

/** Applications, interviews, scorecards and the portal side (docs/jobs-portal-api.md JP-17..JP-30, migration 0062). */
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
  const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
  const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
  const s = { cookie, csrf: me.json().csrfToken as string };
  sessions.set(key, s);
  return s;
}
async function call(key: Key, method: "GET" | "POST" | "PUT", url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const s = await login(key);
  return app.inject({ method, url, payload: payload as never,
    headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}), ...headers } });
}
const job = async (over: Record<string, unknown>) => {
  const r = await call("hr", "POST", "/api/v1/jobs", { kind: "internal_opening", title: "Sales Development Representative", category: "sales",
    experienceLevel: "entry", employmentType: "full_time", workMode: "on_site", status: "open", publishedToPortal: true, location: "Austin, TX",
    description: { blocks: [{ type: "p", runs: [{ text: "Qualify inbound leads and book meetings." }] }] }, ...over });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
};

let jobId: string, draftId: string, reqId: string;
let A: PortalSession, B: PortalSession;
let appId: string;

beforeAll(async () => {
  jobId = await job({ hiringManagerId: U.l2 });
  draftId = await job({ title: "Draft opening", status: "draft" });
  const r = await call("l1", "POST", "/api/v1/jobs", { kind: "client_requirement", title: "Java", category: "engineering",
    experienceLevel: "mid", employmentType: "contract", workMode: "remote", status: "open", clientId: CLIENT_ID });
  reqId = r.json().id;
  A = await portalSignIn(app, "applicant-a@example.com", "Asha", "Iyer");
  B = await portalSignIn(app, "applicant-b@example.com", "Bala", "Raman");
});

describe("portal: jobs and applying (JP-22..JP-25)", () => {
  it("lists only published open internal openings, newest first, with a short description", async () => {
    const r = await portalCall(app, A, "GET", "/api/portal/jobs");
    expect(r.statusCode).toBe(200);
    const items = r.json().items as { id: string; excerpt: string; applied: boolean }[];
    expect(items.map((i) => i.id)).toEqual([jobId]);
    expect(items[0]).toMatchObject({ excerpt: "Qualify inbound leads and book meetings.", applied: false });
    for (const id of [draftId, reqId]) expect((await portalCall(app, A, "GET", `/api/portal/jobs/${id}`)).statusCode).toBe(404);
    const detail = (await portalCall(app, A, "GET", `/api/portal/jobs/${jobId}`)).json();
    expect(Object.keys(detail)).not.toEqual(expect.arrayContaining(["hiringManager"]));
    expect(detail).not.toHaveProperty("hiringManager");
    expect(detail).not.toHaveProperty("owner");
  });

  it("applies once; refuses unpublished jobs and client requirements", async () => {
    const r = await portalCall(app, A, "POST", `/api/portal/jobs/${jobId}/apply`);
    expect(r.statusCode, r.body).toBe(201);
    appId = r.json().id;
    expect((await portalCall(app, A, "POST", `/api/portal/jobs/${jobId}/apply`)).json().detail).toBe("already_applied");
    expect((await portalCall(app, A, "POST", `/api/portal/jobs/${draftId}/apply`)).statusCode).toBe(404);
    expect((await portalCall(app, A, "POST", `/api/portal/jobs/${reqId}/apply`)).statusCode).toBe(404);
    expect((await portalCall(app, A, "GET", "/api/portal/jobs")).json().items[0]).toMatchObject({ applied: true, applicationId: appId });
    expect((await app.inject({ method: "POST", url: `/api/portal/jobs/${jobId}/apply`, headers: { cookie: A.cookie } })).statusCode).toBe(403);
  });

  it("notifies the hiring manager and HR in the inbox (ids only)", async () => {
    const ev = (await db.admin.query(`SELECT id, payload FROM eureka.outbox_event WHERE type = 'application.received'`)).rows[0];
    expect(ev.payload).toEqual({ applicationId: appId, jobId });
    await deliverInbox(db, ev.id);
    const rows = (await db.admin.query(`SELECT recipient_id, entity_type, entity_id, title FROM eureka.notification WHERE event_id = $1 ORDER BY recipient_id`, [ev.id])).rows;
    expect(rows.map((r) => r.recipient_id).sort()).toEqual([U.l2, U.hr].sort());
    expect(rows[0]).toMatchObject({ entity_type: "application", entity_id: appId, title: "New application" });
  });

  it("another applicant sees nothing of it", async () => {
    expect((await portalCall(app, B, "GET", `/api/portal/applications/${appId}`)).statusCode).toBe(404);
    expect((await portalCall(app, B, "GET", "/api/portal/applications")).json().items).toEqual([]);
    expect((await portalCall(app, B, "POST", `/api/portal/applications/${appId}/withdraw`)).statusCode).toBe(404);
  });
});

describe("staff: reading applications (JP-17..JP-19)", () => {
  it("HR and the hiring manager see it; other staff do not", async () => {
    for (const k of ["hr", "l2"] as const) {
      const l = await call(k, "GET", "/api/v1/applications");
      expect(l.json().items.map((i: { id: string }) => i.id), k).toEqual([appId]);
      expect((await call(k, "GET", `/api/v1/applications/${appId}`)).statusCode, k).toBe(200);
    }
    for (const k of ["l1", "r1a", "ceo", "coach", "admin"] as const) {
      expect((await call(k, "GET", "/api/v1/applications")).json().items, k).toEqual([]);
      expect((await call(k, "GET", `/api/v1/applications/${appId}`)).statusCode, k).toBe(404);
    }
  });

  it("phones need applicant.phone:read; the job travels with the application", async () => {
    const hr = (await call("hr", "GET", `/api/v1/applications/${appId}`)).json();
    expect(hr.applicant).toMatchObject({ name: "Asha Iyer", email: "applicant-a@example.com", phone: "+12125550123", phoneMasked: false, emailVerified: true });
    expect(hr.job).toMatchObject({ id: jobId, title: "Sales Development Representative", kind: "internal_opening" });
    const hm = (await call("l2", "GET", `/api/v1/applications/${appId}`)).json();
    expect(hm.applicant).toMatchObject({ phoneMasked: true, email: "a•••@example.com" });
    expect(hr.applicant.email).toBe("applicant-a@example.com");
    expect(hm.applicant.phone).not.toBe("+12125550123");
    expect(hm.actions.transition).toContain("shortlisted");
  });

  it("applicants list and exports are HR's", async () => {
    const l = await call("hr", "GET", "/api/v1/applicants?search=asha");
    expect(l.statusCode).toBe(200);
    expect(l.json().items).toEqual([expect.objectContaining({ name: "Asha Iyer", email: "applicant-a@example.com", phone: "+12125550123", emailVerified: true, applications: 1 })]);
    expect((await call("l2", "GET", "/api/v1/applicants")).statusCode).toBe(403);
    const ex = await call("hr", "POST", "/api/v1/applications/export", {});
    expect(ex.statusCode).toBe(200);
    expect(ex.headers["content-type"]).toContain("text/csv");
    expect(ex.body).toContain("Sales Development Representative,Asha Iyer,applicant-a@example.com");
    expect((await call("l2", "POST", "/api/v1/applications/export", {})).statusCode).toBe(403);
    expect((await call("hr", "POST", "/api/v1/applicants/export", {})).body).toContain("Asha Iyer");
  });
});

describe("status changes, interviews and scorecards (JP-20, JP-27..JP-29)", () => {
  let interviewId: string;

  it("status change needs If-Match, follows the state machine, emails the applicant without the comment", async () => {
    const v = (await call("hr", "GET", `/api/v1/applications/${appId}`)).json().rowVersion as number;
    expect((await call("hr", "POST", `/api/v1/applications/${appId}/status`, { to: "shortlisted" })).statusCode).toBe(428);
    expect((await call("hr", "POST", `/api/v1/applications/${appId}/status`, { to: "shortlisted" }, { "if-match": `"${v + 5}"` })).statusCode).toBe(412);
    expect((await call("hr", "POST", `/api/v1/applications/${appId}/status`, { to: "withdrawn" }, { "if-match": `"${v}"` })).statusCode).toBe(422);
    const ok = await call("hr", "POST", `/api/v1/applications/${appId}/status`, { to: "shortlisted", comment: "Strong CRM background SECRETNOTE" }, { "if-match": `"${v}"` });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ id: appId, status: "shortlisted", rowVersion: v + 1 });
    expect((await call("r1a", "POST", `/api/v1/applications/${appId}/status`, { to: "rejected" }, { "if-match": `"${v + 1}"` })).statusCode).toBe(404);
    const mail = (await mailboxOf(app, "applicant-a@example.com"))[0]!;
    expect(mail.subject).toBe("Your application for Sales Development Representative: Shortlisted");
    expect(mail.text).not.toContain("SECRETNOTE");
    const history = (await call("hr", "GET", `/api/v1/applications/${appId}`)).json().history;
    expect(history[0]).toMatchObject({ kind: "status", fromStatus: "applied", toStatus: "shortlisted", comment: "Strong CRM background SECRETNOTE" });
  });

  it("the hiring manager schedules an interview (https only); the application moves to interview_scheduled", async () => {
    const body = { interviewType: "video", round: "screening", leadUserId: U.coach, panelUserIds: [U.r2a],
      startsAt: new Date(Date.now() + 86_400_000).toISOString(), durationMinutes: 30, meetingLink: "http://meet.example.com/x" };
    expect((await call("l2", "POST", `/api/v1/applications/${appId}/interviews`, body)).statusCode).toBe(422);
    expect((await call("l1", "POST", `/api/v1/applications/${appId}/interviews`, { ...body, meetingLink: "https://meet.example.com/x" })).statusCode).toBe(404);
    const r = await call("l2", "POST", `/api/v1/applications/${appId}/interviews`, { ...body, meetingLink: "https://meet.example.com/x" });
    expect(r.statusCode, r.body).toBe(201);
    interviewId = r.json().id;
    expect(r.json().applicationStatus).toBe("interview_scheduled");
    const mail = (await mailboxOf(app, "applicant-a@example.com"))[0]!;
    expect(mail.subject).toBe("Interview scheduled: Sales Development Representative");
    expect(mail.text).toContain("https://meet.example.com/x");
    expect(mail.text).not.toMatch(/coach|r2a/);
  });

  it("the lead and panel can read the application and review; others cannot", async () => {
    expect((await call("r2a", "GET", `/api/v1/applications/${appId}`)).statusCode).toBe(200);
    const card = { technical: 4, communication: 5, problemSolving: 4, attitude: 5, notes: "Clear and structured" };
    expect((await call("r1b", "PUT", `/api/v1/application-interviews/${interviewId}/scorecard`, card)).statusCode).toBe(404);
    // A review waits for the interview: it is still ahead.
    const early = await call("r2a", "PUT", `/api/v1/application-interviews/${interviewId}/scorecard`, card);
    expect(early.statusCode).toBe(422);
    expect(early.json().detail).toBe("interview_not_started");
    expect((await call("l2", "POST", `/api/v1/application-interviews/${interviewId}/status`, { status: "completed" })).statusCode).toBe(200);
    expect((await call("r2a", "PUT", `/api/v1/application-interviews/${interviewId}/scorecard`, card)).statusCode).toBe(200);
    expect((await call("coach", "PUT", `/api/v1/application-interviews/${interviewId}/scorecard`, { ...card, communication: 3, notes: undefined })).statusCode).toBe(200);
    expect((await call("r2a", "PUT", `/api/v1/application-interviews/${interviewId}/scorecard`, { ...card, technical: 6 })).statusCode).toBe(422);
    // The panel member cannot change the application or the interview.
    expect((await call("r2a", "POST", `/api/v1/application-interviews/${interviewId}/status`, { status: "completed" })).statusCode).toBe(403);
    const d = (await call("hr", "GET", `/api/v1/applications/${appId}`)).json();
    expect(d.overallRating).toBe(4.3);
    expect(d.interviews[0].scorecards).toHaveLength(2);
    expect(d.interviews[0]).toMatchObject({ lead: { id: U.coach }, panel: [{ id: U.r2a, name: "r2a" }], meetingLink: "https://meet.example.com/x" });
    expect(d.history.some((h: { kind: string }) => h.kind === "interview_status")).toBe(true);
  });

  it("the applicant sees the interview's type, round, slot and status only", async () => {
    const d = (await portalCall(app, A, "GET", `/api/portal/applications/${appId}`)).json();
    expect(d.status).toBe("interview_scheduled");
    expect(d.interviews).toHaveLength(1);
    expect(Object.keys(d.interviews[0]).sort()).toEqual(["durationMinutes", "id", "interviewType", "meetingLink", "round", "startsAt", "status"]);
    expect(JSON.stringify(d)).not.toMatch(/Clear and structured|SECRETNOTE|overallRating|scorecard/);
  });
});

describe("interviewer access ends with the people, the interview and the application", () => {
  const people = (k: Key, id: string, body: unknown) => call(k, "PUT", `/api/v1/application-interviews/${id}/people`, body);
  it("the manager removes a panelist and changes the lead; the audit names ids only", async () => {
    const r = await call("l2", "POST", `/api/v1/applications/${appId}/interviews`, { interviewType: "phone", round: "hr", leadUserId: U.coach,
      panelUserIds: [U.r3a], startsAt: new Date(Date.now() + 2 * 86_400_000).toISOString(), durationMinutes: 30 });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().id as string;
    expect((await call("r3a", "GET", `/api/v1/applications/${appId}`)).statusCode).toBe(200);
    expect((await people("r3a", id, { leadUserId: U.coach, panelUserIds: [] })).statusCode).toBe(403);
    expect((await people("l1", id, { leadUserId: U.coach, panelUserIds: [] })).statusCode).toBe(404);
    expect((await people("l2", id, { leadUserId: "00000000-0000-0000-0000-0000000fffff", panelUserIds: [] })).json().detail).toBe("invalid_interviewer");
    expect((await people("l2", id, { leadUserId: U.r1b, panelUserIds: [] })).statusCode).toBe(200);
    // r3a lost the application at once; the new lead gained it.
    expect((await call("r3a", "GET", `/api/v1/applications/${appId}`)).statusCode).toBe(404);
    expect((await call("r3a", "GET", "/api/v1/applications")).json().items).toEqual([]);
    expect((await call("r1b", "GET", `/api/v1/applications/${appId}`)).statusCode).toBe(200);
    const au = (await db.admin.query(`SELECT changes FROM eureka.audit_event WHERE action IN ('application.interview_people','application.interview_scheduled') AND entity_id = $1 ORDER BY seq`, [id])).rows;
    expect(au[0].changes).toMatchObject({ leadUserId: U.coach, panelUserIds: [U.r3a] });
    expect(au[1].changes).toMatchObject({ leadFrom: U.coach, leadTo: U.r1b, added: [], removed: [U.r3a] });
    // A cancelled interview ends its reviewers' access too.
    expect((await call("l2", "POST", `/api/v1/application-interviews/${id}/status`, { status: "cancelled" })).statusCode).toBe(200);
    expect((await call("r1b", "GET", `/api/v1/applications/${appId}`)).statusCode).toBe(404);
    expect((await people("l2", id, { leadUserId: U.r1b, panelUserIds: [] })).json().detail).toBe("invalid_transition");
  });
});

describe("withdraw, hire and create candidate (JP-26, JP-30)", () => {
  it("the applicant withdraws an open application, once", async () => {
    const r = await portalCall(app, B, "POST", `/api/portal/jobs/${jobId}/apply`);
    const id = r.json().id;
    const w = await portalCall(app, B, "POST", `/api/portal/applications/${id}/withdraw`);
    expect(w.statusCode).toBe(200);
    expect(w.json().status).toBe("withdrawn");
    expect((await portalCall(app, B, "POST", `/api/portal/applications/${id}/withdraw`)).json().detail).toBe("invalid_transition");
  });

  it("hired applicants become candidates through the candidate service (candidate:create), once", async () => {
    let v = (await call("hr", "GET", `/api/v1/applications/${appId}`)).json().rowVersion as number;
    for (const to of ["offered", "hired"]) {
      const r = await call("hr", "POST", `/api/v1/applications/${appId}/status`, { to }, { "if-match": `"${v}"` });
      expect(r.statusCode, r.body).toBe(200);
      v = r.json().rowVersion;
    }
    // Hired: the finished application no longer opens to its interviewers.
    expect((await call("r2a", "GET", `/api/v1/applications/${appId}`)).statusCode).toBe(404);
    const body = { technologyId: TECH_ID, locationId: LOC.dallas };
    // The link function itself refuses an existing candidate and a caller without candidate:create.
    const existing = (await db.admin.query(`SELECT id FROM eureka.candidate WHERE team_id = $1 LIMIT 1`, [T.t2])).rows[0].id as string;
    await expect(asUser(db.app, U.l2, (c) => c.query(`SELECT authz.application_link_candidate($1, $2)`, [appId, existing])))
      .rejects.toThrow(/candidate_not_found/);
    await expect(asUser(db.app, U.hr, (c) => c.query(`SELECT authz.application_link_candidate($1, $2)`, [appId, existing])))
      .rejects.toThrow(/not_permitted/);
    expect((await call("hr", "POST", `/api/v1/applications/${appId}/candidate`, body)).statusCode).toBe(403);
    expect((await call("l1", "POST", `/api/v1/applications/${appId}/candidate`, body)).statusCode).toBe(404);
    const c = await call("l2", "POST", `/api/v1/applications/${appId}/candidate`, body);
    expect(c.statusCode, c.body).toBe(201);
    const cand = (await call("l2", "GET", `/api/v1/candidates/${c.json().candidateId}`)).json();
    expect(cand).toMatchObject({ name: "Asha Iyer", team: { id: T.t2 } });
    // l2 may not read applicant phones: the candidate was created without one.
    expect((await db.admin.query(`SELECT p.phone_e164, p.personal_email FROM eureka.candidate c JOIN eureka.person p ON p.id = c.person_id WHERE c.id = $1`, [c.json().candidateId])).rows[0])
      .toEqual({ phone_e164: null, personal_email: "applicant-a@example.com" });
    expect((await call("l2", "GET", `/api/v1/applications/${appId}`)).json().candidateId).toBe(c.json().candidateId);
    expect((await call("l2", "POST", `/api/v1/applications/${appId}/candidate`, body)).json().detail).toBe("candidate_exists");
  });
});

describe("audit, outbox and RLS (direct SQL)", () => {
  it("audit and outbox rows carry ids and codes only", async () => {
    const text = JSON.stringify((await db.admin.query(`SELECT action, changes FROM eureka.audit_event WHERE entity_type IN
      ('job_application','application_interview','application_scorecard','applicant')`)).rows)
      + JSON.stringify((await db.admin.query(`SELECT payload FROM eureka.outbox_event WHERE type LIKE 'application.%'`)).rows);
    expect(text).not.toMatch(/@example\.com|Asha|Iyer|SECRETNOTE|Clear and structured|meet\.example|\+1212/);
  });

  const asPortal = async (id: string, sql: string) => {
    const c = await db.app.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE eureka_portal");
      await c.query("SELECT set_config('eureka.applicant_id', $1, true)", [id]);
      return await c.query(sql);
    } finally { await c.query("ROLLBACK").catch(() => undefined); c.release(); }
  };

  it("the portal role reads its own rows and no internal data", async () => {
    expect((await asPortal(A.id, `SELECT id FROM eureka.job_application`)).rows.map((r) => r.id)).toEqual([appId]);
    expect((await asPortal(B.id, `SELECT id FROM eureka.application_interview`)).rowCount).toBe(0);
    for (const sql of [`SELECT 1 FROM eureka.application_scorecard`, `SELECT 1 FROM eureka.application_event`,
      `SELECT 1 FROM eureka.application_interview_panel`, `SELECT lead_user_id FROM eureka.application_interview`,
      `SELECT candidate_id FROM eureka.job_application`, `SELECT hiring_manager_id FROM eureka.job`, `SELECT owner_id FROM eureka.job`]) {
      await expect(asPortal(A.id, sql), sql).rejects.toMatchObject({ code: "42501" });
    }
    await expect(asPortal(A.id, `SELECT authz.application_transition('${appId}', 'hired', null, 1)`)).rejects.toMatchObject({ code: "42501" });
    await expect(asPortal(A.id, `INSERT INTO eureka.audit_event (actor_id, action, entity_type) VALUES ('${B.id}', 'forged', 'applicant')`))
      .rejects.toMatchObject({ code: "42501" });
  });

  it("staff policies: HR all, hiring manager and reviewers theirs, others none; no direct writes", async () => {
    const n = (u: string, t: string) => asUser(db.app, u, async (c) => (await c.query(`SELECT 1 FROM eureka.${t}`)).rowCount);
    expect(await n(U.hr, "job_application")).toBe(2);
    expect(await n(U.l2, "job_application")).toBe(2);
    expect(await n(U.r2a, "job_application")).toBe(0); // hired: the interviewers' access ended
    expect(await n(U.l1, "job_application")).toBe(0);
    expect(await n(U.l1, "application_scorecard")).toBe(0);
    expect(await n(U.r2a, "application_scorecard")).toBe(0);
    await expect(asUser(db.app, U.hr, (c) => c.query(`UPDATE eureka.job_application SET status = 'hired'`))).rejects.toMatchObject({ code: "42501" });
    await expect(asUser(db.app, U.hr, (c) => c.query(`SELECT authz.application_apply('${jobId}')`))).rejects.toMatchObject({ code: "42501" });
  });
});

describe("rule 3: the access sets are computed once per statement", () => {
  /** Calls of the given functions while running `sql` as `userId` (track_functions; superuser pool; rolled back). */
  async function calls(userId: string, sql: string, fns: string[]) {
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL track_functions = 'all'");
      await c.query("SELECT set_config('eureka.user_id', $1, true)", [userId]);
      const count = async (f: string) => Number((await c.query<{ n: string | null }>(`SELECT pg_stat_get_xact_function_calls($1::regprocedure) AS n`, [f])).rows[0]!.n ?? 0);
      const before = await Promise.all(fns.map(count));
      await c.query("SET LOCAL ROLE eureka_app");
      const rows = (await c.query(sql)).rowCount ?? 0;
      await c.query("RESET ROLE");
      return { rows, calls: await Promise.all(fns.map(async (f, i) => (await count(f)) - before[i]!)) };
    } finally { await c.query("ROLLBACK").catch(() => undefined); c.release(); }
  }

  it("applicant, job and application reads call each set once, not once per row", async () => {
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      await c.query(`INSERT INTO eureka.applicant (first_name, last_name, email)
        SELECT 'P', 'Q' || g, 'bulk' || g || '@example.com' FROM generate_series(1, 40) g`);
      await c.query(`INSERT INTO eureka.job_application (job_id, applicant_id)
        SELECT $1, id FROM eureka.applicant WHERE email LIKE 'bulk%'`, [jobId]);
      await c.query("COMMIT");
    } finally { c.release(); }
    const fns = ["authz.my_application_applicant_ids()", "authz.my_interview_job_ids()", "authz.my_hiring_job_ids()", "authz.my_interview_application_ids()"];
    const a = await calls(U.l2, `SELECT id FROM eureka.applicant`, fns);
    expect(a.rows).toBeGreaterThan(40);
    expect(a.calls[0]).toBe(1);
    const j = await calls(U.l2, `SELECT id FROM eureka.job`, fns);
    expect(j.calls[1]).toBeLessThanOrEqual(1);
    const ap = await calls(U.l2, `SELECT id FROM eureka.job_application`, fns);
    expect(ap.rows).toBeGreaterThan(40);
    expect(ap.calls[2]).toBeLessThanOrEqual(1);
    expect(ap.calls[3]).toBeLessThanOrEqual(1);
    // The sets are single statements over base tables: the applicants of 40 bulk rows did not multiply the nested calls.
    expect((a.calls[2] ?? 0) + (a.calls[3] ?? 0)).toBe(0);
  });
});
