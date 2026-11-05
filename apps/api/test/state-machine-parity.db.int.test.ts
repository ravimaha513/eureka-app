import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APPLICATION_STATUSES,
  BATCH_STATUSES,
  BGC_STATUSES,
  CANDIDATE_STATUSES,
  CHECKLIST_ITEM_STATUSES,
  JOB_STATUSES,
  PAPERWORK_LOCKED_PLACEMENT_STATUSES,
  PLACEMENT_REASON_REQUIRED,
  PLACEMENT_STATUSES,
  SUBMISSION_STATUSES,
  applicationTransitionAllowed,
  batchTransitionAllowed,
  bgcTransitionAllowed,
  candidateTransitionAllowed,
  checklistItemTransitionAllowed,
  jobTransitionAllowed,
  placementTransitionAllowed,
  submissionTransitionAllowed,
} from "@eureka/shared";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { CLIENT_ID, LOC, T, TECH_ID, U, seedFixtures } from "./fixtures.js";
import { createPlacement, newCandidate, selectedSubmission } from "./placement-seed.js";

/**
 * TS <-> SQL state-machine parity (finding F-12). For every machine whose rules the database
 * re-checks, every (from, to) pair runs through the real write path as an authorised user and
 * must succeed exactly when the shared `*TransitionAllowed` (packages/shared state-machines.ts,
 * jobs.ts) says so; a refusal must be the machine's own error, not some other rule.
 *
 * The `from` state is forced as superuser with triggers off (session_replication_role = replica),
 * then the attempt runs as eureka_app in the same transaction, which is always rolled back.
 */
let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  await db.admin.query(`INSERT INTO authz.checklist_template (kind, placement_type, items) VALUES ('paperwork', 'w2', $1::jsonb)`,
    [JSON.stringify([{ doc_type: "sample_doc_a", owner_role: "hr", required: true }])]);
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

type Attempt = { ok: true } | { ok: false; error: string };

/** Forces the from-state (`force`, triggers off), then runs `call` as `actor` (eureka_app). Rolled back. */
async function attempt(force: [string, unknown[]], actor: string, call: [string, unknown[]]): Promise<Attempt> {
  const c = await db.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    const forced = await c.query(force[0], force[1]);
    expect(forced.rowCount, force[0]).toBe(1);
    await c.query("SET LOCAL session_replication_role = origin");
    await c.query("SET LOCAL ROLE eureka_app");
    await c.query("SELECT set_config('eureka.user_id', $1, true)", [actor]);
    try {
      const r = await c.query(call[0], call[1]);
      // An UPDATE that RLS filtered out is not a success.
      return r.command === "UPDATE" && r.rowCount !== 1 ? { ok: false, error: "no row updated" } : { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    c.release();
  }
}

interface Machine {
  statuses: readonly string[];
  allowed: (from: string, to: string) => boolean;
  /** The refusal the machine itself raises. */
  refusal: RegExp;
  run: (from: string, to: string) => Promise<Attempt>;
}

/** Every pair; returns the pairs where the database disagrees with TS (empty = parity). */
async function mismatches(m: Machine): Promise<string[]> {
  const out: string[] = [];
  for (const from of m.statuses) {
    for (const to of m.statuses) {
      const want = m.allowed(from, to);
      const got = await m.run(from, to);
      if (got.ok !== want) out.push(`${from} -> ${to}: TS ${want ? "allows" : "refuses"}, SQL ${got.ok ? "allows" : `refuses (${got.error})`}`);
      else if (!got.ok && !m.refusal.test(got.error)) out.push(`${from} -> ${to}: refused for another reason (${got.error})`);
    }
  }
  return out;
}

const R1A = { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas };
const REASON = "Fictional reason";

/** A placement row in `status`, with the columns its CHECKs tie to the status. */
const forcePlacement = (id: string, status: string): [string, unknown[]] => [
  `UPDATE eureka.placement SET status = $2,
     status_reason = CASE WHEN $2 IN ('backout', 'bgc_failed', 'joining_issue') THEN 'Fictional' END,
     joined_at = CASE WHEN $2 = 'joined' THEN now() END
   WHERE id = $1`, [id, status]];

async function newPlacement() {
  const cand = await newCandidate(db, R1A);
  const sub = await selectedSubmission(db, U.r1a, cand.id);
  return (await createPlacement(db, U.r1a, sub, { type: "w2" })).id;
}

describe("state machines: TS and SQL accept exactly the same transitions", () => {
  it("candidate (authz.transition_candidate)", async () => {
    const id = (await newCandidate(db, R1A)).id;
    expect(await mismatches({
      statuses: CANDIDATE_STATUSES, allowed: candidateTransitionAllowed, refusal: /invalid transition/,
      run: (from, to) => attempt([`UPDATE eureka.candidate SET marketing_status = $2 WHERE id = $1`, [id, from]],
        U.l1, [`SELECT authz.transition_candidate($1, $2)`, [id, to]]),
    })).toEqual([]);
  });

  it("submission (authz.transition_submission)", async () => {
    const cand = await newCandidate(db, R1A);
    const id = await selectedSubmission(db, U.r1a, cand.id, "submitted");
    expect(await mismatches({
      statuses: SUBMISSION_STATUSES, allowed: submissionTransitionAllowed, refusal: /invalid_transition/,
      run: (from, to) => attempt([`UPDATE eureka.submission SET status = $2, rejection_reason = CASE WHEN $2 = 'rejected' THEN 'Fictional' END WHERE id = $1`, [id, from]],
        U.r1a, [`SELECT authz.transition_submission($1, $2, $3)`, [id, to, to === "rejected" ? REASON : null]]),
    })).toEqual([]);
  });

  it("placement (authz.transition_placement)", async () => {
    const id = await newPlacement();
    // A manager holds placement.bgc_status:update as well (bgc_failed).
    expect(await mismatches({
      statuses: PLACEMENT_STATUSES, allowed: placementTransitionAllowed, refusal: /invalid_transition/,
      run: (from, to) => attempt(forcePlacement(id, from),
        U.m1, [`SELECT * FROM authz.transition_placement($1, $2, $3)`, [id, to, PLACEMENT_REASON_REQUIRED.has(to) ? REASON : null]]),
    })).toEqual([]);
  });

  it("application (authz.application_transition_ok, the only edge check of authz.application_transition)", async () => {
    const out: string[] = [];
    for (const from of APPLICATION_STATUSES) {
      for (const to of APPLICATION_STATUSES) {
        const sql = (await db.admin.query<{ ok: boolean }>(`SELECT authz.application_transition_ok($1, $2) AS ok`, [from, to])).rows[0]!.ok;
        if (sql !== applicationTransitionAllowed(from, to)) out.push(`${from} -> ${to}: SQL ${sql}`);
      }
    }
    expect(out).toEqual([]);
  });

  it("job (eureka.job_guard on UPDATE; JP-3a); saving the unchanged status always passes", async () => {
    const id = await asUser(db.app, U.m1, async (c) => (await c.query<{ id: string }>(
      `INSERT INTO eureka.job (kind, title, category, experience_level, employment_type, work_mode, client_id)
       VALUES ('client_requirement', 'Parity job', 'engineering', 'mid', 'full_time', 'remote', $1) RETURNING id`, [CLIENT_ID])).rows[0]!.id, true);
    expect(await mismatches({
      statuses: JOB_STATUSES, allowed: (from, to) => from === to || jobTransitionAllowed(from, to), refusal: /invalid_transition/,
      run: (from, to) => attempt([`UPDATE eureka.job SET status = $2 WHERE id = $1`, [id, from]],
        U.m1, [`UPDATE eureka.job SET status = $2 WHERE id = $1`, [id, to]]),
    })).toEqual([]);
  });

  it("training batch (authz.set_batch_status)", async () => {
    const id = await asUser(db.app, U.locD, async (c) => (await c.query<{ id: string }>(
      `SELECT authz.create_batch($1, $2, '2034-03-01'::date, NULL) AS id`, [LOC.dallas, TECH_ID])).rows[0]!.id, true);
    expect(await mismatches({
      statuses: BATCH_STATUSES, allowed: batchTransitionAllowed, refusal: /invalid_transition/,
      run: (from, to) => attempt([`UPDATE eureka.batch SET status = $2 WHERE id = $1`, [id, from]],
        U.locD, [`SELECT authz.set_batch_status($1, $2)`, [id, to]]),
    })).toEqual([]);
  });

  it("checklist item (authz.update_checklist_item)", async () => {
    const placement = await newPlacement();
    const item = (await db.admin.query<{ id: string }>(
      `SELECT id FROM eureka.checklist_item WHERE placement_id = $1 AND doc_type = 'sample_doc_a'`, [placement])).rows[0]!.id;
    expect(await mismatches({
      statuses: CHECKLIST_ITEM_STATUSES, allowed: checklistItemTransitionAllowed, refusal: /invalid_transition/,
      run: (from, to) => attempt([`UPDATE eureka.checklist_item SET status = $2, status_reason = CASE WHEN $2 = 'waived' THEN 'Fictional' END WHERE id = $1`, [item, from]],
        U.hr, [`SELECT * FROM authz.update_checklist_item($1, $2::jsonb, NULL)`, [item, JSON.stringify({ status: to, reason: REASON })]]),
    })).toEqual([]);
  });

  it("background check (authz.update_bgc)", async () => {
    const placement = await newPlacement();
    // The record exists from the first write (not_started until a status is set).
    await asUser(db.app, U.hr, (c) => c.query(`SELECT authz.update_bgc($1, '{"notes":"Fictional"}', NULL)`, [placement]), true);
    expect(await mismatches({
      statuses: BGC_STATUSES, allowed: bgcTransitionAllowed, refusal: /invalid_transition/,
      run: (from, to) => attempt([`UPDATE eureka.bgc SET status = $2, status_reason = CASE WHEN $2 = 'failed' THEN 'Fictional' END WHERE placement_id = $1`, [placement, from]],
        U.hr, [`SELECT * FROM authz.update_bgc($1, $2::jsonb, NULL)`, [placement, JSON.stringify({
          status: to, reason: REASON, ...(to === "cleared" ? { actualStart: "2026-12-01" } : {}) })]]),
    })).toEqual([]);
  });

  it("paperwork locks on exactly PAPERWORK_LOCKED_PLACEMENT_STATUSES (placement_closed)", async () => {
    const placement = await newPlacement();
    const out: string[] = [];
    for (const status of PLACEMENT_STATUSES) {
      const got = await attempt(forcePlacement(placement, status),
        U.hr, [`SELECT * FROM authz.update_bgc($1, '{"notes":"Fictional"}', NULL)`, [placement]]);
      const locked = !got.ok && /placement_closed/.test(got.error);
      if (locked !== PAPERWORK_LOCKED_PLACEMENT_STATUSES.has(status) || (!got.ok && !locked)) {
        out.push(`${status}: ${got.ok ? "accepted" : got.error}`);
      }
    }
    expect(out).toEqual([]);
  });
});
