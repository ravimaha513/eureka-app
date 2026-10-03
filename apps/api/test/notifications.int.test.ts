import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadWorkerConfig } from "../src/worker/config.js";
import { MailRejected, type Mail, type MailTransport } from "../src/worker/feedback-mail.js";
import { BENCH_TIME_JOB, benchTimeJob, notificationPruneJob, pruneNotifications } from "../src/worker/jobs/notifications.js";
import { deliverEvent, dueOutboxEvents, outboxDeliveryJob } from "../src/worker/jobs/outbox.js";
import { silentLogger } from "../src/worker/log.js";
import { EVENT_SPECS, renderEmail } from "../src/worker/notify-types.js";
import { JobRunner } from "../src/worker/runner.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, U, seedFixtures } from "./fixtures.js";
import { deliverInbox, emitEvent, newId, workerCtx as ctx } from "./notification-seed.js";
import { createPlacement, newCandidate, selectedSubmission } from "./placement-seed.js";

/**
 * Notifications (migration 0046; docs/notifications.md): in-app inbox table and
 * its RLS, recipients per event type, the generalised outbox delivery (email
 * and inbox channels, at-most-once email, in_doubt), the bench-time reminder
 * and the inbox prune under a fixed clock (time travel).
 */
let db: TestDb;
const ORIGIN = "https://eureka.example";
const X: Record<string, string> = {};

class FakeMail implements MailTransport {
  sent: Mail[] = [];
  constructor(private readonly fail: (m: Mail) => Error | null = () => null) {}
  async send(m: Mail) {
    const err = this.fail(m);
    if (err) throw err;
    this.sent.push(m);
  }
  to() { return this.sent.map((m) => m.to).sort(); }
}

/** Superuser write with triggers off (time travel in test setup only). */
async function force(sql: string, params: unknown[] = []) {
  const c = await db.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query(sql, params);
    await c.query("COMMIT");
  } finally {
    c.release();
  }
}

const err = (p: Promise<unknown>) => p.then(() => "allowed", (e: Error) => e.message);
const denied = (pool: pg.Pool, sql: string, params: unknown[] = []) => err(pool.query(sql, params));
const rows = async <R extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await db.admin.query<R>(sql, params)).rows;

async function addUser(key: string, role: string | null, status = "active") {
  const r = await db.admin.query<{ id: string }>(
    "INSERT INTO eureka.app_user (email, display_name, status) VALUES ($1, $2, $3) RETURNING id", [`${key}@eureka.example`, key, status]);
  if (role) await db.admin.query("INSERT INTO eureka.user_role (user_id, role_key) VALUES ($1, $2)", [r.rows[0]!.id, role]);
  X[key] = r.rows[0]!.id;
}

/** Recipient ids (sorted) and reasons of an event, as the worker resolves them. */
async function recipients(eventId: string) {
  const r = await db.worker.query<{ recipient_id: string; reason: string }>(
    "SELECT recipient_id, reason FROM authz.notification_recipients($1) ORDER BY recipient_id, reason", [eventId]);
  return r.rows.map((x) => `${x.recipient_id}:${x.reason}`);
}
const ids = (pairs: [string, string][]) => pairs.map(([u, why]) => `${u}:${why}`).sort();

const inbox = async (eventId: string) => (await rows<{ recipient_id: string }>(
  "SELECT recipient_id FROM eureka.notification WHERE event_id = $1 ORDER BY recipient_id", [eventId])).map((r) => r.recipient_id);
const publishedAt = async (eventId: string) =>
  (await rows("SELECT published_at FROM eureka.outbox_event WHERE id = $1", [eventId]))[0]?.published_at ?? null;

/** A bench candidate (team t1, recruiter r1a) benched since `since`. */
async function benchCandidate(since: string, team = T.t1, recruiter: string | null = U.r1a) {
  const c = await newCandidate(db, { teamId: team, recruiterId: recruiter, locationId: LOC.dallas });
  await force("UPDATE eureka.candidate SET marketing_status = 'bench', bench_since = $2 WHERE id = $1", [c.id, since]);
  return c.id;
}

/** A placement by r1a (team t1). */
async function placement() {
  const cand = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
  const sub = await selectedSubmission(db, U.r1a, cand.id);
  const p = await createPlacement(db, U.r1a, sub, { rate: 81.25, city: "Irving",
    contacts: [{ kind: "vendor_poc", name: "Petra Poc", email: "petra@vendor.example", phone: "+14695550188" }] });
  return { placementId: p.id, candidateId: cand.id };
}

const PAYLOADS = {
  // Shapes of the merged producers (0042 visa-expiry, 0045 employees); see docs/notifications.md.
  workAuth: (cand: string, person: string) => ({ candidate_id: cand, person_id: person, expires_on: "2027-01-15",
    threshold_days: 60, days_left: 45, notify: ["hr", "immigration"] }),
  projectExit: (a: string, p: string, cand: string) => ({ personId: a, candidateId: cand, assignmentId: a, placementId: p,
    endDate: "2026-09-30", endReason: "terminated", notify: ["hr", "accounts", "immigration", "bu_head", "ceo"] }),
  exited: (person: string, a: string, cand: string) => ({ personId: person, candidateId: cand, lastAssignmentId: a,
    exitDate: "2026-09-29", exitReason: "resigned", notify: ["hr", "accounts", "immigration", "bu_head", "ceo"] }),
  endingSoon: (a: string, p: string, cand: string) => ({ assignmentId: a, placementId: p, personId: a, candidateId: cand,
    plannedEndDate: "2026-11-01", daysLeft: 30, notify: ["hr", "accounts"] }),
  benchTime: (cand: string) => ({ candidateId: cand, benchSince: "2026-05-01", benchDays: 45, thresholdDays: 30 }),
  assigned: (cand: string, team: string, from?: string) => ({ candidateId: cand, teamId: team, ...(from ? { fromTeamId: from } : {}) }),
  overdue: (item: string, p: string, assignee?: string) => ({ checklistItemId: item, placementId: p, daysOverdue: 3, ...(assignee ? { assigneeId: assignee } : {}) }),
};

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  await addUser("bu", "bu_head");
  await addUser("docs", "documents_team");
  await addUser("ahr", "associate_hr");
  await addUser("gonehr", "hr", "inactive");
  await addUser("goneceo", "ceo", "inactive");
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

// ---------------------------------------------------------------------------------------------

describe("recipients per event type (authz.notification_recipients)", () => {
  it("role-based types reach exactly the role holders who are active now", async () => {
    const cand = (await newCandidate(db, { teamId: T.t2, recruiterId: U.r2a, locationId: LOC.austin })).id;
    const { placementId } = await placement();
    const a = await newId(db);
    const wa = await emitEvent(db, "work_authorization.expiring", "work_authorization", await newId(db), PAYLOADS.workAuth(cand, await newId(db)));
    expect(await recipients(wa)).toEqual(ids([[U.hr, "hr"], [U.imm, "immigration"]]));
    const ex = await emitEvent(db, "employee.benched", "employee", a, PAYLOADS.projectExit(a, placementId, cand));
    expect(await recipients(ex)).toEqual(ids([[U.hr, "hr"], [U.acct, "accounts"], [U.imm, "immigration"], [X.bu!, "bu_head"], [U.ceo, "ceo"]]));
    const left = await emitEvent(db, "employee.exited", "employee", a, PAYLOADS.exited(a, a, cand));
    expect(await recipients(left)).toEqual(ids([[U.hr, "hr"], [U.acct, "accounts"], [U.imm, "immigration"], [X.bu!, "bu_head"], [U.ceo, "ceo"]]));
    const es = await emitEvent(db, "assignment.ending_soon", "assignment", a, PAYLOADS.endingSoon(a, placementId, cand));
    expect(await recipients(es)).toEqual(ids([[U.hr, "hr"], [U.acct, "accounts"]]));
  });

  it("bench-time reaches the candidate's recruiter, team lead, the lead's manager and the CEO", async () => {
    const t1 = await benchCandidate("2026-05-01");
    const ev = await emitEvent(db, "employee.bench_time", "candidate", t1, PAYLOADS.benchTime(t1));
    expect(await recipients(ev)).toEqual(ids([[U.r1a, "recruiter"], [U.l1, "lead"], [U.m1, "manager"], [U.ceo, "ceo"]]));
    // Another team: its own lead and manager; an unassigned recruiter adds nobody.
    const t3 = await benchCandidate("2026-05-01", T.t3, null);
    const ev3 = await emitEvent(db, "employee.bench_time", "candidate", t3, PAYLOADS.benchTime(t3));
    expect(await recipients(ev3)).toEqual(ids([[U.l3, "lead"], [U.m2, "manager"], [U.ceo, "ceo"]]));
  });

  it("team-assigned reaches the new team's lead and that lead's manager only", async () => {
    const cand = (await newCandidate(db, { teamId: T.t2, recruiterId: U.r2a, locationId: LOC.dallas })).id;
    const ev = await emitEvent(db, "candidate.assigned", "candidate", cand, PAYLOADS.assigned(cand, T.t2, T.t1));
    expect(await recipients(ev)).toEqual(ids([[U.l2, "lead"], [U.m1, "manager"]]));
    // The payload's team must be the candidate's current team (0051): a team it is not in reaches nobody.
    const ev3 = await emitEvent(db, "candidate.assigned", "candidate", cand, PAYLOADS.assigned(cand, T.t3));
    expect(await recipients(ev3)).toEqual([]);
    await force("UPDATE eureka.candidate SET team_id = $2, recruiter_id = NULL WHERE id = $1", [cand, T.t3]);
    expect(await recipients(ev3)).toEqual(ids([[U.l3, "lead"], [U.m2, "manager"]]));
    expect(await recipients(ev)).toEqual([]);                                     // stale: the candidate moved on
  });

  it("paperwork overdue reaches the placement's recruiter, lead and manager, plus a Documents Team assignee", async () => {
    const { placementId } = await placement();
    const item = await newId(db);
    const ev = await emitEvent(db, "checklist.item_overdue", "checklist_item", item, PAYLOADS.overdue(item, placementId, X.docs));
    expect(await recipients(ev)).toEqual(ids([[U.r1a, "recruiter"], [U.l1, "lead"], [U.m1, "manager"], [X.docs!, "documents_team"]]));
    // An assignee who is not on the Documents Team is ignored.
    const ev2 = await emitEvent(db, "checklist.item_overdue", "checklist_item", item, PAYLOADS.overdue(item, placementId, U.r2a));
    expect(await recipients(ev2)).toEqual(ids([[U.r1a, "recruiter"], [U.l1, "lead"], [U.m1, "manager"]]));
  });

  it("placement events keep their notify groups; unknown, published or missing events have none", async () => {
    const { placementId } = await placement();
    const pc = (await rows<{ id: string }>(
      "SELECT id FROM eureka.outbox_event WHERE aggregate_id = $1 AND type = 'placement.created'", [placementId]))[0]!.id;
    expect(await recipients(pc)).toEqual(ids([[U.hr, "hr"], [U.acct, "accounts"], [U.imm, "immigration"]]));
    const unknown = await emitEvent(db, "something.else", "candidate", placementId, { candidateId: placementId });
    expect(await recipients(unknown)).toEqual([]);
    expect(await recipients(await newId(db))).toEqual([]);
    await db.worker.query("UPDATE eureka.outbox_event SET published_at = now() WHERE id = $1", [unknown]);
    expect(await recipients(unknown)).toEqual([]);
    // Inactive users and ended roles never appear (gonehr, goneceo are seeded inactive).
    for (const r of await recipients(pc)) expect(r).not.toMatch(new RegExp(`${X.gonehr}|${X.goneceo}`));
  });

  it("the p_user filter answers for one user (the re-check before a send)", async () => {
    const cand = await benchCandidate("2026-05-01");
    const ev = await emitEvent(db, "employee.bench_time", "candidate", cand, PAYLOADS.benchTime(cand));
    const one = await db.worker.query("SELECT recipient_id, reason FROM authz.notification_recipients($1, $2)", [ev, U.l1]);
    expect(one.rows).toEqual([{ recipient_id: U.l1, reason: "lead" }]);
    expect((await db.worker.query("SELECT 1 FROM authz.notification_recipients($1, $2)", [ev, U.r2a])).rowCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe("delivery: inbox and email channels", () => {
  it("an in-app-only event is delivered exactly once to the inbox and published, without email", async () => {
    const { placementId, candidateId } = await placement();
    const a = await newId(db);
    const ev = await emitEvent(db, "assignment.ending_soon", "assignment", a, PAYLOADS.endingSoon(a, placementId, candidateId));
    const mail = new FakeMail();
    const r = await deliverEvent(db.worker, mail, ORIGIN, ev, ctx());
    expect(r).toEqual({ alreadyPublished: false, recipients: 2, sent: 0, skipped: 0, inDoubt: 0, failed: 0, inApp: 2 });
    expect(mail.sent).toHaveLength(0);
    expect(await inbox(ev)).toEqual([U.hr, U.acct].sort());
    expect(await publishedAt(ev)).not.toBeNull();
    const n = await rows("SELECT title, body, entity_type, entity_id, read_at FROM eureka.notification WHERE event_id = $1 AND recipient_id = $2", [ev, U.hr]);
    expect(n).toEqual([{ title: "Project assignment ends within 30 days", body: "A project assignment is ending soon. Open the placement for the details.",
      entity_type: "placement", entity_id: placementId, read_at: null }]);
    expect((await deliverEvent(db.worker, mail, ORIGIN, ev, ctx())).alreadyPublished).toBe(true);
    expect(await inbox(ev)).toHaveLength(2);
  });

  it("with mail disabled an emailing event gets its inbox rows once and waits; with mail it emails each recipient once", async () => {
    const { placementId, candidateId } = await placement();
    const a = await newId(db);
    const ev = await emitEvent(db, "employee.benched", "employee", a, PAYLOADS.projectExit(a, placementId, candidateId));
    const noMail = outboxDeliveryJob(null, null, { batchSize: 500 });
    const keys = await noMail.dueKeys(new Date(), { pool: db.worker, log: silentLogger });
    expect(keys).toContain(`inbox:${ev}`);
    expect(keys).not.toContain(ev);
    const runner = new JobRunner(db.worker, [noMail], silentLogger);
    expect(await runner.runOnce(noMail, `inbox:${ev}`)).toBe("ran");
    const expected = [U.hr, U.acct, U.imm, X.bu!, U.ceo].sort();
    expect(await inbox(ev)).toEqual(expected);
    expect(await publishedAt(ev)).toBeNull();
    expect(await noMail.dueKeys(new Date(), { pool: db.worker, log: silentLogger })).not.toContain(`inbox:${ev}`);
    // A full run without a transport refuses to record success (the email part would be lost).
    await expect(deliverEvent(db.worker, null, null, ev, ctx())).rejects.toThrow(/not configured/);

    const mail = new FakeMail();
    const withMail = outboxDeliveryJob(mail, ORIGIN, { batchSize: 500 });
    expect(await withMail.dueKeys(new Date(), { pool: db.worker, log: silentLogger })).toContain(ev);
    expect(await new JobRunner(db.worker, [withMail], silentLogger).runOnce(withMail, ev)).toBe("ran");
    expect(mail.to()).toEqual(["acct@eureka.example", "bu@eureka.example", "ceo@eureka.example", "hr@eureka.example", "imm@eureka.example"]);
    expect(await inbox(ev)).toEqual(expected);                 // no second inbox row
    expect(await publishedAt(ev)).not.toBeNull();
    const ceo = mail.sent.find((m) => m.to === "ceo@eureka.example")!;
    expect(ceo.subject).toBe("Eureka: project assignment ended");
    expect(ceo.text).toContain(`Placement reference: ${placementId}`);
    expect(ceo.text).toContain("You receive this email as the CEO.");
    expect(mail.sent.find((m) => m.to === "hr@eureka.example")!.text).toContain("as a member of HR.");
  });

  it("email stays at most once per recipient for the new types: unknown outcome is in doubt and never resent", async () => {
    const cand = await benchCandidate("2026-04-01");
    const ev = await emitEvent(db, "employee.bench_time", "candidate", cand, PAYLOADS.benchTime(cand));
    const mail = new FakeMail((m) => (m.to === "l1@eureka.example" ? new Error("socket hang up") : null));
    const r = await deliverEvent(db.worker, mail, ORIGIN, ev, ctx());
    expect(r).toMatchObject({ recipients: 4, sent: 3, inDoubt: 1, inApp: 4 });
    expect(await publishedAt(ev)).not.toBeNull();
    const st = await rows<{ user_id: string; status: string }>("SELECT user_id, status FROM eureka.outbox_delivery WHERE event_id = $1", [ev]);
    expect(st.find((x) => x.user_id === U.l1)!.status).toBe("in_doubt");
    expect(mail.to()).toEqual(["ceo@eureka.example", "m1@eureka.example", "r1a@eureka.example"]);
    expect(mail.sent.find((m) => m.to === "m1@eureka.example")!.text).toContain("as the team lead's manager.");
  });

  it("a crash after the provider accepted leaves the row sending; the next run marks it in doubt, no second email or inbox row", async () => {
    const cand = (await newCandidate(db, { teamId: T.t1, recruiterId: U.r1b, locationId: LOC.dallas })).id;
    const ev = await emitEvent(db, "candidate.assigned", "candidate", cand, PAYLOADS.assigned(cand, T.t1));
    const mail = new FakeMail();
    const crashing = {
      connect: () => db.worker.connect(),
      query: (sql: string, params?: unknown[]) => (sql.includes("SET status = $3")
        ? Promise.reject(new Error("connection terminated")) : db.worker.query(sql, params)),
    } as unknown as pg.Pool;
    await expect(deliverEvent(crashing, mail, ORIGIN, ev, ctx())).rejects.toThrow(/connection terminated/);
    expect(mail.sent).toHaveLength(1);
    await force("UPDATE eureka.outbox_delivery SET attempt_at = now() - interval '3 minutes' WHERE event_id = $1 AND status = 'sending'", [ev]);
    const r = await deliverEvent(db.worker, mail, ORIGIN, ev, ctx());
    expect(r).toMatchObject({ sent: 1, inDoubt: 1, inApp: 2 });
    expect(mail.to()).toEqual(["l1@eureka.example", "m1@eureka.example"]);
    expect(await inbox(ev)).toEqual([U.l1, U.m1].sort());
  });

  it("a provider rejection retries that recipient only; recipients who left are skipped", async () => {
    const { placementId } = await placement();
    const item = await newId(db);
    const ev = await emitEvent(db, "checklist.item_overdue", "checklist_item", item, PAYLOADS.overdue(item, placementId, X.docs));
    let reject = true;
    const mail = new FakeMail((m) => (reject && m.to === "docs@eureka.example" ? new MailRejected("bad") : null));
    await expect(deliverEvent(db.worker, mail, ORIGIN, ev, ctx())).rejects.toThrow(/retry pending/);
    expect(await publishedAt(ev)).toBeNull();
    // The assignee leaves the Documents Team before the retry: skipped, not emailed.
    await db.admin.query("UPDATE eureka.user_role SET valid = tstzrange(lower(valid), now()) WHERE user_id = $1", [X.docs]);
    try {
      reject = false;
      const r = await deliverEvent(db.worker, mail, ORIGIN, ev, ctx());
      expect(r).toMatchObject({ recipients: 4, sent: 3, skipped: 1, inApp: 4 });
      expect(mail.to()).toEqual(["l1@eureka.example", "m1@eureka.example", "r1a@eureka.example"]);
    } finally {
      await db.admin.query("INSERT INTO eureka.user_role (user_id, role_key) VALUES ($1, 'documents_team')", [X.docs]);
    }
  });

  it("an event without recipients stays unpublished with no inbox rows, alerts, and is retried", async () => {
    const cand = (await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas })).id;
    const ev = await emitEvent(db, "work_authorization.expiring", "work_authorization", await newId(db), PAYLOADS.workAuth(cand, await newId(db)));
    await db.admin.query("UPDATE eureka.app_user SET status = 'inactive' WHERE id IN ($1, $2)", [U.hr, U.imm]);
    try {
      await expect(deliverInbox(db, ev)).rejects.toThrow(/no recipients/);
      expect(await inbox(ev)).toEqual([]);
      expect(await rows("SELECT 1 FROM eureka.inbox_fanout WHERE event_id = $1", [ev])).toEqual([]);
    } finally {
      await db.admin.query("UPDATE eureka.app_user SET status = 'active' WHERE id IN ($1, $2)", [U.hr, U.imm]);
    }
    expect((await deliverInbox(db, ev)).inApp).toBe(2);
  });

  it("a malformed payload fails before anyone is notified", async () => {
    const cand = await benchCandidate("2026-05-01");
    for (const payload of [{ candidateId: "not-a-uuid", benchSince: "2026-05-01", benchDays: 1, thresholdDays: 30 },
      { ...PAYLOADS.benchTime(cand), thresholdDays: 0 }, { ...PAYLOADS.benchTime(cand), benchSince: "May 1" }]) {
      const ev = await emitEvent(db, "employee.bench_time", "candidate", cand, payload);
      await expect(deliverEvent(db.worker, new FakeMail(), ORIGIN, ev, ctx())).rejects.toThrow(/invalid/);
      expect(await inbox(ev)).toEqual([]);
      expect(await rows("SELECT 1 FROM eureka.outbox_delivery WHERE event_id = $1", [ev])).toEqual([]);
    }
    const wa = await emitEvent(db, "work_authorization.expiring", "work_authorization", cand,
      { ...PAYLOADS.workAuth(cand, cand), days_left: 61 });
    await expect(deliverInbox(db, wa)).rejects.toThrow(/days_left/);
  });

  it("the registry decides recipients: a producer's notify list is only checked against the type's audience", async () => {
    const { placementId, candidateId } = await placement();
    const a = await newId(db);
    // A narrower list does not narrow the audience (HR and Accounts both get it).
    const narrow = await emitEvent(db, "assignment.ending_soon", "assignment", a,
      { ...PAYLOADS.endingSoon(a, placementId, candidateId), notify: ["hr"] });
    expect((await deliverInbox(db, narrow)).inApp).toBe(2);
    expect(await inbox(narrow)).toEqual([U.hr, U.acct].sort());
    // A list naming someone outside the audience fails the event before anyone is notified.
    for (const notify of [["hr", "org_admin"], "hr", [1]]) {
      const ev = await emitEvent(db, "assignment.ending_soon", "assignment", a, { ...PAYLOADS.endingSoon(a, placementId, candidateId), notify });
      await expect(deliverInbox(db, ev)).rejects.toThrow(/notify/);
      expect(await inbox(ev)).toEqual([]);
    }
  });

  it("OUTBOX_DELIVER_SINCE also cuts off emailing in-app types: inbox only, published, no email (review F1)", async () => {
    const cand = (await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas })).id;
    const ev = await emitEvent(db, "work_authorization.expiring", "work_authorization", await newId(db), PAYLOADS.workAuth(cand, await newId(db)));
    await force("UPDATE eureka.outbox_event SET created_at = now() - interval '10 days' WHERE id = $1", [ev]);
    const mail = new FakeMail();
    const job = outboxDeliveryJob(mail, ORIGIN, { batchSize: 500, deliverSince: new Date(Date.now() - 86_400_000) });
    const keys = await job.dueKeys(new Date(), { pool: db.worker, log: silentLogger });
    expect(keys).toContain(ev);                                  // no inbox marker yet: skipBacklog leaves it to the run
    expect(await new JobRunner(db.worker, [job], silentLogger).runOnce(job, ev)).toBe("ran");
    expect(mail.sent).toHaveLength(0);
    expect(await inbox(ev)).toEqual([U.hr, U.imm].sort());
    expect(await rows("SELECT 1 FROM eureka.outbox_delivery WHERE event_id = $1", [ev])).toEqual([]);
    expect(await publishedAt(ev)).not.toBeNull();
    const detail = (await rows<{ detail: Record<string, unknown> }>(
      "SELECT detail FROM eureka.job_run WHERE job_name = 'outbox-delivery' AND run_key = $1", [ev]))[0]!.detail;
    expect(detail).toMatchObject({ emailCutOff: true, inApp: 2, sent: 0 });
    // A fresh event of the same type is emailed as usual.
    const fresh = await emitEvent(db, "work_authorization.expiring", "work_authorization", await newId(db), PAYLOADS.workAuth(cand, await newId(db)));
    expect(await new JobRunner(db.worker, [job], silentLogger).runOnce(job, fresh)).toBe("ran");
    expect(mail.to()).toEqual(["hr@eureka.example", "imm@eureka.example"]);
  });

  it("job scheduling without mail: email-only events wait, in-app-only events are delivered under their id", async () => {
    const { placementId, candidateId } = await placement();
    const pc = (await rows<{ id: string }>(
      "SELECT id FROM eureka.outbox_event WHERE aggregate_id = $1 AND type = 'placement.created'", [placementId]))[0]!.id;
    const a = await newId(db);
    const es = await emitEvent(db, "assignment.ending_soon", "assignment", a, PAYLOADS.endingSoon(a, placementId, candidateId));
    const keys = await dueOutboxEvents(db.worker, 500, false);
    expect(keys).toContain(es);
    expect(keys.filter((k) => k.endsWith(pc))).toEqual([]);
    expect(await dueOutboxEvents(db.worker, 500, true)).toContain(pc);
  });
});

// ---------------------------------------------------------------------------------------------

describe("no personal data in outbox payloads, emails or inbox rows", () => {
  it("renders every type from ids, enum labels and counts only", async () => {
    const { placementId, candidateId } = await placement();
    const person = (await rows<{ first_name: string }>(`SELECT p.first_name FROM eureka.candidate c JOIN eureka.person p ON p.id = c.person_id
      WHERE c.id = $1`, [candidateId]))[0]!.first_name;
    const a = await newId(db);
    const item = await newId(db);
    const events = [
      ["work_authorization.expiring", PAYLOADS.workAuth(candidateId, a)],
      ["employee.benched", PAYLOADS.projectExit(a, placementId, candidateId)],
      ["employee.exited", PAYLOADS.exited(a, a, candidateId)],
      ["assignment.ending_soon", PAYLOADS.endingSoon(a, placementId, candidateId)],
      ["employee.bench_time", PAYLOADS.benchTime(candidateId)],
      ["candidate.assigned", PAYLOADS.assigned(candidateId, T.t1, T.t2)],
      ["checklist.item_overdue", PAYLOADS.overdue(item, placementId, X.docs)],
    ] as const;
    expect(events.map(([t]) => t).sort()).toEqual(Object.keys(EVENT_SPECS).filter((t) => !t.startsWith("placement.")).sort());
    const secrets = [person, "Placed", "81.25", "Irving", "Petra", "petra@vendor.example", "4695550188", "Northwind",
      "2027-01-15", "2026-09-30", "2026-09-29", "2026-11-01", "2026-05-01", "terminated", "resigned", "r1a", "Team Rohit"];
    for (const [type, payload] of events) {
      const ev = await emitEvent(db, type, "candidate", candidateId, payload);
      const mail = new FakeMail();
      await deliverEvent(db.worker, EVENT_SPECS[type]!.email ? mail : null, EVENT_SPECS[type]!.email ? ORIGIN : null, ev, ctx());
      const texts = [
        ...mail.sent.map((m) => `${m.subject}\n${m.text}`),
        ...(await rows<{ t: string }>("SELECT title || ' ' || body AS t FROM eureka.notification WHERE event_id = $1", [ev])).map((r) => r.t),
      ];
      expect(texts.length, type).toBeGreaterThan(0);
      for (const t of texts) for (const s of secrets) expect(t, `${type}: ${s}`).not.toContain(s);
      // The email names only its link and an id reference.
      for (const m of mail.sent) expect(m.text).toContain(`${ORIGIN}/`);
    }
  });

  it("bench-time payloads hold ids, dates and counts only", async () => {
    const cand = await benchCandidate("2026-03-01");
    await db.worker.query("SELECT authz.emit_bench_time('2026-04-15', 30, 30)");
    const p = (await rows<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM eureka.outbox_event WHERE type = 'employee.bench_time' AND aggregate_id = $1", [cand]))[0]!.payload;
    expect(Object.keys(p).sort()).toEqual(["benchDays", "benchSince", "candidateId", "thresholdDays"]);
    expect(p).toEqual({ candidateId: cand, benchSince: "2026-03-01", benchDays: 45, thresholdDays: 30 });
  });

  it("the why-line and templates refuse unknown reasons and types", () => {
    const ev = { id: "x", type: "employee.bench_time", aggregate_id: "00000000-0000-4000-8000-000000000001",
      payload: { candidateId: "00000000-0000-4000-8000-000000000001", benchSince: "2026-01-01", benchDays: 40, thresholdDays: 30 } };
    expect(() => renderEmail(ev, ORIGIN, ["org_admin"])).toThrow(/no known reason/);
    expect(() => renderEmail({ ...ev, type: "x.y" }, ORIGIN, ["ceo"])).toThrow(/not delivered/);
    expect(renderEmail(ev, ORIGIN, ["lead", "recruiter"]).text).toContain("as the team lead and the recruiter.");
  });
});

// ---------------------------------------------------------------------------------------------

describe("inbox table privileges and RLS (migration 0046)", () => {
  /** Two delivered in-app events with different recipients. */
  let evA = "";
  let evB = "";
  beforeAll(async () => {
    const { placementId, candidateId } = await placement();
    const a = await newId(db);
    evA = await emitEvent(db, "employee.benched", "employee", a, PAYLOADS.projectExit(a, placementId, candidateId));
    await deliverInbox(db, evA);
    const cand = await benchCandidate("2026-05-01", T.t2, U.r2a);
    evB = await emitEvent(db, "employee.bench_time", "candidate", cand, PAYLOADS.benchTime(cand));
    await deliverInbox(db, evB);
  });

  it("differential: each fixture user sees exactly their own rows, nobody else's", async () => {
    const all = await rows<{ id: string; recipient_id: string }>("SELECT id, recipient_id FROM eureka.notification");
    expect(all.length).toBeGreaterThan(5);
    const users = [...Object.values(U), X.bu!, X.docs!, X.ahr!];
    let someoneHasRows = 0;
    for (const user of users) {
      const seen = await asUser(db.app, user, async (c) => (await c.query<{ id: string }>("SELECT id FROM eureka.notification")).rows.map((r) => r.id).sort());
      const own = all.filter((r) => r.recipient_id === user).map((r) => r.id).sort();
      expect(seen, user).toEqual(own);
      if (own.length) someoneHasRows++;
    }
    expect(someoneHasRows).toBeGreaterThan(4);
    // No user context: nothing.
    expect((await db.app.query("SELECT 1 FROM eureka.notification")).rowCount).toBe(0);
    // The bench recipients of team t2 include l2 and the CEO, not l1.
    expect(await inbox(evB)).toEqual([U.r2a, U.l2, U.m1, U.ceo].sort());
  });

  it("a user marks only their own rows; only read_at changes and the server sets the time", async () => {
    const mine = (await rows<{ id: string }>("SELECT id FROM eureka.notification WHERE event_id = $1 AND recipient_id = $2", [evA, U.hr]))[0]!.id;
    const theirs = (await rows<{ id: string }>("SELECT id FROM eureka.notification WHERE event_id = $1 AND recipient_id = $2", [evA, U.acct]))[0]!.id;
    // Another user's row is invisible to UPDATE (0 rows), whatever the WHERE says.
    expect(await asUser(db.app, U.hr, (c) => c.query("UPDATE eureka.notification SET read_at = now() WHERE id = $1", [theirs]).then((r) => r.rowCount), true)).toBe(0);
    expect(await asUser(db.app, U.hr, (c) => c.query("UPDATE eureka.notification SET read_at = now() WHERE recipient_id = $1", [U.acct]).then((r) => r.rowCount), true)).toBe(0);
    expect((await rows("SELECT read_at FROM eureka.notification WHERE id = $1", [theirs]))[0]!.read_at).toBeNull();
    // Own row: a client-chosen time is replaced by the server's; the first read time is kept.
    await asUser(db.app, U.hr, (c) => c.query("UPDATE eureka.notification SET read_at = '2000-01-01' WHERE id = $1", [mine]), true);
    const first = (await rows<{ read_at: Date }>("SELECT read_at FROM eureka.notification WHERE id = $1", [mine]))[0]!.read_at;
    expect(first.getTime()).toBeGreaterThan(Date.now() - 60_000);
    await asUser(db.app, U.hr, (c) => c.query("UPDATE eureka.notification SET read_at = now() WHERE id = $1", [mine]), true);
    expect((await rows<{ read_at: Date }>("SELECT read_at FROM eureka.notification WHERE id = $1", [mine]))[0]!.read_at).toEqual(first);
    await asUser(db.app, U.hr, (c) => c.query("UPDATE eureka.notification SET read_at = NULL WHERE id = $1", [mine]), true);
    expect((await rows("SELECT read_at FROM eureka.notification WHERE id = $1", [mine]))[0]!.read_at).toBeNull();
    // Other columns, other writes: refused.
    for (const sql of [
      "UPDATE eureka.notification SET title = 'x' WHERE id = $1",
      "UPDATE eureka.notification SET recipient_id = '00000000-0000-0000-0000-000000000017' WHERE id = $1",
      "DELETE FROM eureka.notification WHERE id = $1",
      "INSERT INTO eureka.notification (recipient_id, event_id, type, entity_type, entity_id, title, body) SELECT recipient_id, gen_random_uuid(), type, entity_type, entity_id, title, body FROM eureka.notification WHERE id = $1",
    ]) {
      expect(await asUser(db.app, U.hr, (c) => err(c.query(sql, [mine]))), sql).toMatch(/permission denied/);
    }
    expect(await denied(db.app, "TRUNCATE eureka.notification")).toMatch(/permission denied/);
  });

  it("the worker writes rows only during an event's fan-out and never reads titles or bodies", async () => {
    expect(await denied(db.worker, "SELECT title FROM eureka.notification")).toMatch(/permission denied/);
    expect(await denied(db.worker, "SELECT body FROM eureka.notification")).toMatch(/permission denied/);
    expect(await denied(db.worker, "UPDATE eureka.notification SET read_at = now()")).toMatch(/permission denied/);
    const ins = (ev: string, type = "employee.benched") => denied(db.worker,
      `INSERT INTO eureka.notification (recipient_id, event_id, type, entity_type, entity_id, title, body)
       VALUES ($1, $2, $3, 'candidate', gen_random_uuid(), 'T', 'B')`, [U.r3a, ev, type]);
    // The fan-out of evA is recorded (and it may be published): no more rows.
    expect(await ins(evA)).toMatch(/row-level security/);
    expect(await ins(await newId(db))).toMatch(/row-level security/);                 // no such event
    const { placementId, candidateId } = await placement();
    const a = await newId(db);
    const fresh = await emitEvent(db, "assignment.ending_soon", "assignment", a, PAYLOADS.endingSoon(a, placementId, candidateId));
    expect(await ins(fresh, "employee.benched")).toMatch(/row-level security/);        // type must match the event
    expect(await ins(fresh, "assignment.ending_soon")).toMatch(/row-level security/); // r3a is not a recipient of it
    // A recipient with an entity other than the event's is refused (0051).
    expect(await denied(db.worker, `INSERT INTO eureka.notification (recipient_id, event_id, type, entity_type, entity_id, title, body)
      VALUES ($1, $2, 'assignment.ending_soon', 'placement', $3, 'T', 'B')`, [U.hr, fresh, candidateId])).toMatch(/row-level security/);
    expect(await denied(db.worker, `INSERT INTO eureka.notification (recipient_id, event_id, type, entity_type, entity_id, title, body)
      VALUES ($1, $2, 'assignment.ending_soon', 'candidate', $3, 'T', 'B')`, [U.hr, fresh, placementId])).toMatch(/row-level security/);
    const c = await db.worker.connect();
    try {                                                                              // a recipient would be accepted
      await c.query("BEGIN");
      await c.query(`INSERT INTO eureka.notification (recipient_id, event_id, type, entity_type, entity_id, title, body)
        VALUES ($1, $2, 'assignment.ending_soon', 'placement', $3, 'T', 'B')`, [U.hr, fresh, placementId]);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
    expect(await denied(db.worker, "INSERT INTO eureka.inbox_fanout (event_id, recipients, created_at) VALUES ($1, 1, now())", [fresh]))
      .toMatch(/permission denied/);
    // Recent rows cannot be pruned; nobody else may delete or truncate.
    expect((await db.worker.query("DELETE FROM eureka.notification WHERE event_id = $1", [evA])).rowCount).toBe(0);
    expect(await denied(db.admin, "DELETE FROM eureka.notification WHERE event_id = $1", [evA])).toMatch(/only notifications older than 30 days/);
    expect(await denied(db.admin, "UPDATE eureka.notification SET read_at = now() WHERE event_id = $1", [evA])).toMatch(/only the read mark/);
    expect(await denied(db.admin, "TRUNCATE eureka.notification")).toMatch(/never truncated/);
    expect(await denied(db.admin, `INSERT INTO eureka.notification (recipient_id, event_id, type, entity_type, entity_id, title, body)
      VALUES ($1, $2, 'employee.exited', 'candidate', gen_random_uuid(), 'T', 'B')`, [U.r3a, fresh])).toMatch(/only by the notification worker/);
  });

  it("fan-out markers and the reminder ledger are guarded; the app reaches neither", async () => {
    expect(await denied(db.app, "SELECT 1 FROM eureka.inbox_fanout")).toMatch(/permission denied/);
    expect(await denied(db.app, "SELECT 1 FROM eureka.notification_ledger")).toMatch(/permission denied/);
    expect(await denied(db.worker, "SELECT 1 FROM eureka.notification_ledger")).toMatch(/permission denied/);
    expect(await denied(db.worker, "DELETE FROM eureka.inbox_fanout WHERE event_id = $1", [evA])).toMatch(/permission denied/);
    expect(await denied(db.admin, "DELETE FROM eureka.inbox_fanout WHERE event_id = $1", [evA])).toMatch(/removed only with their event/);
    expect(await denied(db.admin, "UPDATE eureka.inbox_fanout SET recipients = 9 WHERE event_id = $1", [evA])).toMatch(/removed only with their event/);
    expect(await denied(db.admin, "TRUNCATE eureka.inbox_fanout")).toMatch(/removed only with their event/);
    expect(await denied(db.admin, "INSERT INTO eureka.notification_ledger (job, key, event_id) VALUES ('x', 'y', gen_random_uuid())"))
      .toMatch(/append-only/);
    expect(await denied(db.admin, "DELETE FROM eureka.notification_ledger")).toMatch(/append-only/);
    expect(await denied(db.admin, "TRUNCATE eureka.notification_ledger")).toMatch(/append-only/);
    // The marker goes with its pruned event (cascade).
    await force("UPDATE eureka.outbox_event SET published_at = now() - interval '8 days' WHERE id = $1", [evA]);
    expect((await db.worker.query("DELETE FROM eureka.outbox_event WHERE id = $1", [evA])).rowCount).toBe(1);
    expect(await rows("SELECT 1 FROM eureka.inbox_fanout WHERE event_id = $1", [evA])).toEqual([]);
    expect((await inbox(evA)).length).toBe(5);                  // the inbox outlives the pruned event
  });

  it("new functions pin search_path, are not executable by PUBLIC and are granted to exactly the worker", async () => {
    const { rows: fns } = await db.admin.query(`
      SELECT p.oid::regprocedure::text AS sig, p.proconfig,
             has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
             has_function_privilege('eureka_app', p.oid, 'EXECUTE') AS app,
             has_function_privilege('eureka_worker', p.oid, 'EXECUTE') AS worker
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE p.proname IN ('notification_recipients', 'notification_emit_once', 'emit_bench_time', 'notification_entity',
                           'notification_guard', 'inbox_fanout_guard', 'notification_ledger_guard')`);
    expect(fns).toHaveLength(7);
    const by = Object.fromEntries(fns.map((r) => [r.sig.split("(")[0], r]));
    for (const r of fns) {
      expect(r.proconfig, r.sig).toContain("search_path=pg_catalog, pg_temp");
      expect(r.pub, r.sig).toBe(false);
      expect(r.app, r.sig).toBe(false);
    }
    expect(by["authz.notification_recipients"].worker).toBe(true);
    expect(by["authz.emit_bench_time"].worker).toBe(true);
    expect(by["authz.emit_bench_time"].sig).toBe("authz.emit_bench_time(date,integer,integer)");
    expect(by["authz.notification_entity"].worker).toBe(true);
    expect(by["authz.notification_emit_once"].worker).toBe(false);
    expect(await denied(db.worker, "SELECT authz.notification_emit_once('bench-time', 'k', 'employee.bench_time', 'candidate', gen_random_uuid(), '{}')"))
      .toMatch(/permission denied/);
    // The worker still cannot write outbox events itself.
    expect(await denied(db.worker, `INSERT INTO eureka.outbox_event (type, aggregate_type, aggregate_id, payload)
      VALUES ('employee.bench_time', 'candidate', gen_random_uuid(), '{}')`)).toMatch(/permission denied/);
    // The worker gained no read on candidate or placement rows.
    expect(await denied(db.worker, "SELECT 1 FROM eureka.candidate")).toMatch(/permission denied/);
    expect(await denied(db.worker, "SELECT 1 FROM eureka.placement")).toMatch(/permission denied/);
  });
});

// ---------------------------------------------------------------------------------------------

describe("time travel: scheduled notification jobs on a fixed clock", () => {
  const due = (job: ReturnType<typeof benchTimeJob> | ReturnType<typeof notificationPruneJob>, iso: string) =>
    job.dueKeys(new Date(iso), { pool: db.worker, log: silentLogger });

  it("bench-time runs for the New York day once 07:45 local has passed (EDT and EST)", async () => {
    const job = benchTimeJob(30);
    expect(await due(job, "2026-06-15T11:44:00Z")).toEqual(["2026-06-14"]);    // 07:44 EDT
    expect(await due(job, "2026-06-15T11:45:00Z")).toEqual(["2026-06-15"]);
    expect(await due(job, "2026-06-16T03:00:00Z")).toEqual(["2026-06-15"]);    // 23:00 EDT, still the 15th in New York
    expect(await due(job, "2026-12-15T12:44:00Z")).toEqual(["2026-12-14"]);    // 07:44 EST
    expect(await due(job, "2026-12-15T12:45:00Z")).toEqual(["2026-12-15"]);
    expect(() => benchTimeJob(0)).toThrow(/1 to 365/);
  });

  it("bench-time notifies once per bench period when bench passes N days, then delivers to the inbox", async () => {
    const job = benchTimeJob(30);
    const runner = new JobRunner(db.worker, [job], silentLogger);
    const cand = await benchCandidate("2026-05-10", T.t3, U.r3a);
    const notBench = (await newCandidate(db, { teamId: T.t3, recruiterId: U.r3a, locationId: LOC.dallas })).id;
    await force("UPDATE eureka.candidate SET bench_since = '2026-01-01' WHERE id = $1", [notBench]); // not on bench: ignored
    const events = async () => (await rows<{ id: string; payload: { benchDays: number } }>(
      "SELECT id, payload FROM eureka.outbox_event WHERE type = 'employee.bench_time' AND aggregate_id = ANY ($1) ORDER BY created_at",
      [[cand, notBench]]));

    expect(await runner.runOnce(job, "2026-06-08")).toBe("ran");                   // day 29
    expect(await events()).toEqual([]);
    expect(await runner.runOnce(job, "2026-06-09")).toBe("ran");                   // day 30
    const first = await events();
    expect(first.map((e) => e.payload.benchDays)).toEqual([30]);
    expect(await runner.runOnce(job, "2026-06-09")).toBe("done-before");
    expect(await runner.runOnce(job, "2026-06-20")).toBe("ran");                   // still on bench: no repeat
    expect(await events()).toHaveLength(1);
    const detail = (await rows<{ detail: Record<string, unknown> }>(
      "SELECT detail FROM eureka.job_run WHERE job_name = $1 AND run_key = '2026-06-20'", [BENCH_TIME_JOB]))[0]!.detail;
    expect(detail).toEqual({ emitted: 0, thresholdDays: 30, windowDays: 7 });

    // A new bench period is a new notice.
    await force("UPDATE eureka.candidate SET bench_since = '2026-06-01' WHERE id = $1", [cand]);
    expect(await runner.runOnce(job, "2026-07-01")).toBe("ran");
    expect(await events()).toHaveLength(2);

    // Delivered like any event: in-app to the recruiter, lead, manager and CEO.
    const r = await deliverInbox(db, first[0]!.id);
    expect(r.inApp).toBe(4);
    expect(await inbox(first[0]!.id)).toEqual([U.r3a, U.l3, U.m2, U.ceo].sort());
  });

  it("the database refuses a future day or a bad threshold", async () => {
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    expect(await denied(db.worker, "SELECT authz.emit_bench_time($1::date, 30, 7)", [tomorrow])).toMatch(/invalid bench-time run/);
    expect(await denied(db.worker, "SELECT authz.emit_bench_time('2026-06-01', 0, 7)")).toMatch(/invalid bench-time run/);
    expect(await denied(db.worker, "SELECT authz.emit_bench_time('2026-06-01', 30, 0)")).toMatch(/invalid bench-time run/);
    expect(await denied(db.worker, "SELECT authz.emit_bench_time(NULL, 30, 7)")).toMatch(/invalid bench-time run/);
    expect(await denied(db.app, "SELECT authz.emit_bench_time('2026-06-01', 30, 7)")).toMatch(/permission denied/);
    expect(await denied(db.worker, "SELECT authz.emit_bench_time('2026-06-01', 30)")).toMatch(/does not exist/); // 0046 signature dropped
  });

  it("bench-time: one reminder per bench period whatever the threshold, and only recent crossings (0051)", async () => {
    const benched = async (cand: string) => (await rows<{ id: string }>(
      "SELECT id FROM eureka.outbox_event WHERE type = 'employee.bench_time' AND aggregate_id = $1", [cand])).length;
    const day = "2026-08-31";
    const recent = await benchCandidate("2026-07-28", T.t3, U.r3a);  // crossed 30 days on 2026-08-27 (4 days ago)
    const old = await benchCandidate("2026-06-01", T.t3, U.r3a);     // crossed on 2026-07-01 (61 days ago)
    expect((await db.worker.query("SELECT authz.emit_bench_time($1, 30, 7) AS n", [day])).rows[0].n).toBeGreaterThanOrEqual(1);
    expect([await benched(recent), await benched(old)]).toEqual([1, 0]);   // first enable: no flood of the whole bench
    // A worker-chosen threshold change does not re-notify the same bench period (it once took 50 events).
    for (let t = 1; t <= 50; t++) await db.worker.query("SELECT authz.emit_bench_time($1, $2, 365)", [day, t]);
    expect(await benched(recent)).toBe(1);
    expect(await benched(old)).toBe(1);                                    // the wide window reached it once
    // A 0046-style key (with a threshold suffix) counts as already notified.
    const legacy = await benchCandidate("2026-07-29", T.t3, U.r3a);
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE authz_definer");
      await c.query("INSERT INTO eureka.notification_ledger (job, key, event_id) VALUES ('bench-time', $1, gen_random_uuid())",
        [`${legacy}:2026-07-29:30`]);
      await c.query("COMMIT");
    } finally { c.release(); }
    await db.worker.query("SELECT authz.emit_bench_time($1, 30, 7)", [day]);
    expect(await benched(legacy)).toBe(0);
  });

  it("notification-prune runs daily after 04:30 New York and deletes rows older than the retention only", async () => {
    const job = notificationPruneJob(180);
    expect(await due(job, "2026-10-01T08:29:00Z")).toEqual([]);                    // 04:29 EDT
    expect(await due(job, "2026-10-01T08:30:00Z")).toEqual(["2026-09-30"]);

    const { placementId, candidateId } = await placement();
    const a = await newId(db);
    const ev = await emitEvent(db, "assignment.ending_soon", "assignment", a, PAYLOADS.endingSoon(a, placementId, candidateId));
    await deliverInbox(db, ev);
    const [old, recent] = (await rows<{ id: string }>("SELECT id FROM eureka.notification WHERE event_id = $1 ORDER BY id", [ev])).map((r) => r.id);
    await force("UPDATE eureka.notification SET created_at = now() - interval '200 days' WHERE id = $1", [old]);
    await force("UPDATE eureka.notification SET created_at = now() - interval '100 days' WHERE id = $1", [recent]);
    expect(await new JobRunner(db.worker, [job], silentLogger).runOnce(job, "2026-09-30")).toBe("ran");
    expect(await rows("SELECT id FROM eureka.notification WHERE id = ANY ($1)", [[old, recent]])).toEqual([{ id: recent }]);
    // The floor holds whatever the job is told.
    await expect(pruneNotifications(db.worker, 10, ctx())).rejects.toThrow(/at least 30 days/);
    await force("UPDATE eureka.notification SET created_at = now() - interval '10 days' WHERE id = $1", [recent]);
    expect((await db.worker.query("DELETE FROM eureka.notification WHERE id = $1", [recent])).rowCount).toBe(0);
  });

  it("validates the notification settings", () => {
    const base = { DATABASE_URL: "postgres://w@localhost/db", EXPORT_DIR: "/tmp/x" };
    expect(loadWorkerConfig(base).NOTIFICATION_RETENTION_DAYS).toBe(180);
    expect(loadWorkerConfig(base).NOTIFY_BENCH_DAYS).toBeUndefined();
    expect(loadWorkerConfig({ ...base, NOTIFY_BENCH_DAYS: "45" }).NOTIFY_BENCH_DAYS).toBe(45);
    expect(() => loadWorkerConfig({ ...base, NOTIFICATION_RETENTION_DAYS: "7" })).toThrow();
    expect(() => loadWorkerConfig({ ...base, NOTIFY_BENCH_DAYS: "0" })).toThrow();
    expect(loadWorkerConfig(base).NOTIFY_BENCH_WINDOW_DAYS).toBe(7);
    expect(() => loadWorkerConfig({ ...base, NOTIFY_BENCH_WINDOW_DAYS: "0" })).toThrow();
    expect(() => benchTimeJob(30, 0)).toThrow(/window/);
  });
});
