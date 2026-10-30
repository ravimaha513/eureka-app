import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { CALENDAR_PROVIDER, DevCalendarProvider } from "../src/modules/calendar/calendar.provider.js";
import { loadConfig } from "../src/platform/config.js";
import { LocalMail } from "../src/worker/feedback-mail.js";
import { birthdayDigestJob } from "../src/worker/jobs/birthdays.js";
import { deliverEvent } from "../src/worker/jobs/outbox.js";
import { EVENT_SPECS, formatSlot } from "../src/worker/notify-types.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { U, seedFixtures } from "./fixtures.js";
import { workerCtx } from "./notification-seed.js";
import { createPlacement, extraUser, newCandidate, selectedSubmission } from "./placement-seed.js";
import { seedPipeline, type PipelineSeed } from "./pipeline-seed.js";
import { LOC, T } from "./fixtures.js";

/**
 * interview-alerts package (docs/alerts-calendar-birthdays.md): interview
 * request alerts to the coordinators with the interview details, contracts on
 * placements with the Accounts / HR alert, staff birthdays with the CEO's
 * morning digest, and the support calendar (dev provider). API checks, the
 * outbox rows the producers write, and delivery through the real worker job.
 */
let db: TestDb;
let app: NestFastifyApplication;
let seed: PipelineSeed;
let mailDir: string;
let coord = "";
let ahr = "";
const SECRET = "test-secret-test-secret-test-secret-123";
const ORIGIN = "https://eureka.example";

beforeAll(async () => {
  db = await createTestDb();
  const candidates = await seedFixtures(db.admin);
  seed = await seedPipeline(db, candidates);
  coord = (await extraUser(db, "coord", "interview_coordinator")).id;
  ahr = (await extraUser(db, "ahr", "associate_hr")).id;
  mailDir = await mkdtemp(join(tmpdir(), "eureka-alerts-mail-"));
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: SECRET, GOOGLE_HOSTED_DOMAIN: "eureka.example",
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
  if (mailDir) await rm(mailDir, { recursive: true, force: true });
});

type Key = keyof typeof U | "coord" | "ahr";
interface Session { cookie: string; csrf: string }
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
async function call(key: Key, method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const s = await login(key);
  return app.inject({ method, url, payload: payload as never,
    headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}), ...headers } });
}

const events = async (type: string, aggregate: string) => (await db.admin.query<{ id: string; payload: Record<string, unknown> }>(
  "SELECT id, payload FROM eureka.outbox_event WHERE type = $1 AND aggregate_id = $2 ORDER BY created_at, id", [type, aggregate])).rows;

/** Delivers one event (local mail): the inbox rows and the emails written for it. */
async function deliver(eventId: string) {
  const r = await deliverEvent(db.worker, new LocalMail(mailDir), ORIGIN, eventId, workerCtx());
  const inbox = (await db.admin.query<{ recipient_id: string; title: string; body: string; entity_type: string; entity_id: string }>(
    "SELECT recipient_id, title, body, entity_type, entity_id FROM eureka.notification WHERE event_id = $1 ORDER BY recipient_id", [eventId])).rows;
  const files = (await readdir(mailDir)).filter((f) => f.startsWith(eventId));
  const mails = await Promise.all(files.map(async (f) => JSON.parse(await readFile(join(mailDir, f), "utf8")) as { to: string; subject: string; text: string }));
  return { result: r, inbox, mails: mails.sort((a, b) => a.to.localeCompare(b.to)) };
}
const audits = async (action: string) => (await db.admin.query<{ actor_id: string; entity_id: string | null; changes: Record<string, unknown> | null }>(
  `SELECT actor_id, entity_id, changes FROM eureka.audit_event WHERE action = $1 ORDER BY seq`, [action])).rows;

let hour = 0;
const slot = () => new Date(Date.parse("2031-05-05T14:00:00Z") + (hour++) * 3 * 3_600_000).toISOString();
const r1aInterview = () => seed.interviews.find((i) => i.recruiterId === U.r1a)!;

// ---------------------------------------------------------------------------------------------

describe("interview request alerts (IA-1..IA-5)", () => {
  let interviewId = "";
  let candidateName = "";

  it("creating an interview records interview.requested (ids only) and delivers the details to the coordinators", async () => {
    const sub = r1aInterview().submissionId;
    const cand = r1aInterview().candidate.id;
    await asUser(db.app, U.r1a, (c) => c.query("UPDATE eureka.candidate SET marketing_email = 'cand.one@example.com' WHERE id = $1", [cand]), true);
    candidateName = (await db.admin.query<{ n: string }>(
      "SELECT p.first_name || ' ' || p.last_name AS n FROM eureka.candidate c JOIN eureka.person p ON p.id = c.person_id WHERE c.id = $1", [cand])).rows[0]!.n;
    const startsAt = slot();
    const res = await call("r1a", "POST", "/api/v1/interviews", {
      submissionId: sub, round: "Client round 2", startsAt, durationMin: 45, interviewType: "video",
      meetingUrl: "https://meet.example.com/xyz-abc", panelIds: [U.coach, U.l1], leadId: U.coach, coachId: U.coach,
    });
    expect(res.statusCode, res.body).toBe(201);
    interviewId = res.json().id;
    const [ev] = await events("interview.requested", interviewId);
    expect(ev).toBeDefined();
    expect(Object.keys(ev!.payload).sort()).toEqual(["candidateId", "change", "interviewId", "notify", "startsOn", "submissionId"]);
    expect(ev!.payload).toMatchObject({ interviewId, candidateId: cand, submissionId: sub, change: "created", notify: ["interview_coordinator"] });
    expect(JSON.stringify(ev!.payload)).not.toMatch(/cand\.one|example\.com|Client round/);

    const r = await deliver(ev!.id);
    expect(r.result.sent).toBe(1);
    expect(r.inbox.map((x) => x.recipient_id)).toEqual([coord]);
    expect(r.inbox[0]).toMatchObject({ title: "Interview requested", entity_type: "interview", entity_id: interviewId });
    // The inbox row stays ids-only; the email carries the details (owner decision 2026-10-15), candidate email included.
    expect(`${r.inbox[0]!.title} ${r.inbox[0]!.body}`).not.toMatch(/cand\.one|Client round|meet\.example/);
    expect(r.mails.map((m) => m.to)).toEqual(["coord@eureka.example"]);
    const text = r.mails[0]!.text;
    expect(r.mails[0]!.subject).toBe("Eureka: interview requested");
    expect(text).toContain(`Candidate: ${candidateName}`);
    expect(text).toContain("Candidate email: cand.one@example.com");
    expect(text).toContain("Round: Client round 2");
    expect(text).toContain("Interview type: Video");
    expect(text).toContain("Meeting link: https://meet.example.com/xyz-abc");
    expect(text).toContain(`Slot: ${formatSlot(new Date(startsAt), new Date(Date.parse(startsAt) + 45 * 60_000))}`);
    expect(text).toContain("Panel: coach (lead), l1");
    expect(text).toContain("Recruiter: r1a");
    expect(text).toContain("Coach: coach");
    expect(text).toContain("Position: Java Developer");
    expect(text).toContain(`Interview reference: ${interviewId}`);
    expect(text).toContain("You receive this email as an interview coordinator.");
    expect((await db.admin.query("SELECT published_at FROM eureka.outbox_event WHERE id = $1", [ev!.id])).rows[0]!.published_at).not.toBeNull();
  });

  it("moving the slot records a rescheduled alert; cancelling records a cancelled one; other edits do not", async () => {
    const res = await call("r1a", "PATCH", `/api/v1/interviews/${interviewId}`, { round: "Client round 2 (final)" });
    expect(res.statusCode, res.body).toBe(200);
    expect((await events("interview.requested", interviewId)).length).toBe(1);
    const moved = await call("r1a", "PATCH", `/api/v1/interviews/${interviewId}`, { startsAt: slot(), durationMin: 30 });
    expect(moved.statusCode, moved.body).toBe(200);
    let evs = await events("interview.requested", interviewId);
    expect(evs.map((e) => e.payload.change)).toEqual(["created", "rescheduled"]);
    const r = await deliver(evs[1]!.id);
    expect(r.mails[0]!.subject).toBe("Eureka: interview rescheduled");
    expect(r.inbox[0]!.title).toBe("Interview rescheduled");
    await asUser(db.app, U.r1a, (c) => c.query("UPDATE eureka.interview SET call_status = 'cancelled' WHERE id = $1", [interviewId]), true);
    evs = await events("interview.requested", interviewId);
    expect(evs.map((e) => e.payload.change)).toEqual(["created", "rescheduled", "cancelled"]);
    expect((await deliver(evs[2]!.id)).mails[0]!.text).toContain("An interview was cancelled.");
  });

  it("interviews in the past (imported history) emit nothing", async () => {
    const id = await asUser(db.app, U.r1a, async (c) => (await c.query<{ id: string }>(
      "INSERT INTO eureka.interview (submission_id, round, starts_at, ends_at) VALUES ($1, 'Old', now() - interval '3 days', now() - interval '3 days' + interval '1 hour') RETURNING id",
      [r1aInterview().submissionId])).rows[0]!.id, true);
    expect(await events("interview.requested", id)).toEqual([]);
  });

  it("the coordinator role reads interviews org-wide and nothing else of Sales", async () => {
    const list = await call("coord", "GET", "/api/v1/interviews?limit=5");
    expect(list.statusCode).toBe(200);
    expect(list.json().items.length).toBeGreaterThan(0);
    expect((await call("coord", "GET", "/api/v1/placements?limit=5")).statusCode).toBe(403);
    expect((await call("coord", "GET", "/api/v1/submissions?limit=5")).statusCode).toBe(403);
  });

  it("the coordinator does not read candidates org-wide (team-scoped Hot List) but sees the name on each interview", async () => {
    expect((await call("coord", "GET", "/api/v1/candidates?limit=5")).statusCode).toBe(403);
    expect((await call("coord", "GET", "/api/v1/hotlist?limit=5")).statusCode).toBe(403);
    const candidateId = r1aInterview().candidate.id;
    expect([403, 404]).toContain((await call("coord", "GET", `/api/v1/candidates/${candidateId}`)).statusCode);
    const n = await asUser(db.app, coord, async (c) =>
      (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM eureka.candidate")).rows[0]!.n);
    expect(n).toBe(0);
    const items = (await call("coord", "GET", `/api/v1/interviews?limit=50&candidateId=${candidateId}`)).json().items as { candidate: { id: string; name: string | null } }[];
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) expect(i.candidate.name).toMatch(/\S+ \S+/);
    // The fallback name read is for interview:read at org scope only.
    const other = await asUser(db.app, U.hr, async (c) => (await c.query<{ n: string | null }>(
      "SELECT authz.interview_candidate_name(id) AS n FROM eureka.interview LIMIT 1")).rows);
    expect(other.every((r) => r.n === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------

describe("contracts (CT-1..CT-6)", () => {
  let placementId = "";
  let candidateId = "";

  it("a lead over the placement adds a contract; Accounts may too; a recruiter without placement:update over it may not", async () => {
    const cand = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
    candidateId = cand.id;
    const sub = await selectedSubmission(db, U.r1a, cand.id);
    placementId = (await createPlacement(db, U.r1a, sub)).id;
    const res = await call("l1", "POST", `/api/v1/placements/${placementId}/contracts`, {
      kind: "po", title: "PO 4471 Q4 staffing", reference: "PO-4471", startsOn: "2031-01-05", endsOn: "2031-06-30", notes: "Net 30. Rate card attached as SOW.",
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ placementId, kind: "po", title: "PO 4471 Q4 staffing", reference: "PO-4471", startsOn: "2031-01-05", endsOn: "2031-06-30", createdBy: { id: U.l1, name: "l1" } });
    expect((await call("acct", "POST", `/api/v1/placements/${placementId}/contracts`, { kind: "msa", title: "Northwind MSA 2031" })).statusCode).toBe(201);
    // r1b (recruiter, own scope) cannot see r1a's placement: 404; the coach holds no placement permission at all: 403 (guard).
    expect((await call("r1b", "POST", `/api/v1/placements/${placementId}/contracts`, { kind: "sow", title: "SOW" })).statusCode).toBe(404);
    expect((await call("coach", "POST", `/api/v1/placements/${placementId}/contracts`, { kind: "sow", title: "SOW" })).statusCode).toBe(403);
    // hr reads the placement org-wide but holds neither placement:update nor invoice:update: 403 from the database.
    expect((await call("hr", "POST", `/api/v1/placements/${placementId}/contracts`, { kind: "sow", title: "SOW" })).statusCode).toBe(403);
    expect((await call("l1", "POST", `/api/v1/placements/${placementId}/contracts`, { kind: "po", title: "x", startsOn: "2031-02-01", endsOn: "2031-01-01" })).statusCode).toBe(422);
    expect((await call("l1", "POST", `/api/v1/placements/${placementId}/contracts`, { kind: "po", title: "x", extra: 1 })).statusCode).toBe(422);
  });

  it("readers of the placement list its contracts; canAdd follows the write rule", async () => {
    const hr = await call("hr", "GET", `/api/v1/placements/${placementId}/contracts`);
    expect(hr.statusCode).toBe(200);
    expect(hr.json().items.map((c: { kind: string }) => c.kind)).toEqual(["msa", "po"]);
    expect(hr.json().canAdd).toBe(false);
    expect((await call("acct", "GET", `/api/v1/placements/${placementId}/contracts`)).json().canAdd).toBe(true);
    expect((await call("l1", "GET", `/api/v1/placements/${placementId}/contracts`)).json().canAdd).toBe(true);
    expect((await call("coach", "GET", `/api/v1/placements/${placementId}/contracts`)).statusCode).toBe(403);
    expect((await call("r1b", "GET", `/api/v1/placements/${placementId}/contracts`)).statusCode).toBe(404);
    // Direct writes are refused (rule 6).
    await expect(asUser(db.app, U.l1, (c) => c.query(
      "INSERT INTO eureka.contract (placement_id, client_id, kind, title, created_by) SELECT id, client_id, 'po', 'x', $2 FROM eureka.placement WHERE id = $1",
      [placementId, U.l1]))).rejects.toThrow();
  });

  it("contract.created reaches HR, Associate HR and Accounts (email + inbox) with ids, the kind and a count only", async () => {
    const evs = await events("contract.created", (await db.admin.query<{ id: string }>(
      "SELECT id FROM eureka.contract WHERE placement_id = $1 AND kind = 'po'", [placementId])).rows[0]!.id);
    expect(evs.length).toBe(1);
    expect(Object.keys(evs[0]!.payload).sort()).toEqual(["candidateId", "contractCount", "contractId", "kind", "notify", "placementId"]);
    expect(evs[0]!.payload).toMatchObject({ placementId, candidateId, kind: "po", contractCount: 1, notify: ["hr", "associate_hr", "accounts"] });
    const r = await deliver(evs[0]!.id);
    expect(r.inbox.map((x) => x.recipient_id).sort()).toEqual([U.hr, ahr, U.acct].sort());
    expect(r.inbox[0]).toMatchObject({ title: "New contract: Purchase order", entity_type: "placement", entity_id: placementId });
    expect(r.mails.map((m) => m.to)).toEqual(["acct@eureka.example", "ahr@eureka.example", "hr@eureka.example"]);
    const texts = [...r.mails.map((m) => `${m.subject}\n${m.text}`), ...r.inbox.map((x) => `${x.title} ${x.body}`)];
    for (const t of texts) {
      expect(t).not.toMatch(/4471|Net 30|Rate card|PlCand|Placed|Northwind/);
      expect(t).toContain("Purchase order");
    }
    expect(r.mails.find((m) => m.to.startsWith("ahr"))!.text).toContain("You receive this email as a recipient of new contracts.");
    expect(r.mails.find((m) => m.to.startsWith("acct"))!.text).toContain(`Placement reference: ${placementId}`);
    // Audit: kind and dates, never the title, reference or notes.
    const a = await audits("contract.created");
    expect(a.length).toBe(2);
    expect(a[0]!.changes).toEqual({ placementId, kind: "po", referenceSet: true, startsOn: "2031-01-05", endsOn: "2031-06-30", notesSet: true });
  });

  it("the closure document types exist for placement documents", async () => {
    const types = await call("hr", "GET", "/api/v1/document-types");
    expect(types.statusCode).toBe(200);
    const keys = (types.json().items as { key: string; classification: string }[]).filter((t) => ["msa", "purchase_order", "sow"].includes(t.key));
    expect(keys.map((t) => t.classification)).toEqual(["internal", "internal", "internal"]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("staff birthdays and the CEO digest (BD-1..BD-5)", () => {
  const today = async () => (await db.admin.query<{ d: string }>("SELECT (now() AT TIME ZONE 'America/New_York')::date::text AS d")).rows[0]!.d;

  it("a staff member sets their own birthday in Settings; the year is never stored", async () => {
    const r = await call("r1a", "PUT", "/api/v1/settings/profile", { phone: null, bio: null, birthday: { month: 3, day: 14 } }, { "if-match": '"0"' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().birthday).toEqual({ month: 3, day: 14 });
    expect((await call("r1a", "PUT", "/api/v1/settings/profile", { phone: null, bio: null, birthday: { month: 2, day: 30 } }, { "if-match": '"1"' })).statusCode).toBe(422);
    expect((await call("r1a", "PUT", "/api/v1/settings/profile", { phone: null, bio: null, birthday: { month: 2, day: 29, year: 1990 } }, { "if-match": '"1"' })).statusCode).toBe(422);
    const kept = await call("r1a", "PUT", "/api/v1/settings/profile", { phone: null, bio: "hello" }, { "if-match": '"1"' });
    expect(kept.json().birthday).toEqual({ month: 3, day: 14 });
    expect((await audits("staff_profile.updated")).at(-1)!.changes).toEqual({ phoneSet: false, bioSet: true });
  });

  it("HR sets anyone's birthday and lists the staff; others may not", async () => {
    const d = (await today()).split("-").map(Number);
    const bd = { month: d[1]!, day: d[2]! };
    expect((await call("hr", "PUT", `/api/v1/staff/${U.ceo}/birthday`, { birthday: bd })).statusCode).toBe(200);
    expect((await call("hr", "PUT", `/api/v1/staff/${U.imm}/birthday`, { birthday: bd })).statusCode).toBe(200);
    expect((await call("hr", "PUT", `/api/v1/staff/${U.l1}/birthday`, { birthday: { month: 2, day: 29 } })).statusCode).toBe(200);
    expect((await call("r1a", "PUT", `/api/v1/staff/${U.ceo}/birthday`, { birthday: bd })).statusCode).toBe(403);
    expect((await call("admin", "PUT", `/api/v1/staff/${U.ceo}/birthday`, { birthday: bd })).statusCode).toBe(403);
    expect((await call("hr", "PUT", `/api/v1/staff/00000000-0000-0000-0000-00000000ffff/birthday`, { birthday: bd })).statusCode).toBe(404);
    const list = await call("hr", "GET", "/api/v1/staff/birthdays");
    expect(list.statusCode).toBe(200);
    const items = list.json().items as { id: string; name: string; roles: string[]; birthday: { month: number; day: number } | null }[];
    expect(items.find((i) => i.id === U.ceo)).toMatchObject({ name: "ceo", roles: ["CEO"], birthday: bd });
    expect(items.find((i) => i.id === U.r1a)!.birthday).toEqual({ month: 3, day: 14 });
    expect((await call("r1a", "GET", "/api/v1/staff/birthdays")).statusCode).toBe(403);
    expect((await audits("staff_birthday.updated")).map((a) => a.changes)).toEqual([{ birthdaySet: true }, { birthdaySet: true }, { birthdaySet: true }]);
    // HR writes only through the definer function; an admin cannot touch another profile row directly.
    const direct = await asUser(db.app, U.hr, async (c) =>
      (await c.query("UPDATE eureka.staff_profile SET birth_day = 1 WHERE user_id = $1", [U.ceo])).rowCount, true);
    expect(direct).toBe(0);
  });

  it("the birthday-digest job emits once per day for the people whose birthday it is, named in the CEO's email and inbox", async () => {
    const day = await today();
    const job = birthdayDigestJob();
    expect(await job.run(day, { ...workerCtx(), pool: db.worker })).toEqual({ emitted: 1 });
    expect(await job.run(day, { ...workerCtx(), pool: db.worker })).toEqual({ emitted: 0 });
    const ev = (await db.admin.query<{ id: string; payload: Record<string, unknown> }>(
      "SELECT id, payload FROM eureka.outbox_event WHERE type = 'staff.birthdays_today' ORDER BY created_at")).rows;
    expect(ev.length).toBe(1);
    expect(ev[0]!.payload).toEqual({ day, userIds: [U.ceo, U.imm], count: 2, notify: ["ceo"] });
    const r = await deliver(ev[0]!.id);
    expect(r.inbox.map((x) => x.recipient_id)).toEqual([U.ceo]);
    expect(r.inbox[0]).toMatchObject({ title: "2 staff birthdays today", entity_type: "digest", entity_id: ev[0]!.id });
    expect(r.inbox[0]!.body).toContain("Birthdays today: ceo, imm.");
    expect(r.mails.map((m) => m.to)).toEqual(["ceo@eureka.example"]);
    expect(r.mails[0]!.subject).toBe("Eureka: 2 staff birthdays today");
    expect(r.mails[0]!.text).toContain("Birthdays today: ceo, imm.");
    expect(r.mails[0]!.text).toContain("You receive this email as a recipient of the birthdays digest.");
    // A day without birthdays writes nothing; a future day is refused.
    expect((await db.worker.query("SELECT authz.emit_birthdays('2025-07-04'::date) AS n")).rows[0]!.n).toBe(0);
    await expect(db.worker.query("SELECT authz.emit_birthdays(($1::date + 1)::date)", [day])).rejects.toThrow();
  });

  it("29 February is celebrated on 28 February in a non-leap year only", async () => {
    expect((await db.worker.query("SELECT authz.emit_birthdays('2026-02-28'::date) AS n")).rows[0]!.n).toBe(1);
    const ev = (await db.admin.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM eureka.outbox_event WHERE type = 'staff.birthdays_today' AND payload ->> 'day' = '2026-02-28'")).rows[0]!;
    expect(ev.payload.userIds).toEqual([U.l1]);
    expect((await db.worker.query("SELECT authz.emit_birthdays('2024-02-28'::date) AS n")).rows[0]!.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe("support calendar (CA-1..CA-6, dev provider)", () => {
  let interviewId = "";
  const provider = () => app.get<DevCalendarProvider>(CALENDAR_PROVIDER);

  it("only calendar:block holders see the connection; a lead connects through the OAuth round trip", async () => {
    expect((await call("r1a", "GET", "/api/v1/calendar/support")).statusCode).toBe(403);
    expect((await call("hr", "GET", "/api/v1/calendar/support")).statusCode).toBe(403);
    const before = await call("l1", "GET", "/api/v1/calendar/support");
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({ mode: "dev", connected: false, calendarId: null, accountEmail: null });

    const start = await call("l1", "GET", "/api/v1/calendar/support/connect?calendarId=support@eureka.example");
    expect(start.statusCode).toBe(302);
    const location = new URL(String(start.headers.location));
    expect(location.pathname).toBe("/api/v1/calendar/support/callback");
    const stateCookie = String(start.headers["set-cookie"]).split(";")[0]!;
    const s = await login("l1");
    // Someone else's session cannot finish the round trip.
    const wrong = await app.inject({ method: "GET", url: `${location.pathname}${location.search}`, headers: { cookie: `${(await login("m1")).cookie}; ${stateCookie}` } });
    expect(wrong.statusCode).toBe(403);
    const done = await app.inject({ method: "GET", url: `${location.pathname}${location.search}`, headers: { cookie: `${s.cookie}; ${stateCookie}` } });
    expect(done.statusCode, done.body).toBe(302);
    const after = await call("m1", "GET", "/api/v1/calendar/support");
    expect(after.json()).toMatchObject({ connected: true, calendarId: "support@eureka.example", accountEmail: "support@eureka.example", connectedBy: { id: U.l1, name: "l1" } });
    // The token ciphertext is readable only to calendar:block holders (RLS), and never the plain token.
    const rows = await asUser(db.app, U.r1a, async (c) => (await c.query("SELECT count(*)::int AS n FROM eureka.calendar_connection")).rows[0]!.n);
    expect(rows).toBe(0);
    const enc = (await db.admin.query<{ t: string }>("SELECT token_enc AS t FROM eureka.calendar_connection")).rows[0]!.t;
    expect(enc).not.toContain("dev-refresh");
    expect((await audits("calendar.connected"))[0]!.changes).toEqual({ provider: "dev" });
  });

  it("a lead blocks the support calendar for an interview; readers see the block; release removes the event", async () => {
    const res = await call("r1a", "POST", "/api/v1/interviews", { submissionId: r1aInterview().submissionId, round: "Block me", startsAt: slot(), durationMin: 60 });
    expect(res.statusCode, res.body).toBe(201);
    interviewId = res.json().id;
    const status = await call("l1", "GET", `/api/v1/interviews/${interviewId}/calendar-block`);
    expect(status.json()).toEqual({ block: null, canBlock: true, connected: true });
    expect((await call("r1a", "GET", `/api/v1/interviews/${interviewId}/calendar-block`)).json()).toMatchObject({ block: null, canBlock: false });
    expect((await call("l3", "GET", `/api/v1/interviews/${interviewId}/calendar-block`)).statusCode).toBe(404);
    expect((await call("r1a", "POST", `/api/v1/interviews/${interviewId}/calendar-block`)).statusCode).toBe(403);

    const blocked = await call("l1", "POST", `/api/v1/interviews/${interviewId}/calendar-block`);
    expect(blocked.statusCode, blocked.body).toBe(201);
    expect(blocked.json().block).toMatchObject({ calendarId: "support@eureka.example", createdBy: { id: U.l1, name: "l1" } });
    const ev = [...provider().events.values()];
    expect(ev.length).toBe(1);
    expect(ev[0]!.summary).toContain("Block me");
    expect(ev[0]!.description).toContain("Client: Northwind");
    expect((await call("m1", "POST", `/api/v1/interviews/${interviewId}/calendar-block`)).statusCode).toBe(409);
    expect((await call("coord", "GET", `/api/v1/interviews/${interviewId}/calendar-block`)).json()).toMatchObject({ block: { calendarId: "support@eureka.example" }, canBlock: true });

    const released = await call("coord", "POST", `/api/v1/interviews/${interviewId}/calendar-block/release`);
    expect(released.statusCode, released.body).toBe(200);
    expect(released.json().block).toBeNull();
    expect(provider().events.size).toBe(0);
    expect((await call("l1", "POST", `/api/v1/interviews/${interviewId}/calendar-block/release`)).statusCode).toBe(404);
    const blocks = (await db.admin.query<{ status: string; released_by: string }>("SELECT status, released_by FROM eureka.calendar_block WHERE interview_id = $1", [interviewId])).rows;
    expect(blocks).toEqual([{ status: "released", released_by: coord }]);
    expect((await audits("calendar.blocked")).length).toBe(1);
    expect((await audits("calendar.released"))[0]!.changes).toEqual({ reachable: true });
  });

  it("a provider failure leaves no block; disconnecting stops blocking", async () => {
    provider().failNext = new Error("calendar event creation failed (503)");
    expect((await call("l1", "POST", `/api/v1/interviews/${interviewId}/calendar-block`)).statusCode).toBe(500);
    expect((await call("l1", "GET", `/api/v1/interviews/${interviewId}/calendar-block`)).json().block).toBeNull();
    expect((await call("l1", "POST", "/api/v1/calendar/support/disconnect")).json()).toMatchObject({ connected: false });
    expect((await call("l1", "POST", `/api/v1/interviews/${interviewId}/calendar-block`)).statusCode).toBe(422);
    expect((await call("l1", "POST", `/api/v1/interviews/${interviewId}/calendar-block`)).json().detail).toBe("calendar_not_connected");
  });

  it("the registry lists the three new types with the shared preference list", () => {
    for (const t of ["interview.requested", "contract.created", "staff.birthdays_today"]) expect(EVENT_SPECS[t]).toMatchObject({ email: true, inApp: true });
  });
});

// ---------------------------------------------------------------------------------------------

describe("support calendar free/busy (CA-7, dev provider)", () => {
  const provider = () => app.get<DevCalendarProvider>(CALENDAR_PROVIDER);
  /** The UTC day holding the instant, as the window the dialogs ask for. */
  const day = (iso: string) => {
    const d = new Date(iso);
    const from = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    return { from: from.toISOString(), to: new Date(+from + 86_400_000).toISOString() };
  };
  const busyUrl = (from: string, to: string) => `/api/v1/calendar/support/busy?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const auditCount = async () => (await db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM eureka.audit_event")).rows[0]!.n;
  /** The dev OAuth round trip as l1 (the connection was removed by the previous describe). */
  async function connect() {
    const start = await call("l1", "GET", "/api/v1/calendar/support/connect?calendarId=support@eureka.example");
    expect(start.statusCode).toBe(302);
    const location = new URL(String(start.headers.location));
    const stateCookie = String(start.headers["set-cookie"]).split(";")[0]!;
    const done = await app.inject({ method: "GET", url: `${location.pathname}${location.search}`, headers: { cookie: `${(await login("l1")).cookie}; ${stateCookie}` } });
    expect(done.statusCode, done.body).toBe(302);
  }

  it("whoever schedules or blocks interviews reads intervals only; a block makes the slot busy; nothing is audited", async () => {
    const startsAt = slot();
    const w = day(startsAt);
    expect((await call("r1a", "GET", busyUrl(w.from, w.to))).json()).toEqual({ connected: false, available: false, busy: [] });
    await connect();
    // interview:read alone (coach) or no interview permission (HR) is refused; a recruiter (interview:create own) and a coordinator are not.
    expect((await call("coach", "GET", busyUrl(w.from, w.to))).statusCode).toBe(403);
    expect((await call("hr", "GET", busyUrl(w.from, w.to))).statusCode).toBe(403);
    expect((await call("r1a", "GET", busyUrl(w.from, w.to))).json()).toEqual({ connected: true, available: true, busy: [] });
    expect((await call("coord", "GET", busyUrl(w.from, w.to))).json()).toEqual({ connected: true, available: true, busy: [] });
    // The recruiter still cannot read the connection table itself (CA-2): the definer function is the only path.
    expect(await asUser(db.app, U.r1a, async (c) => (await c.query("SELECT count(*)::int AS n FROM eureka.calendar_connection")).rows[0]!.n)).toBe(0);

    const res = await call("r1a", "POST", "/api/v1/interviews", { submissionId: r1aInterview().submissionId, round: "Busy me", startsAt, durationMin: 60 });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().id as string;
    expect((await call("l1", "POST", `/api/v1/interviews/${id}/calendar-block`)).statusCode).toBe(201);
    expect(provider().events.size).toBe(1);
    const before = await auditCount();
    const busy = await call("r1a", "GET", busyUrl(w.from, w.to));
    expect(busy.statusCode, busy.body).toBe(200);
    expect(busy.json()).toEqual({ connected: true, available: true, busy: [{ startsAt, endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString() }] });
    // Intervals only (rule 5): no summary, description, candidate or client.
    expect(busy.body).not.toMatch(/Busy me|Northwind|summary|description|support@/);
    // Another day: free. Reads leave no audit row.
    expect((await call("r1a", "GET", busyUrl(w.to, new Date(Date.parse(w.to) + 86_400_000).toISOString()))).json().busy).toEqual([]);
    expect(await auditCount()).toBe(before);

    // The window: `to` after `from`, at most 31 days, both required.
    expect((await call("r1a", "GET", busyUrl(w.to, w.from))).statusCode).toBe(422);
    expect((await call("r1a", "GET", busyUrl(w.from, new Date(Date.parse(w.from) + 32 * 86_400_000).toISOString()))).statusCode).toBe(422);
    expect((await call("r1a", "GET", "/api/v1/calendar/support/busy")).statusCode).toBe(422);
    expect((await call("r1a", "GET", busyUrl(w.from, new Date(Date.parse(w.from) + 31 * 86_400_000).toISOString()))).statusCode).toBe(200);

    expect((await call("l1", "POST", `/api/v1/interviews/${id}/calendar-block/release`)).statusCode).toBe(200);
    expect((await call("r1a", "GET", busyUrl(w.from, w.to))).json().busy).toEqual([]);
  });

  it("a connection made before the free/busy scope answers available: false until it is reconnected", async () => {
    await asUser(db.app, U.l1, (c) => c.query("UPDATE eureka.calendar_connection SET scopes = '' WHERE key = 'support'"), true);
    expect((await call("l1", "GET", "/api/v1/calendar/support")).json()).toMatchObject({ connected: true, freeBusy: false });
    const w = day(slot());
    expect((await call("r1a", "GET", busyUrl(w.from, w.to))).json()).toEqual({ connected: true, available: false, busy: [] });
    await connect();
    expect((await call("l1", "GET", "/api/v1/calendar/support")).json()).toMatchObject({ connected: true, freeBusy: true });
    expect((await db.admin.query<{ s: string }>("SELECT scopes AS s FROM eureka.calendar_connection")).rows[0]!.s).toContain("auth/calendar.freebusy");
    expect((await call("r1a", "GET", busyUrl(w.from, w.to))).json()).toEqual({ connected: true, available: true, busy: [] });
  });
});
