import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MANDATORY_NOTIFICATION_TYPES, NOTIFICATION_PREFERENCE_TYPES } from "@eureka/shared";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { maskIp, parseUserAgent } from "../src/platform/client-info.js";
import { INBOX_TYPES } from "../src/worker/notify-types.js";
import { foldLine, icsText } from "../src/modules/interviews/interviews.ics.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { U, seedFixtures } from "./fixtures.js";
import { seedPipeline, type PipelineSeed } from "./pipeline-seed.js";
import { joinedEmployee, type Joined } from "./employee-seed.js";
import { deliverInbox, emitEvent } from "./notification-seed.js";
import { extraUser } from "./placement-seed.js";

/**
 * interviews-settings package (docs/interviews-settings-api.md): interview
 * details, panel, scorecards and calendar file; Settings (profile,
 * notification preferences, login activity); staff directory; employee
 * contacts and export. API checks plus direct SQL against RLS and guards.
 */
let db: TestDb;
let app: NestFastifyApplication;
let seed: PipelineSeed;
const SECRET = "test-secret-test-secret-test-secret-123";
const extras: Record<string, string> = {};

beforeAll(async () => {
  db = await createTestDb();
  const candidates = await seedFixtures(db.admin);
  seed = await seedPipeline(db, candidates);
  extras.ahr = (await extraUser(db, "ahr", "associate_hr")).id;
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: SECRET, GOOGLE_HOSTED_DOMAIN: "eureka.example",
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

type Key = keyof typeof U | "ahr";
interface Session { cookie: string; csrf: string }
const sessions = new Map<string, Session>();
const UA_MAC_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const UA_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

async function newSession(key: Key, ua = UA_MAC_CHROME): Promise<Session> {
  const res = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: `${key}@eureka.example` },
    headers: { "user-agent": ua }, remoteAddress: "23.127.41.214" });
  expect(res.statusCode).toBe(204);
  const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
  const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
  return { cookie, csrf: me.json().csrfToken as string };
}
async function login(key: Key) {
  const cached = sessions.get(key);
  if (cached) return cached;
  const s = await newSession(key);
  sessions.set(key, s);
  return s;
}
async function call(key: Key | Session, method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const s = typeof key === "string" ? await login(key) : key;
  return app.inject({ method, url, payload: payload as never,
    headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}), ...headers } });
}
const audits = async (action: string) => (await db.admin.query<{ actor_id: string; entity_id: string | null; changes: Record<string, unknown> | null }>(
  `SELECT actor_id, entity_id, changes FROM eureka.audit_event WHERE action = $1 ORDER BY seq`, [action])).rows;
/** Rule 5: no emails, phones, links or free text in an audit change set. */
const noPii = (rows: { changes: unknown }[]) => {
  for (const r of rows) expect(JSON.stringify(r.changes ?? {})).not.toMatch(/@|https?:|\+1469|Strong answers|cloud hiring/i);
};

// A slot far from the seeded ones (2030) so the per-candidate overlap rule never trips.
let hour = 0;
const slot = () => new Date(Date.parse("2031-03-03T14:00:00Z") + (hour++) * 3 * 3_600_000).toISOString();
const r1aSubmission = () => seed.interviews.find((i) => i.recruiterId === U.r1a)!.submissionId;

async function createInterview(body: Record<string, unknown> = {}) {
  const res = await call("r1a", "POST", "/api/v1/interviews", {
    submissionId: r1aSubmission(), round: "Technical Screening", startsAt: slot(), durationMin: 30, interviewType: "video",
    meetingUrl: "https://meet.example.com/abc-defg", panelIds: [U.coach, U.l1], leadId: U.coach, ...body,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

// ---------------------------------------------------------------------------------------------

describe("interview details (IS-1..IS-5)", () => {
  it("creates with type, meeting link, duration, panel and lead; reads them back", async () => {
    const id = await createInterview();
    const got = (await call("r1a", "GET", `/api/v1/interviews/${id}`)).json();
    expect(got).toMatchObject({
      interviewType: "video", meetingUrl: "https://meet.example.com/abc-defg", durationMin: 30, position: "Java Developer",
      lead: { id: U.coach, name: "coach" },
    });
    expect(Date.parse(got.endsAt) - Date.parse(got.startsAt)).toBe(30 * 60_000);
    expect(got.panel.map((p: { id: string }) => p.id).sort()).toEqual([U.coach, U.l1].sort());
    const created = (await audits("interview.created")).find((a) => a.entity_id === id)!;
    expect(created.changes).toMatchObject({ interviewType: "video", meetingUrl: "set", panelSize: 2, leadId: U.coach });
    noPii(await audits("interview.created"));
  });

  it.each([
    ["an http meeting link", { meetingUrl: "http://meet.example.com/x" }],
    ["a javascript: link", { meetingUrl: "javascript:alert(1)" }],
    ["a link with spaces", { meetingUrl: "https://meet.example.com/a b" }],
    ["a 10 minute duration", { durationMin: 10 }],
    ["a 241 minute duration", { durationMin: 241 }],
    ["endsAt and durationMin together", { endsAt: "2031-01-01T10:00:00Z" }],
    ["a lead outside the panel", { leadId: U.l2 }],
    ["an unknown type", { interviewType: "carrier_pigeon" }],
    ["eleven panel members", { panelIds: Object.values(U).slice(0, 11), leadId: undefined }],
    ["duplicate panel members", { panelIds: [U.l1, U.l1], leadId: undefined }],
  ])("refuses %s (422)", async (_n, extra) => {
    const res = await call("r1a", "POST", "/api/v1/interviews", {
      submissionId: r1aSubmission(), round: "R", startsAt: slot(), durationMin: 30, ...extra,
    });
    expect(res.statusCode, res.body).toBe(422);
  });

  it("refuses an inactive panel member (database check, 422)", async () => {
    await db.admin.query(`INSERT INTO eureka.app_user (id, email, display_name, status) VALUES ('00000000-0000-0000-0000-0000000000f1','gone@eureka.example','Gone','inactive')`);
    const res = await call("r1a", "POST", "/api/v1/interviews", {
      submissionId: r1aSubmission(), round: "R", startsAt: slot(), durationMin: 30, panelIds: ["00000000-0000-0000-0000-0000000000f1"],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toBe("invalid_panel_member");
  });

  it("updates panel, lead, type, link and duration as the Sales owner; keeps the lead when still on the panel", async () => {
    const id = await createInterview();
    let res = await call("r1a", "PATCH", `/api/v1/interviews/${id}`, { panelIds: [U.coach, U.r1b], durationMin: 45, interviewType: "phone", meetingUrl: null });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ interviewType: "phone", meetingUrl: null, durationMin: 45, lead: { id: U.coach } });
    res = await call("r1a", "PATCH", `/api/v1/interviews/${id}`, { panelIds: [U.r1b], leadId: U.r1b });
    expect(res.json().lead).toEqual({ id: U.r1b, name: "r1b" });
    res = await call("r1a", "PATCH", `/api/v1/interviews/${id}`, { leadId: U.r1b });
    expect(res.statusCode).toBe(422); // leadId needs panelIds
    const updated = (await audits("interview.updated")).filter((a) => a.entity_id === id);
    expect(updated[0]!.changes).toMatchObject({ meetingUrl: "cleared", durationMin: 45, panelSize: 2, leadId: U.coach });
    noPii(updated);
  });

  it("location editors cannot change Sales details (IS-5)", async () => {
    const dallas = seed.interviews.find((i) => i.recruiterId === U.r1a && i.locationId !== null)!;
    const loc = (await db.admin.query(`SELECT location_id FROM eureka.interview WHERE id = $1`, [dallas.id])).rows[0].location_id;
    const editor = loc === "00000000-0000-0000-0000-00000000d001" ? "locD" : "locA";
    for (const body of [{ meetingUrl: "https://x.example.com/1" }, { panelIds: [U.coach] }, { interviewType: "phone" }, { durationMin: 60 }]) {
      const res = await call(editor, "PATCH", `/api/v1/interviews/${dallas.id}`, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(422);
      expect(res.json().detail).toMatch(/^field_not_permitted/);
    }
  });

  it("meeting links are readable only by readers of the interview (IS-3)", async () => {
    const id = await createInterview();
    expect((await call("r1b", "GET", `/api/v1/interviews/${id}`)).statusCode).toBe(404);
    const list = (await call("r2a", "GET", "/api/v1/interviews?limit=200")).json();
    expect(JSON.stringify(list)).not.toContain("meet.example.com/abc-defg");
    // The panel does not open the interview: l2 is not on r1a's team.
    const other = await createInterview({ panelIds: [U.l2], leadId: U.l2 });
    expect((await call("l2", "GET", `/api/v1/interviews/${other}`)).statusCode).toBe(404);
  });

  it("panel options list active staff names only", async () => {
    const res = await call("r1a", "GET", "/api/v1/interviews/panel-options");
    expect(res.statusCode).toBe(200);
    const items = res.json().items as { id: string; name: string }[];
    expect(items.some((i) => i.id === U.coach)).toBe(true);
    expect(items.some((i) => i.id === "00000000-0000-0000-0000-0000000000f1")).toBe(false);
    expect(Object.keys(items[0]!).sort()).toEqual(["id", "name"]);
    expect((await call("coach", "GET", "/api/v1/interviews/panel-options")).statusCode).toBe(403);
  });
});

describe("scorecards (IS-6)", () => {
  const score = { technicalSkills: 4, communication: 5, problemSolving: 3, attitude: 4 };
  const coached = () => seed.interviews.find((i) => i.teamId === "00000000-0000-0000-0000-000000000102")!; // Team Anjali (coached)

  it("the coach adds a scorecard; it reads back on the feedback list; the audit keeps numbers only", async () => {
    const i = coached();
    const res = await call("coach", "POST", `/api/v1/interviews/${i.id}/feedback`, { kind: "coach", scorecard: score, notes: "Strong answers" });
    expect(res.statusCode, res.body).toBe(201);
    const list = (await call("coach", "GET", `/api/v1/interviews/${i.id}/feedback`)).json().items;
    expect(list.find((f: { id: string }) => f.id === res.json().id)).toMatchObject({ scorecard: score, round: "L1" });
    noPii(await audits("interview.feedback.created"));
  });

  it.each([
    ["three criteria", { technicalSkills: 4, communication: 5, problemSolving: 3 }],
    ["a 6", { ...score, attitude: 6 }],
    ["a 0", { ...score, attitude: 0 }],
    ["an extra key", { ...score, charisma: 5 }],
  ])("refuses a scorecard with %s", async (_n, sc) => {
    const res = await call("coach", "POST", `/api/v1/interviews/${coached().id}/feedback`, { kind: "coach", scorecard: sc });
    expect(res.statusCode).toBe(422);
  });

  it("location feedback carries no scorecard (API and database)", async () => {
    const dallas = seed.interviews.find((i) => i.locationId === "00000000-0000-0000-0000-00000000d001")!;
    const res = await call("locD", "POST", `/api/v1/interviews/${dallas.id}/feedback`, { kind: "location", scorecard: score });
    expect(res.statusCode).toBe(422);
    await expect(asUser(db.app, U.locD, (c) => c.query(
      `INSERT INTO eureka.interview_feedback (interview_id, author_id, kind, technical_skills, communication, problem_solving, attitude)
       VALUES ($1,$2,'location',4,4,4,4)`, [dallas.id, U.locD]))).rejects.toMatchObject({ code: "23514" });
  });
});

describe("calendar file (IS-7)", () => {
  it("is an RFC 5545 event with the panel's work emails as the only addresses", async () => {
    const id = await createInterview({ round: "Final; Round, 2" });
    const res = await call("r1a", "GET", `/api/v1/interviews/${id}/calendar.ics`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/calendar/);
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="interview-${id}.ics"`);
    const body = res.body;
    expect(body.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(body).toContain(`UID:interview-${id}@eureka`);
    expect(body).toContain("SUMMARY:Interview: Final\\; Round\\, 2 with ");
    expect(body).toContain("URL:https://meet.example.com/abc-defg");
    expect(body).toMatch(/ATTENDEE;CN="coach";ROLE=CHAIR:mailto:coach@eureka\.example/);
    expect(body).toMatch(/ATTENDEE;CN="l1";ROLE=REQ-PARTICIPANT:mailto:l1@eureka\.example/);
    const emails = body.replace(/\r\n /g, "").match(/[\w.+-]+@[\w.-]+/g) ?? [];
    expect(new Set(emails.filter((e) => !e.endsWith("@eureka")))).toEqual(new Set(["coach@eureka.example", "l1@eureka.example"]));
    for (const line of body.split("\r\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    const a = (await audits("interview.calendar_downloaded")).find((x) => x.entity_id === id)!;
    expect(a.changes).toEqual({ attendees: 2 });
  });

  it("needs read access and a scheduled interview", async () => {
    const id = await createInterview();
    expect((await call("r1b", "GET", `/api/v1/interviews/${id}/calendar.ics`)).statusCode).toBe(404);
    await call("r1a", "PATCH", `/api/v1/interviews/${id}`, { callStatus: "cancelled" });
    const res = await call("r1a", "GET", `/api/v1/interviews/${id}/calendar.ics`);
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toBe("interview_not_scheduled");
  });

  it("escapes text and folds long lines on UTF-8 boundaries", () => {
    expect(icsText("a,b;c\\d\ne\u0007")).toBe("a\\,b\\;c\\\\d\\ne");
    const folded = foldLine(`SUMMARY:${"é".repeat(60)}`);
    for (const l of folded.split("\r\n")) expect(Buffer.byteLength(l)).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, "")).toBe(`SUMMARY:${"é".repeat(60)}`);
  });
});

describe("panel RLS and definer (direct SQL)", () => {
  it("panel rows follow interview visibility; the app cannot write them directly", async () => {
    const id = await createInterview();
    const seen = (u: string) => asUser(db.app, u, async (c) => (await c.query(`SELECT 1 FROM eureka.interview_panelist WHERE interview_id = $1`, [id])).rowCount);
    expect(await seen(U.r1a)).toBe(2);
    expect(await seen(U.r1b)).toBe(0);
    expect(await seen(U.admin)).toBe(0);
    await expect(asUser(db.app, U.r1a, (c) => c.query(
      `INSERT INTO eureka.interview_panelist (interview_id, user_id) VALUES ($1,$2)`, [id, U.l2]))).rejects.toMatchObject({ code: "42501" });
    await expect(asUser(db.app, U.r1a, (c) => c.query(`DELETE FROM eureka.interview_panelist WHERE interview_id = $1`, [id])))
      .rejects.toMatchObject({ code: "42501" });
  });

  it("authz.set_interview_panel re-checks the Sales grant and reveals nothing for unknown interviews", async () => {
    const id = await createInterview();
    for (const u of [U.r1b, U.coach, U.locD, U.hr, U.admin]) {
      await expect(asUser(db.app, u, (c) => c.query(`SELECT authz.set_interview_panel($1, $2::uuid[], NULL)`, [id, [u]])))
        .rejects.toThrow("not_permitted");
    }
    await expect(asUser(db.app, U.r1a, (c) => c.query(`SELECT authz.set_interview_panel(gen_random_uuid(), '{}'::uuid[], NULL)`)))
      .rejects.toThrow("not_permitted");
    const n = await asUser(db.app, U.l1, async (c) => (await c.query(`SELECT authz.set_interview_panel($1, $2::uuid[], $3) AS n`, [id, [U.l1], U.l1])).rows[0].n, true);
    expect(n).toBe(1);
    const row = (await db.admin.query(`SELECT added_by, is_lead FROM eureka.interview_panelist WHERE interview_id = $1`, [id])).rows[0];
    expect(row).toEqual({ added_by: U.l1, is_lead: true });
  });

  it("the guard keeps meeting links and types Sales-only at the database", async () => {
    const dallas = seed.interviews.find((i) => i.locationId === "00000000-0000-0000-0000-00000000d001")!;
    await expect(asUser(db.app, U.locD, (c) => c.query(`UPDATE eureka.interview SET meeting_url = 'https://evil.example.com' WHERE id = $1`, [dallas.id])))
      .rejects.toThrow("field_not_permitted");
    await expect(asUser(db.app, U.r1a, (c) => c.query(`UPDATE eureka.interview SET meeting_url = 'http://x.example.com' WHERE submission_id = $1`, [r1aSubmission()])))
      .rejects.toMatchObject({ code: "23514" });
  });
});

// ---------------------------------------------------------------------------------------------

describe("settings: profile (ST-2, ST-3)", () => {
  it("reads display name, designation and sign-in domain; saves phone and bio with If-Match", async () => {
    const s = await newSession("r1a");
    let res = await call(s, "GET", "/api/v1/settings/profile");
    expect(res.json()).toMatchObject({ displayName: "r1a", email: "r1a@eureka.example", rowVersion: 0, phone: null,
      signIn: { provider: "dev", domain: "eureka.example" } });
    res = await call(s, "PUT", "/api/v1/settings/profile", { phone: "+1 469 555 0142", bio: "Java and cloud hiring." });
    expect(res.statusCode).toBe(428);
    res = await call(s, "PUT", "/api/v1/settings/profile", { phone: "+1 469 555 0142", bio: "Java and cloud hiring." }, { "if-match": '"0"' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ phone: "+14695550142", bio: "Java and cloud hiring.", rowVersion: 1 });
    res = await call(s, "PUT", "/api/v1/settings/profile", { phone: null, bio: null }, { "if-match": '"0"' });
    expect(res.statusCode).toBe(412);
    res = await call(s, "PUT", "/api/v1/settings/profile", { phone: "4695550142", bio: null }, { "if-match": '"1"' });
    expect(res.statusCode).toBe(422);
    res = await call(s, "PUT", "/api/v1/settings/profile", { phone: "+14695550142", bio: null, displayName: "Boss" }, { "if-match": '"1"' });
    expect(res.statusCode).toBe(422);
    const a = await audits("staff_profile.updated");
    expect(a.at(-1)!.changes).toEqual({ phoneSet: true, bioSet: true });
    noPii(a);
  });

  it("RLS: own row, or staff.contact:read (HR, Org Admin); never written for someone else", async () => {
    const seen = (u: string) => asUser(db.app, u, async (c) => (await c.query(`SELECT phone_e164 FROM eureka.staff_profile WHERE user_id = $1`, [U.r1a])).rows);
    expect(await seen(U.r1a)).toHaveLength(1);
    expect(await seen(U.hr)).toHaveLength(1);
    expect(await seen(U.admin)).toHaveLength(1);
    expect(await seen(U.r1b)).toHaveLength(0);
    expect(await seen(U.ceo)).toHaveLength(0);
    expect(await seen(extras.ahr!)).toHaveLength(0);
    await expect(asUser(db.app, U.r1b, (c) => c.query(`INSERT INTO eureka.staff_profile (user_id, bio) VALUES ($1,'x')`, [U.r1a])))
      .rejects.toMatchObject({ code: "42501" });
    const upd = await asUser(db.app, U.r1b, (c) => c.query(`UPDATE eureka.staff_profile SET bio = 'x' WHERE user_id = $1`, [U.r1a]));
    expect(upd.rowCount).toBe(0);
    await expect(asUser(db.app, U.r1a, (c) => c.query(`UPDATE eureka.staff_profile SET row_version = 99 WHERE user_id = $1`, [U.r1a])))
      .rejects.toMatchObject({ code: "42501" });
  });

  it("the Users list shows the phone to staff.contact:read holders and the KPI cards count roles with users", async () => {
    const res = await call("admin", "GET", "/api/v1/admin/users?limit=200");
    expect(res.json().contactVisible).toBe(true);
    expect(res.json().items.find((u: { id: string }) => u.id === U.r1a).phone).toBe("+14695550142");
    const sum = (await call("admin", "GET", "/api/v1/admin/users/summary")).json();
    expect(sum.roles.find((r: { key: string }) => r.key === "recruiter").count).toBe(4);
    expect(sum.roles.every((r: { count: number }) => r.count > 0)).toBe(true);
    expect(sum.roles.some((r: { key: string }) => r.key === "accounts")).toBe(true);
    expect(sum.roles.some((r: { key: string }) => r.key === "bu_head")).toBe(false);
    expect((await call("hr", "GET", "/api/v1/admin/users/summary")).statusCode).toBe(403);
  });
});

describe("settings: notification preferences (ST-4)", () => {
  it("the shared list matches the worker's in-app types", () => {
    expect(NOTIFICATION_PREFERENCE_TYPES.map((t) => t.type).sort()).toEqual([...INBOX_TYPES].sort());
  });

  it("the database's mandatory list matches the shared one", async () => {
    for (const t of NOTIFICATION_PREFERENCE_TYPES) {
      const attempt = asUser(db.app, U.hr, (c) => c.query(`INSERT INTO eureka.notification_preference (user_id, type, in_app) VALUES ($1,$2,false)`, [U.hr, t.type]));
      if (MANDATORY_NOTIFICATION_TYPES.includes(t.type)) await expect(attempt).rejects.toThrow("notification_type_mandatory");
      else await expect(attempt).resolves.toBeTruthy();
    }
  });

  it("lists, switches off and on, refuses mandatory and unknown types", async () => {
    let res = await call("hr", "GET", "/api/v1/settings/notifications");
    expect(res.json().items.every((i: { inApp: boolean }) => i.inApp)).toBe(true);
    res = await call("hr", "PUT", "/api/v1/settings/notifications/assignment.ending_soon", { inApp: false });
    expect(res.json().items.find((i: { type: string }) => i.type === "assignment.ending_soon").inApp).toBe(false);
    res = await call("hr", "PUT", "/api/v1/settings/notifications/work_authorization.expiring", { inApp: false });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toBe("notification_type_mandatory");
    expect((await call("hr", "PUT", "/api/v1/settings/notifications/bogus.type", { inApp: false })).statusCode).toBe(422);
    expect((await call("hr", "PUT", "/api/v1/settings/notifications/employee.exited", { inApp: "no" })).statusCode).toBe(422);
    // Other users' rows are invisible and untouchable.
    const n = await asUser(db.app, U.acct, async (c) => (await c.query(`SELECT 1 FROM eureka.notification_preference WHERE user_id = $1`, [U.hr])).rowCount);
    expect(n).toBe(0);
    await expect(asUser(db.app, U.acct, (c) => c.query(`INSERT INTO eureka.notification_preference (user_id, type, in_app) VALUES ($1,'employee.exited',false)`, [U.hr])))
      .rejects.toMatchObject({ code: "42501" });
  });

  it("the worker skips muted recipients' inbox rows; the email audience is unchanged", async () => {
    const j: Joined = await joinedEmployee(db);
    // hr muted assignment.ending_soon above; accounts did not.
    const ev = await emitEvent(db, "assignment.ending_soon", "assignment", j.assignmentId, {
      assignmentId: j.assignmentId, placementId: j.placementId, personId: j.personId, candidateId: j.candidateId,
      plannedEndDate: "2026-11-01", daysLeft: 30, notify: ["hr", "accounts"] });
    await deliverInbox(db, ev);
    const rows = (await db.admin.query(`SELECT recipient_id FROM eureka.notification WHERE event_id = $1`, [ev])).rows.map((r) => r.recipient_id);
    expect(rows).toEqual([U.acct]);
    expect((await db.admin.query(`SELECT recipients FROM eureka.inbox_fanout WHERE event_id = $1`, [ev])).rows[0].recipients).toBe(2);
    // Switching back on restores delivery for the next event.
    await call("hr", "PUT", "/api/v1/settings/notifications/assignment.ending_soon", { inApp: true });
    const ev2 = await emitEvent(db, "assignment.ending_soon", "assignment", j.assignmentId, {
      assignmentId: j.assignmentId, placementId: j.placementId, personId: j.personId, candidateId: j.candidateId,
      plannedEndDate: "2026-11-01", daysLeft: 29, notify: ["hr", "accounts"] });
    await deliverInbox(db, ev2);
    expect((await db.admin.query(`SELECT count(*)::int AS n FROM eureka.notification WHERE event_id = $1`, [ev2])).rows[0].n).toBe(2);
  });
});

describe("settings: login activity (ST-5..ST-8)", () => {
  it("parses device and browser and masks the IP", () => {
    expect(parseUserAgent(UA_MAC_CHROME)).toEqual({ deviceClass: "desktop", browser: "Chrome" });
    expect(parseUserAgent(UA_IPHONE)).toEqual({ deviceClass: "mobile", browser: "Safari" });
    expect(parseUserAgent("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/128.0 Safari/537.36 Edg/128.0")).toEqual({ deviceClass: "desktop", browser: "Edge" });
    expect(parseUserAgent(null)).toEqual({ deviceClass: "unknown", browser: "Other" });
    expect(maskIp("23.127.41.214")).toBe("23.127.xx.xx");
    expect(maskIp("::ffff:10.1.2.3")).toBe("10.1.xx.xx");
    expect(maskIp("2001:db8:85a3::8a2e:370:7334")).toBe("2001:db8:x:x");
    expect(maskIp("not-an-ip")).toBeNull();
  });

  it("lists own sessions only, marks the current one and stores no user agent or full IP", async () => {
    const desk = await newSession("r2a");
    const phone = await newSession("r2a", UA_IPHONE);
    await newSession("r3a");
    const res = await call(desk, "GET", "/api/v1/settings/sessions");
    expect(res.statusCode).toBe(200);
    const items = res.json().items as { id: string; current: boolean; device: string; browser: string; ip: string; status: string }[];
    expect(items[0]).toMatchObject({ current: true, device: "desktop", browser: "Chrome", ip: "23.127.xx.xx", status: "active" });
    expect(items.find((i) => !i.current)).toMatchObject({ device: "mobile", browser: "Safari", status: "active" });
    const own = (await db.admin.query(`SELECT count(*)::int AS n FROM eureka.session WHERE user_id = $1`, [U.r2a])).rows[0].n;
    expect(items).toHaveLength(own); // r3a's session is not listed
    expect(items.filter((i) => i.current)).toHaveLength(1);
    expect(JSON.stringify(res.json())).not.toMatch(/41\.214|id_hash|Mozilla/);
    const cols = (await db.admin.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'eureka' AND table_name = 'session'`)).rows.map((r) => r.column_name);
    expect(cols).not.toContain("user_agent");
    expect(cols).not.toContain("ip");
    void phone;
  });

  it("signs out another session (its cookie stops working), refuses the current one and other users' sessions", async () => {
    const a = await newSession("r3a");
    const b = await newSession("r3a", UA_IPHONE);
    const mine = (await call(a, "GET", "/api/v1/settings/sessions")).json().items as { id: string; current: boolean }[];
    const other = mine.find((i) => !i.current && i.id)!;
    const current = mine.find((i) => i.current)!;
    expect((await call(a, "POST", `/api/v1/settings/sessions/${current.id}/revoke`)).json().detail).toBe("current_session");
    const stranger = await newSession("r2a");
    expect((await call(stranger, "POST", `/api/v1/settings/sessions/${other.id}/revoke`)).statusCode).toBe(404);
    const res = await call(a, "POST", `/api/v1/settings/sessions/${other.id}/revoke`);
    expect(res.statusCode).toBe(204);
    expect((await call(b, "GET", "/api/v1/me")).statusCode).toBe(401);
    expect((await call(a, "GET", "/api/v1/me")).statusCode).toBe(200);
    expect((await call(a, "POST", `/api/v1/settings/sessions/${other.id}/revoke`)).statusCode).toBe(404);
    const revoked = (await audits("session.revoked")).at(-1)!;
    expect(revoked).toMatchObject({ actor_id: U.r3a, entity_id: other.id, changes: { count: 1 } });
  });

  it("signs out of all other sessions and keeps the current one", async () => {
    const a = await newSession("r1b");
    const b = await newSession("r1b");
    const c = await newSession("r1b", UA_IPHONE);
    const res = await call(a, "POST", "/api/v1/settings/sessions/revoke-others");
    expect(res.json().revoked).toBeGreaterThanOrEqual(2);
    expect((await call(b, "GET", "/api/v1/me")).statusCode).toBe(401);
    expect((await call(c, "GET", "/api/v1/me")).statusCode).toBe(401);
    expect((await call(a, "GET", "/api/v1/me")).statusCode).toBe(200);
    sessions.delete("r1b");
    noPii(await audits("session.revoked_others"));
  });

  it("the app may change only last_seen_at and revoked_at of a session", async () => {
    await expect(asUser(db.app, U.r1a, (c) => c.query(`UPDATE eureka.session SET expires_at = now() + interval '1 year' WHERE user_id = $1`, [U.r1a])))
      .rejects.toMatchObject({ code: "42501" });
    await expect(asUser(db.app, U.r1a, (c) => c.query(`UPDATE eureka.session SET ip_masked = '1.2.xx.xx' WHERE user_id = $1`, [U.r1a])))
      .rejects.toMatchObject({ code: "42501" });
  });

  it("writes need the CSRF token", async () => {
    const s = await newSession("r2a");
    const res = await app.inject({ method: "POST", url: "/api/v1/settings/sessions/revoke-others", headers: { cookie: s.cookie } });
    expect(res.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------------------------

describe("employees: contacts and export (EM-C1, EM-X1)", () => {
  let j: Joined;
  beforeAll(async () => {
    j = await joinedEmployee(db);
    await db.admin.query(`UPDATE eureka.person SET personal_email = 'asha.iyer@example.com', phone_e164 = '+14695550143', first_name = '=HYPERLINK("x")' WHERE id = $1`, [j.personId]);
  });
  const item = async (k: Key) => ((await call(k, "GET", "/api/v1/employees?limit=200")).json().items as { id: string; contact: unknown }[])
    .find((i) => i.id === j.personId)!;

  it("HR (candidate.phone:read) sees the contact; Accounts and the CEO see it masked", async () => {
    expect((await item("hr")).contact).toEqual({ email: "asha.iyer@example.com", phone: "+14695550143", masked: false });
    for (const k of ["acct", "ceo"] as const) {
      expect((await item(k)).contact).toEqual({ email: "a•••@example.com", phone: "•••-•••-43", masked: true });
    }
  });

  it("exports CSV for report:export holders who read employees; formula cells are neutralised; audit has counts only", async () => {
    const res = await call("ceo", "POST", "/api/v1/employees/export", { status: "on_assignment" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/csv/);
    expect(res.body).toContain(`"'=HYPERLINK(""x"") Placed"`);
    expect(res.body).toContain("a•••@example.com");
    expect(res.body).not.toContain("asha.iyer@example.com");
    const a = (await audits("employee.export")).at(-1)!;
    expect(a.changes).toMatchObject({ filters: ["status"], truncated: false });
    noPii(await audits("employee.export"));
  });

  it.each([["hr", 403], ["l1", 403], ["r1a", 403], ["admin", 403]] as const)("%s cannot export (%i)", async (k, code) => {
    expect((await call(k, "POST", "/api/v1/employees/export", {})).statusCode).toBe(code);
  });

  it("refuses unknown export fields", async () => {
    expect((await call("ceo", "POST", "/api/v1/employees/export", { cursor: "x" })).statusCode).toBe(422);
  });
});
