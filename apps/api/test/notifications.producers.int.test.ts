import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalMail } from "../src/worker/feedback-mail.js";
import { assignmentEndingSoonJob } from "../src/worker/jobs/assignment-ending-soon.js";
import { benchTimeJob } from "../src/worker/jobs/notifications.js";
import { outboxDeliveryJob } from "../src/worker/jobs/outbox.js";
import { paperworkOverdueJob } from "../src/worker/jobs/paperwork-overdue.js";
import { visaExpiryJob } from "../src/worker/jobs/visa-expiry.js";
import { silentLogger } from "../src/worker/log.js";
import { JobRunner } from "../src/worker/runner.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { asActor, backdate, force, joinedEmployee, type Joined } from "./employee-seed.js";
import { LOC, T, U, seedFixtures } from "./fixtures.js";
import { createPlacement, newCandidate, selectedSubmission } from "./placement-seed.js";
import { workerCtx } from "./notification-seed.js";

/**
 * End to end: the merged producers (0042 visa-expiry job, 0045 employment
 * functions and the assignment-ending-soon job, 0046 bench-time job) write
 * their real outbox rows, and the outbox-delivery job (local mail mode)
 * delivers them: inbox rows for the type's recipients and one email each,
 * with no personal data. Proves the producer shapes match the registry.
 */
let db: TestDb;
let mailDir: string;
let today: string;
const ORIGIN = "https://eureka.example";
let bu = "";

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  bu = (await db.admin.query<{ id: string }>(
    "INSERT INTO eureka.app_user (email, display_name) VALUES ('bu@eureka.example', 'bu') RETURNING id")).rows[0]!.id;
  await db.admin.query("INSERT INTO eureka.user_role (user_id, role_key) VALUES ($1, 'bu_head')", [bu]);
  mailDir = await mkdtemp(join(tmpdir(), "eureka-ntf-mail-"));
  today = (await db.admin.query<{ d: string }>("SELECT CURRENT_DATE::text AS d")).rows[0]!.d;
}, 120_000);

afterAll(async () => {
  await db?.drop();
  if (mailDir) await rm(mailDir, { recursive: true, force: true });
});

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Events of `type` for the aggregate, oldest first. */
const eventsOf = async (type: string, aggregate: string) => (await db.admin.query<{ id: string; payload: Record<string, unknown> }>(
  "SELECT id, payload FROM eureka.outbox_event WHERE type = $1 AND aggregate_id = $2 ORDER BY created_at", [type, aggregate])).rows;

/** Runs the delivery job (local mail) for one event; returns its inbox recipients and the emails written for it. */
async function deliver(eventId: string) {
  const job = outboxDeliveryJob(new LocalMail(mailDir), ORIGIN, { batchSize: 500 });
  const keys = await job.dueKeys(new Date(), { pool: db.worker, log: silentLogger });
  expect(keys).toContain(eventId);
  expect(await new JobRunner(db.worker, [job], silentLogger).runOnce(job, eventId)).toBe("ran");
  const inbox = (await db.admin.query<{ recipient_id: string; title: string; body: string; entity_type: string; entity_id: string }>(
    "SELECT recipient_id, title, body, entity_type, entity_id FROM eureka.notification WHERE event_id = $1 ORDER BY recipient_id", [eventId])).rows;
  const files = (await readdir(mailDir)).filter((f) => f.startsWith(eventId));
  const mails = await Promise.all(files.map(async (f) => JSON.parse(await readFile(join(mailDir, f), "utf8")) as { to: string; subject: string; text: string }));
  const published = (await db.admin.query("SELECT published_at FROM eureka.outbox_event WHERE id = $1", [eventId])).rows[0]!.published_at;
  return { inbox, to: mails.map((m) => m.to).sort(), mails, published };
}

/** Names, contact details and other values that must never reach an email or an inbox row. */
async function personalData(candidateId: string): Promise<string[]> {
  const p = (await db.admin.query<{ first_name: string; last_name: string }>(
    "SELECT p.first_name, p.last_name FROM eureka.candidate c JOIN eureka.person p ON p.id = c.person_id WHERE c.id = $1", [candidateId])).rows[0]!;
  return [p.first_name, p.last_name, "Northwind", "Team Rohit", "r1a@", "SECRET"];
}
function expectClean(texts: string[], secrets: string[]) {
  expect(texts.length).toBeGreaterThan(0);
  for (const t of texts) for (const s of secrets) expect(t, s).not.toContain(s);
}

const ROLES_EXIT = ["acct@eureka.example", "bu@eureka.example", "ceo@eureka.example", "hr@eureka.example", "imm@eureka.example"];

describe("producers delivered end to end (inbox + local email)", () => {
  it("0042 visa-expiry job: work_authorization.expiring to HR and Immigration", async () => {
    const cand = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
    const nyDay = (await db.admin.query<{ d: string }>(
      "SELECT ((now() AT TIME ZONE 'America/New_York')::date + 45)::text AS d")).rows[0]!.d;
    const waId = randomUUID();
    await asUser(db.app, U.imm, (c) => c.query("SELECT authz.work_auth_create($1, $2, 'h4_ead', NULL, NULL, NULL, NULL, $3::date, 'valid')",
      [waId, cand.id, nyDay]), true);
    await visaExpiryJob([90, 60, 30]).run("label", { ...workerCtx(), pool: db.worker });
    const [ev] = await eventsOf("work_authorization.expiring", waId);
    expect(ev!.payload).toMatchObject({ candidate_id: cand.id, threshold_days: 60, days_left: 45 });
    const r = await deliver(ev!.id);
    expect(r.inbox.map((x) => x.recipient_id)).toEqual([U.hr, U.imm].sort());
    expect(r.inbox[0]).toMatchObject({ title: "Work authorization expires within 60 days", entity_type: "candidate", entity_id: cand.id });
    expect(r.to).toEqual(["hr@eureka.example", "imm@eureka.example"]);
    expect(r.published).not.toBeNull();
    expectClean([...r.mails.map((m) => `${m.subject}\n${m.text}`), ...r.inbox.map((x) => `${x.title} ${x.body}`)],
      [...await personalData(cand.id), nyDay, "h4_ead", "H-4"]);
  });

  let j: Joined;
  it("0045 end_assignment: employee.benched (project exit) to admin teams, BU and CEO", async () => {
    j = await joinedEmployee(db);
    await backdate(db, j, addDays(today, -60));
    const end = addDays(today, -1);
    await asActor(db, U.hr, "SELECT * FROM authz.end_assignment($1, $2::date, 'terminated')", [j.assignmentId, end]);
    const [ev] = await eventsOf("employee.benched", j.personId);
    const r = await deliver(ev!.id);
    expect(r.inbox.map((x) => x.recipient_id)).toEqual([U.hr, U.acct, U.imm, bu, U.ceo].sort());
    expect(r.inbox[0]).toMatchObject({ title: "Project assignment ended", entity_type: "placement", entity_id: j.placementId });
    expect(r.to).toEqual(ROLES_EXIT);
    expect(r.mails[0]!.text).toContain(`Placement reference: ${j.placementId}`);
    expectClean([...r.mails.map((m) => `${m.subject}\n${m.text}`), ...r.inbox.map((x) => `${x.title} ${x.body}`)],
      [...await personalData(j.candidateId), end, "terminated"]);
  });

  it("0045 exit_employee: employee.exited to admin teams, BU and CEO", async () => {
    await asActor(db, U.hr, "SELECT * FROM authz.exit_employee($1, $2::date, 'resigned')", [j.personId, today]);
    const [ev] = await eventsOf("employee.exited", j.personId);
    const r = await deliver(ev!.id);
    expect(r.inbox.map((x) => x.recipient_id)).toEqual([U.hr, U.acct, U.imm, bu, U.ceo].sort());
    expect(r.inbox[0]).toMatchObject({ title: "Employee exit recorded", entity_type: "candidate", entity_id: j.candidateId });
    expect(r.to).toEqual(ROLES_EXIT);
    expectClean([...r.mails.map((m) => `${m.subject}\n${m.text}`), ...r.inbox.map((x) => `${x.title} ${x.body}`)],
      [...await personalData(j.candidateId), "resigned"]);
  });

  it("0045 assignment-ending-soon job: assignment.ending_soon to HR and Accounts, inbox only", async () => {
    const k = await joinedEmployee(db);
    const planned = addDays(today, 10);
    await asActor(db, U.hr, "SELECT * FROM authz.set_assignment_end_date($1, $2::date)", [k.assignmentId, planned]);
    await assignmentEndingSoonJob(30).run("label", { ...workerCtx(), pool: db.worker });
    const [ev] = await eventsOf("assignment.ending_soon", k.assignmentId);
    expect(ev!.payload).toMatchObject({ daysLeft: 10, plannedEndDate: planned });
    const r = await deliver(ev!.id);
    expect(r.inbox.map((x) => x.recipient_id)).toEqual([U.hr, U.acct].sort());
    expect(r.inbox[0]).toMatchObject({ title: "Project assignment ends within 10 days", entity_type: "placement", entity_id: k.placementId });
    expect(r.to).toEqual([]);
    expect(r.published).not.toBeNull();
    expectClean(r.inbox.map((x) => `${x.title} ${x.body}`), [...await personalData(k.candidateId), planned]);
  });

  it("0052 paperwork-overdue job: checklist.item_overdue to recruiter, lead, manager and a documents_team assignee", async () => {
    await db.admin.query(`INSERT INTO authz.checklist_template (kind, placement_type, items) VALUES ('paperwork', 'w2', $1::jsonb)`,
      [JSON.stringify([{ doc_type: "sample_overdue_doc", owner_role: "documents_team" }])]);
    const docs = (await db.admin.query<{ id: string }>(
      "INSERT INTO eureka.app_user (email, display_name) VALUES ('docs@eureka.example', 'docs') RETURNING id")).rows[0]!.id;
    await db.admin.query("INSERT INTO eureka.user_role (user_id, role_key) VALUES ($1, 'documents_team')", [docs]);
    const cand = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
    const sub = await selectedSubmission(db, U.r1a, cand.id);
    const p = await createPlacement(db, U.r1a, sub, { type: "w2" });
    const item = (await db.admin.query<{ id: string }>("SELECT id FROM eureka.checklist_item WHERE placement_id = $1", [p.id])).rows[0]!.id;
    const dueOn = addDays(today, -5);
    await asUser(db.app, U.hr, (c) => c.query("SELECT authz.update_checklist_item($1, $2::jsonb, NULL)",
      [item, JSON.stringify({ dueOn, assigneeId: docs, notes: "SECRET fictional note" })]), true);
    const nyToday = (await db.admin.query<{ d: string }>("SELECT (now() AT TIME ZONE 'America/New_York')::date::text AS d")).rows[0]!.d;
    await paperworkOverdueJob().run(nyToday, { ...workerCtx(), pool: db.worker });
    const [ev] = await eventsOf("checklist.item_overdue", item);
    expect(Object.keys(ev!.payload).sort()).toEqual(["assigneeId", "checklistItemId", "daysOverdue", "placementId"]);
    expect(ev!.payload).toMatchObject({ checklistItemId: item, placementId: p.id, assigneeId: docs });
    const r = await deliver(ev!.id);
    expect(r.inbox.map((x) => x.recipient_id)).toEqual([U.r1a, U.l1, U.m1, docs].sort());
    expect(r.inbox[0]).toMatchObject({ title: "Paperwork item overdue", entity_type: "placement", entity_id: p.id });
    expect(r.to).toEqual(["docs@eureka.example", "l1@eureka.example", "m1@eureka.example", "r1a@eureka.example"]);
    expect(r.published).not.toBeNull();
    expectClean([...r.mails.map((m) => `${m.subject}\n${m.text}`), ...r.inbox.map((x) => `${x.title} ${x.body}`)],
      [...await personalData(cand.id), dueOn, "sample_overdue_doc", "Sample overdue doc", "documents_team"]);
    // Re-running the day is a no-op (once per item and due date).
    await paperworkOverdueJob().run(nyToday, { ...workerCtx(), pool: db.worker });
    expect(await eventsOf("checklist.item_overdue", item)).toHaveLength(1);
  });

  it("0046 bench-time job: employee.bench_time to recruiter, lead, manager and CEO (not employee.benched)", async () => {
    const cand = await newCandidate(db, { teamId: T.t2, recruiterId: U.r2a, locationId: LOC.austin });
    await force(db, "UPDATE eureka.candidate SET marketing_status = 'bench', bench_since = $2 WHERE id = $1", [cand.id, addDays(today, -32)]);
    const nyToday = (await db.admin.query<{ d: string }>("SELECT (now() AT TIME ZONE 'America/New_York')::date::text AS d")).rows[0]!.d;
    await benchTimeJob(30).run(nyToday, { ...workerCtx(), pool: db.worker });
    expect(await eventsOf("employee.benched", cand.id)).toEqual([]);
    const [ev] = await eventsOf("employee.bench_time", cand.id);
    const r = await deliver(ev!.id);
    expect(r.inbox.map((x) => x.recipient_id)).toEqual([U.r2a, U.l2, U.m1, U.ceo].sort());
    expect(r.to).toEqual(["ceo@eureka.example", "l2@eureka.example", "m1@eureka.example", "r2a@eureka.example"]);
    expectClean([...r.mails.map((m) => `${m.subject}\n${m.text}`), ...r.inbox.map((x) => `${x.title} ${x.body}`)],
      [...await personalData(cand.id), addDays(today, -32)]);
  });
});
