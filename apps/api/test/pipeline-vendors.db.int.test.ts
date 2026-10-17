import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalMail } from "../src/worker/feedback-mail.js";
import {
  CANDIDATE_NONRESPONSE_JOB, candidateNonresponseJob, candidateNonresponseMailJob,
} from "../src/worker/jobs/candidate-nonresponse.js";
import { outboxDeliveryJob } from "../src/worker/jobs/outbox.js";
import { silentLogger } from "../src/worker/log.js";
import { JobRunner } from "../src/worker/runner.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { CLIENT_ID, LOC, T, TECH_ID, U, seedFixtures } from "./fixtures.js";
import { extraUser, newCandidate, selectedSubmission } from "./placement-seed.js";

/**
 * Database side of the pipeline-vendors slice (migrations 0170-0172): guards,
 * definer re-checks, RLS visibility, the non-response job and its emails, and
 * the notification registry branch.
 */
let db: TestDb;
let mailDir: string;
const ORIGIN = "https://eureka.example";

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  mailDir = await mkdtemp(join(tmpdir(), "eureka-pv-mail-"));
}, 120_000);

afterAll(async () => {
  await db?.drop();
  if (mailDir) await rm(mailDir, { recursive: true, force: true });
});

const as = <T>(user: string, fn: (c: import("pg").PoolClient) => Promise<T>) => asUser(db.app, user, fn, true);
const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.admin.query(sql, params)).rows[0] as T;

async function submission(actor: string, candidateId: string): Promise<string> {
  return as(actor, async (c) => (await c.query<{ id: string }>(
    `INSERT INTO eureka.submission (candidate_id, job_title, client_id) VALUES ($1,'Data Engineer',$2) RETURNING id`,
    [candidateId, CLIENT_ID])).rows[0]!.id);
}

const createAssessment = (actor: string, sub: string, status = "assigned", completed: string | null = null) =>
  as(actor, async (c) => (await c.query<{ id: string }>(
    `SELECT authz.assessment_create($1, 'glider', $2, '2030-01-05', '2030-01-08', $3::date, NULL) AS id`, [sub, status, completed])).rows[0]!.id);

describe("assessments (0170)", () => {
  it("are written only through the definer functions, with server-set columns", async () => {
    const cand = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
    const sub = await submission(U.r1a, cand.id);
    await expect(as(U.r1a, (c) => c.query(
      `INSERT INTO eureka.assessment (submission_id, candidate_id, platform, status, assigned_on, created_by, updated_by)
       VALUES ($1,$2,'glider','assigned','2030-01-05',$3,$3)`, [sub, cand.id, U.r1a]))).rejects.toThrow(/permission denied/);
    const id = await createAssessment(U.r1a, sub);
    const row = await one<{ candidate_id: string; created_by: string; row_version: number }>(
      `SELECT candidate_id, created_by, row_version FROM eureka.assessment WHERE id = $1`, [id]);
    expect(row).toEqual({ candidate_id: cand.id, created_by: U.r1a, row_version: 1 });
    // Even the owner cannot write around the functions.
    await expect(db.admin.query(`UPDATE eureka.assessment SET score = 99 WHERE id = $1`, [id])).rejects.toThrow(/written only/);
    await expect(db.admin.query(`DELETE FROM eureka.assessment WHERE id = $1`, [id])).rejects.toThrow(/written only|never deleted/);
  });

  it("re-check visibility (404) and the actor's submission:update scope (403) in the database", async () => {
    const cand = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
    const sub = await submission(U.r1a, cand.id);
    // r2a (other team) cannot see the submission at all.
    await expect(createAssessment(U.r2a, sub)).rejects.toThrow(/submission_not_found/);
    // r1b sees it through the team's candidate read? submission:read is own for recruiters: not found either.
    await expect(createAssessment(U.r1b, sub)).rejects.toThrow(/submission_not_found/);
    // The location incharge (Austin) cannot read a Dallas submission; the Dallas ops admin can read but not update.
    await expect(createAssessment(U.locD, sub)).rejects.toThrow(/not_permitted/);
    // The lead and manager of the actor's team may record it.
    expect(await createAssessment(U.l1, sub)).toMatch(/^[0-9a-f-]{36}$/);
    expect(await createAssessment(U.m1, sub)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("validate codes and dates, refuse closed submissions and stale versions", async () => {
    const cand = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
    const sub = await submission(U.r1a, cand.id);
    await expect(createAssessment(U.r1a, sub, "passed", null)).rejects.toThrow(/completed_on_required/);
    await expect(as(U.r1a, (c) => c.query(`SELECT authz.assessment_create($1, 'nope', 'assigned', '2030-01-05', NULL, NULL, NULL)`, [sub])))
      .rejects.toThrow(/invalid_assessment/);
    await expect(as(U.r1a, (c) => c.query(`SELECT authz.assessment_create($1, 'glider', 'assigned', '2030-01-05', '2030-01-01', NULL, NULL)`, [sub])))
      .rejects.toThrow(/invalid_assessment/);
    await expect(as(U.r1a, (c) => c.query(`SELECT authz.assessment_create($1, NULL, NULL, NULL, NULL, NULL, NULL)`, [sub])))
      .rejects.toThrow(/invalid_assessment/);
    const id = await createAssessment(U.r1a, sub);
    const v = await as(U.r1a, async (c) => (await c.query<{ v: number }>(
      `SELECT authz.assessment_update($1, 1, 'glider', 'passed', '2030-01-05', NULL, '2030-01-06', 87) AS v`, [id])).rows[0]!.v);
    expect(v).toBe(2);
    await expect(as(U.r1a, (c) => c.query(`SELECT authz.assessment_update($1, 1, 'glider', 'failed', '2030-01-05', NULL, '2030-01-06', 10)`, [id])))
      .rejects.toThrow(/stale/);
    await expect(as(U.r2a, (c) => c.query(`SELECT authz.assessment_update($1, 2, 'glider', 'failed', '2030-01-05', NULL, '2030-01-06', 10)`, [id])))
      .rejects.toThrow(/assessment_not_found/);
    const closed = await selectedSubmission(db, U.r1a, cand.id, "under_review");
    await as(U.r1a, (c) => c.query(`SELECT authz.transition_submission($1, 'withdrawn', NULL)`, [closed]));
    await expect(createAssessment(U.r1a, closed)).rejects.toThrow(/submission_closed/);
  });

  it("are readable exactly where the submission is", async () => {
    const cand = await newCandidate(db, { teamId: T.t2, recruiterId: U.r2a, locationId: LOC.austin });
    const sub = await submission(U.r2a, cand.id);
    const id = await createAssessment(U.r2a, sub);
    const sees = (u: string) => asUser(db.app, u, async (c) => (await c.query(`SELECT 1 FROM eureka.assessment WHERE id = $1`, [id])).rowCount);
    for (const u of [U.r2a, U.l2, U.m1, U.ad, U.ceo, U.locA]) expect(await sees(u), u).toBe(1);
    for (const u of [U.r1a, U.l1, U.m2, U.locD, U.admin, U.hr]) expect(await sees(u), u).toBe(0);
  });
});

describe("preferred vendors (0172)", () => {
  const create = (u: string, name: string) => as(u, async (c) => (await c.query<{ id: string }>(
    `SELECT authz.preferred_vendor_create($1, NULL, 'Pat Vendor', 'pat@vendor.example', '+14695550111', $2, 'Northwind', 'Good rates') AS id`,
    [name, TECH_ID])).rows[0]!.id);
  const visible = (u: string) => asUser(db.app, u, async (c) =>
    (await c.query<{ vendor_name: string }>(`SELECT vendor_name FROM eureka.preferred_vendor ORDER BY vendor_name`)).rows.map((r) => r.vendor_name));

  let ids: Record<string, string> = {};
  beforeAll(async () => {
    ids = {
      r1a: await create(U.r1a, "V-r1a"), r1b: await create(U.r1b, "V-r1b"), r2a: await create(U.r2a, "V-r2a"),
      r3a: await create(U.r3a, "V-r3a"), l1: await create(U.l1, "V-l1"),
    };
  });

  it("are visible only to the owner and their superiors", async () => {
    expect(await visible(U.r1a)).toEqual(["V-r1a"]);
    expect(await visible(U.r1b)).toEqual(["V-r1b"]);
    expect(await visible(U.l1)).toEqual(["V-l1", "V-r1a", "V-r1b"]);
    expect(await visible(U.l2)).toEqual(["V-r2a"]);
    expect(await visible(U.m1)).toEqual(["V-l1", "V-r1a", "V-r1b", "V-r2a"]);
    expect(await visible(U.m2)).toEqual(["V-r3a"]);
    expect(await visible(U.ad)).toEqual(["V-l1", "V-r1a", "V-r1b", "V-r2a", "V-r3a"]);
    expect(await visible(U.ceo)).toEqual(["V-l1", "V-r1a", "V-r1b", "V-r2a", "V-r3a"]);
    for (const u of [U.hr, U.acct, U.admin, U.locD, U.locA, U.coach]) expect(await visible(u), u).toEqual([]);
  });

  it("follow team membership: a recruiter who moves teams is seen by the new lead", async () => {
    const mover = await extraUser(db, "pvmover", "recruiter");
    await db.admin.query(`INSERT INTO eureka.team_member (team_id, user_id) VALUES ($1,$2)`, [T.t2, mover.id]);
    await create(mover.id, "V-mover");
    expect(await visible(U.l2)).toContain("V-mover");
    expect(await visible(U.l1)).not.toContain("V-mover");
  });

  it("only the owner edits or archives; superiors read only; unseen entries are not found", async () => {
    const upd = (u: string, id: string, v: number) => as(u, (c) => c.query(
      `SELECT authz.preferred_vendor_update($1, $2, 'V-r1a2', NULL, NULL, NULL, NULL, NULL, NULL, NULL)`, [id, v]));
    await expect(upd(U.l1, ids.r1a!, 1)).rejects.toThrow(/not_permitted/);
    await expect(upd(U.r1b, ids.r1a!, 1)).rejects.toThrow(/vendor_not_found/);
    await expect(upd(U.r1a, ids.r1a!, 7)).rejects.toThrow(/stale/);
    await upd(U.r1a, ids.r1a!, 1);
    await expect(as(U.m1, (c) => c.query(`SELECT authz.preferred_vendor_archive($1)`, [ids.r1b]))).rejects.toThrow(/not_permitted/);
    await expect(as(U.ceo, (c) => c.query(`SELECT authz.preferred_vendor_create('x', NULL, NULL, NULL, NULL, NULL, NULL, NULL)`)))
      .rejects.toThrow(/not_permitted/);
    await expect(create(U.r1b, "v-R1B ")).rejects.toThrow(/vendor_exists/);
    await expect(as(U.r1a, (c) => c.query(`SELECT authz.preferred_vendor_create('ok', NULL, NULL, 'not-an-email', NULL, NULL, NULL, NULL)`)))
      .rejects.toThrow(/invalid_vendor/);
    await expect(as(U.r1a, (c) => c.query(`INSERT INTO eureka.preferred_vendor (owner_id, vendor_name) VALUES ($1, 'direct')`, [U.r1a])))
      .rejects.toThrow(/permission denied/);
  });
});

describe("candidate not responding (0171)", () => {
  const flag = (u: string, cand: string, reason = "no_reply_calls") =>
    as(u, async (c) => (await c.query<{ id: string }>(`SELECT authz.nonresponse_flag($1, $2) AS id`, [cand, reason])).rows[0]!.id);

  it("Sales who own the candidate flag and resolve it; others are refused in the database", async () => {
    const cand = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas, visibility: "all_teams" });
    await expect(flag(U.r2a, cand.id)).rejects.toThrow(/not_permitted/); // sees it (Open to all teams), does not own it
    await expect(flag(U.r1b, cand.id)).rejects.toThrow(/not_permitted/); // candidate:update is own for recruiters
    await expect(flag(U.hr, cand.id)).rejects.toThrow(/not_permitted/);
    const hidden = await newCandidate(db, { teamId: T.t3, recruiterId: U.r3a, locationId: LOC.austin });
    await expect(flag(U.r1a, hidden.id)).rejects.toThrow(/candidate_not_found/);
    await expect(flag(U.r1a, cand.id, "bad")).rejects.toThrow(/invalid_reason/);
    const id = await flag(U.r1a, cand.id);
    await expect(flag(U.l1, cand.id)).rejects.toThrow(/already_flagged/);
    // One staff event, ids and the stage only.
    const ev = await one<{ type: string; payload: Record<string, unknown> }>(
      `SELECT type, payload FROM eureka.outbox_event WHERE aggregate_id = $1 AND type = 'candidate.not_responding'`, [cand.id]);
    expect(ev.payload).toEqual({ candidateId: cand.id, flagId: id, stage: "warning" });
    await expect(as(U.r1a, (c) => c.query(`SELECT authz.nonresponse_resolve($1, 'whatever')`, [cand.id]))).rejects.toThrow(/invalid_resolution/);
    await as(U.l1, (c) => c.query(`SELECT authz.nonresponse_resolve($1, 'responded')`, [cand.id]));
    expect(await one(`SELECT status, resolution, resolved_by FROM eureka.candidate_nonresponse WHERE id = $1`, [id]))
      .toEqual({ status: "resolved", resolution: "responded", resolved_by: U.l1 });
    await expect(as(U.r1a, (c) => c.query(`SELECT authz.nonresponse_resolve($1, 'responded')`, [cand.id]))).rejects.toThrow(/not_flagged/);
    await expect(db.admin.query(`UPDATE eureka.candidate_nonresponse SET status = 'open' WHERE id = $1`, [id])).rejects.toThrow(/written only/);
    const placed = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas, marketingStatus: "placed" });
    await expect(flag(U.r1a, placed.id)).rejects.toThrow(/candidate_not_marketed/);
  });

  it("flags are readable wherever the candidate is", async () => {
    const cand = await newCandidate(db, { teamId: T.t2, recruiterId: U.r2a, locationId: LOC.austin });
    const id = await flag(U.r2a, cand.id);
    const sees = (u: string) => asUser(db.app, u, async (c) => (await c.query(`SELECT 1 FROM eureka.candidate_nonresponse WHERE id = $1`, [id])).rowCount);
    for (const u of [U.r2a, U.l2, U.m1, U.hr, U.locA, U.coach]) expect(await sees(u), u).toBe(1);
    for (const u of [U.r1a, U.l3, U.locD, U.admin]) expect(await sees(u), u).toBe(0);
  });

  it("the worker emails the candidate, escalates after the hold delay once, and notifies recruiter and lead", async () => {
    const cand = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
    await db.admin.query(`UPDATE eureka.person SET personal_email = 'cand.nr@example.com'
      WHERE id = (SELECT person_id FROM eureka.candidate WHERE id = $1)`, [cand.id]);
    const id = await flag(U.r1a, cand.id, "missed_interview");
    const mail = new LocalMail(mailDir);
    const mailJob = candidateNonresponseMailJob(mail, 3);
    const runner = new JobRunner(db.worker, [mailJob], silentLogger);
    const due = await mailJob.dueKeys(new Date(), { pool: db.worker, log: silentLogger });
    expect(due).toContain(`${id}:warning`);
    expect(due).not.toContain(`${id}:hold`);
    expect(await runner.runOnce(mailJob, `${id}:warning`)).toBe("ran");
    const warning = JSON.parse(await readFile(join(mailDir, `nonresponse-${id}-warning.json`), "utf8")) as { to: string; subject: string; text: string };
    expect(warning.to).toBe("cand.nr@example.com");
    expect(warning.text).toContain("within 3 days");
    expect(warning.text).not.toMatch(/PlCand|Northwind|r1a/);
    expect((await mailJob.dueKeys(new Date(), { pool: db.worker, log: silentLogger }))).not.toContain(`${id}:warning`);

    // Staff event: recruiter and lead, no manager; no name in the inbox or email.
    const ev = await one<{ id: string }>(`SELECT id FROM eureka.outbox_event WHERE type = 'candidate.not_responding' AND payload ->> 'flagId' = $1`, [id]);
    const recipients = (await db.admin.query<{ recipient_id: string; reason: string }>(
      `SELECT * FROM authz.notification_recipients($1) ORDER BY reason`, [ev.id])).rows;
    expect(recipients).toEqual([{ recipient_id: U.l1, reason: "lead" }, { recipient_id: U.r1a, reason: "recruiter" }]);
    const delivery = outboxDeliveryJob(new LocalMail(mailDir), ORIGIN, { batchSize: 500 });
    expect(await new JobRunner(db.worker, [delivery], silentLogger).runOnce(delivery, ev.id)).toBe("ran");
    const inbox = (await db.admin.query<{ recipient_id: string; title: string; body: string; entity_type: string; entity_id: string }>(
      `SELECT recipient_id, title, body, entity_type, entity_id FROM eureka.notification WHERE event_id = $1 ORDER BY recipient_id`, [ev.id])).rows;
    expect(inbox.map((r) => r.recipient_id).sort()).toEqual([U.l1, U.r1a].sort());
    for (const r of inbox) {
      expect(r).toMatchObject({ title: "Candidate not responding", entity_type: "candidate", entity_id: cand.id });
      expect(r.body).not.toMatch(/PlCand|missed/);
    }
    const staffMails = (await readdir(mailDir)).filter((f) => f.startsWith(ev.id));
    expect(staffMails).toHaveLength(2);

    // Hold stage: not before the delay, then exactly once.
    const hold = candidateNonresponseJob(3);
    const todayNy = (await one<{ d: string }>(`SELECT (now() AT TIME ZONE 'America/New_York')::date::text AS d`)).d;
    const r0 = await hold.run(todayNy, { pool: db.worker, log: silentLogger, signal: new AbortController().signal, heartbeat() {} });
    expect(r0.emitted).toBe(0);
    await db.admin.query(`ALTER TABLE eureka.candidate_nonresponse DISABLE TRIGGER candidate_nonresponse_guard`);
    await db.admin.query(`UPDATE eureka.candidate_nonresponse SET flagged_at = now() - interval '4 days' WHERE id = $1`, [id]);
    await db.admin.query(`ALTER TABLE eureka.candidate_nonresponse ENABLE TRIGGER candidate_nonresponse_guard`);
    const r1 = await hold.run(todayNy, { pool: db.worker, log: silentLogger, signal: new AbortController().signal, heartbeat() {} });
    expect(r1.emitted).toBeGreaterThanOrEqual(1);
    const r2 = await hold.run(todayNy, { pool: db.worker, log: silentLogger, signal: new AbortController().signal, heartbeat() {} });
    expect(r2.emitted).toBe(0);
    const holdEv = await one<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM eureka.outbox_event WHERE type = 'candidate.not_responding' AND payload ->> 'flagId' = $1 AND payload ->> 'stage' = 'hold'`, [id]);
    expect(holdEv.payload).toEqual({ candidateId: cand.id, flagId: id, stage: "hold" });
    expect(await mailJob.dueKeys(new Date(), { pool: db.worker, log: silentLogger })).toContain(`${id}:hold`);

    // Resolved before the hold email goes out: never mailed.
    await as(U.r1a, (c) => c.query(`SELECT authz.nonresponse_resolve($1, 'responded')`, [cand.id]));
    expect(await runner.runOnce(mailJob, `${id}:hold`)).toBe("ran");
    expect((await readdir(mailDir)).filter((f) => f === `nonresponse-${id}-hold.json`)).toEqual([]);
    // The database refuses a future day and an out-of-range delay.
    await expect(db.worker.query(`SELECT authz.emit_candidate_nonresponse_hold(current_date + 5, 3)`)).rejects.toThrow(/invalid/);
    await expect(db.worker.query(`SELECT authz.emit_candidate_nonresponse_hold(current_date - 1, 0)`)).rejects.toThrow(/invalid/);
    expect(CANDIDATE_NONRESPONSE_JOB).toBe("candidate-nonresponse");
  });

  it("the worker gets function access only", async () => {
    await expect(db.worker.query(`SELECT * FROM eureka.candidate_nonresponse`)).rejects.toThrow(/permission denied/);
    await expect(db.worker.query(`SELECT * FROM eureka.preferred_vendor`)).rejects.toThrow(/permission denied/);
    await expect(db.worker.query(`SELECT * FROM eureka.assessment`)).rejects.toThrow(/permission denied/);
    await expect(db.worker.query(`SELECT authz.nonresponse_flag(gen_random_uuid(), 'other')`)).rejects.toThrow(/permission denied/);
    await expect(db.app.query(`SELECT * FROM authz.nonresponse_mail_due()`)).rejects.toThrow(/permission denied/);
  });
});
