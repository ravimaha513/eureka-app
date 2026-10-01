import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityVisible, resolveScope } from "@eureka/shared";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { CLIENT_ID, LOC, T, U, seedFixtures, toUserAccess, type FixtureCandidate } from "./fixtures.js";
import { at, seedPipeline, type PipelineSeed } from "./pipeline-seed.js";

/**
 * Database-only checks for migration 0017: every rule holds with the API
 * removed (design B8: RLS, WITH CHECK, trigger and definer-function tests).
 */
let db: TestDb;
let candidates: FixtureCandidate[];
let seed: PipelineSeed;

beforeAll(async () => {
  db = await createTestDb();
  candidates = await seedFixtures(db.admin);
  seed = await seedPipeline(db, candidates);
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

const users = Object.keys(U) as (keyof typeof U)[];
const ownR1a = () => candidates.find((c) => c.recruiterId === U.r1a && c.marketingStatus === "active" && c.locationId === LOC.dallas)!;

async function newSubmission(actor = U.r1a, cand = ownR1a()): Promise<string> {
  return asUser(db.app, actor, async (c) => (await c.query<{ id: string }>(
    `INSERT INTO eureka.submission (candidate_id, job_title, client_id) VALUES ($1,'x',$2) RETURNING id`,
    [cand.id, CLIENT_ID])).rows[0]!.id, true);
}
let hour = 5000;
async function newInterview(sub: string, actor = U.r1a): Promise<string> {
  hour += 3;
  return asUser(db.app, actor, async (c) => (await c.query<{ id: string }>(
    `INSERT INTO eureka.interview (submission_id, round, starts_at, ends_at) VALUES ($1,'L1',$2,$3) RETURNING id`,
    [sub, at(hour), at(hour + 1)])).rows[0]!.id, true);
}
const transition = (actor: string | null, id: string | null, to: string | null, reason: string | null = null) =>
  (actor ? asUser(db.app, actor, (c) => c.query(`SELECT authz.transition_submission($1,$2,$3) AS s`, [id, to, reason]), true)
    : db.app.query(`SELECT authz.transition_submission($1,$2,$3) AS s`, [id, to, reason]));

describe("submission transitions in the database", () => {
  it("the app cannot write status (or anything) on submission directly", async () => {
    const id = await newSubmission();
    await expect(asUser(db.app, U.r1a, (c) => c.query(`UPDATE eureka.submission SET status = 'selected' WHERE id = $1`, [id])))
      .rejects.toThrow(/permission denied/);
    await expect(asUser(db.app, U.r1a, (c) => c.query(`UPDATE eureka.submission SET job_title = 'y' WHERE id = $1`, [id])))
      .rejects.toThrow(/permission denied/);
  });

  it("the status guard refuses status changes outside the definer, even for the table owner path", async () => {
    const id = await newSubmission();
    await expect(db.admin.query(`UPDATE eureka.submission SET status = 'selected' WHERE id = $1`, [id]))
      .rejects.toThrow(/must use a transition/);
  });

  it("valid steps succeed and record who and when", async () => {
    const id = await newSubmission();
    expect((await transition(U.r1a, id, "under_review")).rows[0].s).toBe("under_review");
    const row = (await db.admin.query(`SELECT status, status_changed_by, status_changed_at FROM eureka.submission WHERE id = $1`, [id])).rows[0];
    expect(row.status).toBe("under_review");
    expect(row.status_changed_by).toBe(U.r1a);
    expect(row.status_changed_at).not.toBeNull();
  });

  it.each([
    ["NULL target", "under_review", null, null, /invalid_transition/],
    ["unknown target", "under_review", "bogus", null, /invalid_transition/],
    ["skip", "under_review", "interview_scheduled", null, /invalid_transition/],
    ["backward", "under_review", "submitted", null, /invalid_transition/],
    ["reject without reason", "under_review", "rejected", null, /rejection_reason_required/],
    ["reject with blank reason", "under_review", "rejected", "   ", /rejection_reason_required/],
    ["reason on a non-rejection", "under_review", "withdrawn", "because", /rejection_reason_not_allowed/],
  ])("refuses %s", async (_n, setup, to, reason, err) => {
    const id = await newSubmission();
    await transition(U.r1a, id, setup);
    await expect(transition(U.r1a, id, to, reason)).rejects.toThrow(err);
  });

  it("terminal states are final", async () => {
    const id = await newSubmission();
    await transition(U.r1a, id, "rejected", "Rate too high");
    for (const to of ["withdrawn", "under_review", "selected", "rejected"]) {
      await expect(transition(U.r1a, id, to, to === "rejected" ? "again" : null)).rejects.toThrow(/invalid_transition/);
    }
  });

  it("NULL ids, missing user context and out-of-scope callers get not-found; visible but not owned get not_permitted", async () => {
    const id = await newSubmission();
    await expect(transition(U.r1a, null, "under_review")).rejects.toThrow(/submission_not_found/);
    await expect(transition(null, id, "under_review")).rejects.toThrow(/submission_not_found/);
    await expect(transition(U.r1b, id, "under_review")).rejects.toThrow(/submission_not_found/);
    await expect(transition(U.r3a, id, "under_review")).rejects.toThrow(/submission_not_found/);
    await expect(transition(U.locD, id, "under_review")).rejects.toThrow(/not_permitted/); // location read, no update
    await expect(transition(U.ceo, id, "under_review")).rejects.toThrow(/not_permitted/);
    expect((await transition(U.m1, id, "under_review")).rows[0].s).toBe("under_review");
  });

  it("a rejected row needs a reason at the table level too", async () => {
    const id = await newSubmission();
    await db.admin.query(`ALTER TABLE eureka.submission DISABLE TRIGGER submission_status_guard`);
    try {
      await expect(db.admin.query(`UPDATE eureka.submission SET status = 'rejected' WHERE id = $1`, [id]))
        .rejects.toThrow(/submission_rejection_reason/);
    } finally {
      await db.admin.query(`ALTER TABLE eureka.submission ENABLE TRIGGER submission_status_guard`);
    }
  });
});

describe("interview guard, consent and conflicts in the database", () => {
  const upd = (actor: string, id: string, set: string) =>
    asUser(db.app, actor, (c) => c.query(`UPDATE eureka.interview SET ${set} WHERE id = $1`, [id]), true);

  it("Sales grants edit logistics but not location fields; location grants the reverse", async () => {
    const id = await newInterview(await newSubmission());
    await expect(upd(U.r1a, id, "cleared = true")).rejects.toThrow(/field_not_permitted/);
    await expect(upd(U.r1a, id, "consent_captured = true")).rejects.toThrow(/field_not_permitted/);
    await expect(upd(U.locD, id, "round = 'L9'")).rejects.toThrow(/field_not_permitted/);
    await expect(upd(U.locD, id, "starts_at = starts_at + interval '1 minute'")).rejects.toThrow(/field_not_permitted/);
    expect((await upd(U.r1a, id, "round = 'L2', call_status = 'in_progress'")).rowCount).toBe(1);
    expect((await upd(U.locD, id, "cleared = true, call_status = 'completed'")).rowCount).toBe(1);
    const row = (await db.admin.query(`SELECT cleared_by, cleared_at FROM eureka.interview WHERE id = $1`, [id])).rows[0];
    expect(row.cleared_by).toBe(U.locD);
    expect(row.cleared_at).not.toBeNull();
    // Other location, teammate, other team: row filtered by RLS (0 rows).
    for (const u of [U.locA, U.r1b, U.r3a]) expect((await upd(u, id, "call_status = 'scheduled'")).rowCount).toBe(0);
  });

  it("server-managed columns cannot be written by the app", async () => {
    const id = await newInterview(await newSubmission());
    await expect(upd(U.locD, id, "cleared_by = NULL, cleared_at = now()")).rejects.toThrow(/permission denied/);
    await expect(upd(U.r1a, id, "feedback_email_sent_at = now()")).rejects.toThrow(/permission denied/);
    await expect(upd(U.r1a, id, "client_id = NULL")).rejects.toThrow(/permission denied/);
    await expect(asUser(db.app, U.r1a, (c) => c.query(
      `INSERT INTO eureka.interview (submission_id, round, starts_at, ends_at, cleared) VALUES ($1,'x',$2,$3,true)`,
      [seed.submissions[0]!.id, at(9990), at(9991)]))).rejects.toThrow(/server_managed_field|row-level/);
    await expect(asUser(db.app, U.r1a, (c) => c.query(
      `INSERT INTO eureka.interview (submission_id, round, starts_at, ends_at, client_id) VALUES ($1,'x',$2,$3,gen_random_uuid())`,
      [seed.submissions[0]!.id, at(9992), at(9993)]))).rejects.toThrow(/set by the server/);
  });

  it("recording links need consent (AS-12)", async () => {
    const id = await newInterview(await newSubmission());
    await expect(upd(U.r1a, id, "otter_url = 'https://otter.ai/x'")).rejects.toThrow(/interview_recording_consent/);
    await upd(U.locD, id, "consent_captured = true");
    await upd(U.r1a, id, "recording_url = 'https://drive.example/rec'");
    await expect(upd(U.locD, id, "consent_captured = false")).rejects.toThrow(/interview_recording_consent/);
  });

  it("overlapping live interviews for one candidate are refused; cancelled ones do not count", async () => {
    const sub = await newSubmission();
    const a = await newInterview(sub);
    const row = (await db.admin.query(`SELECT starts_at FROM eureka.interview WHERE id = $1`, [a])).rows[0];
    const ins = (actor: string, s: string) => asUser(db.app, actor, (c) => c.query(
      `INSERT INTO eureka.interview (submission_id, round, starts_at, ends_at) VALUES ($1,'L2',$2::timestamptz + interval '30 minutes',$2::timestamptz + interval '90 minutes')`,
      [s, row.starts_at]), true);
    // Another team's submission of the same (Open-to-all-teams) candidate still conflicts.
    const shared = candidates.find((c) => c.teamId === T.t3 && c.visibility === "all_teams" && c.marketingStatus === "active")!;
    const s3 = await newSubmission(U.r3a, shared);
    const s2 = await newSubmission(U.r2a, shared);
    const first = await newInterview(s3, U.r3a);
    const t = (await db.admin.query(`SELECT starts_at FROM eureka.interview WHERE id = $1`, [first])).rows[0].starts_at;
    await expect(asUser(db.app, U.r2a, (c) => c.query(
      `INSERT INTO eureka.interview (submission_id, round, starts_at, ends_at) VALUES ($1,'L1',$2,$2::timestamptz + interval '1 hour')`,
      [s2, t]))).rejects.toThrow(/interview_no_overlap/);
    await expect(ins(U.r1a, sub)).rejects.toThrow(/interview_no_overlap/);
    await upd(U.r1a, a, "call_status = 'cancelled'");
    expect((await ins(U.r1a, sub)).rowCount).toBe(1);
  });

  it("no interview on a closed submission", async () => {
    const sub = await newSubmission();
    await transition(U.r1a, sub, "withdrawn");
    await expect(newInterview(sub)).rejects.toThrow(/submission_closed/);
    // An out-of-scope caller learns nothing about the submission's state.
    await expect(newInterview(sub, U.r3a)).rejects.toThrow(/row-level security/);
  });

  it("the worker changes only feedback_email_sent_at", async () => {
    const sub = await newSubmission(U.r1b, candidates.find((c) => c.recruiterId === U.r1b && c.marketingStatus === "active")!);
    const id = await asUser(db.app, U.r1b, async (c) => (await c.query<{ id: string }>(
      `INSERT INTO eureka.interview (submission_id, round, starts_at, ends_at)
       VALUES ($1,'L1', now() - interval '3 hours', now() - interval '2 hours') RETURNING id`, [sub])).rows[0]!.id, true);
    await expect(db.worker.query(`UPDATE eureka.interview SET cleared = true WHERE id = $1`, [id])).rejects.toThrow(/permission denied/);
    expect((await db.worker.query(`UPDATE eureka.interview SET feedback_email_sent_at = now() WHERE id = $1`, [id])).rowCount).toBe(1);
  });
});

describe("interview_feedback", () => {
  const add = (actor: string, interview: string, kind: string, author: string | null = actor) =>
    asUser(db.app, actor, (c) => c.query(
      `INSERT INTO eureka.interview_feedback (interview_id, author_id, kind, rating) VALUES ($1,$2,$3,4)`, [interview, author, kind]), true);

  beforeAll(async () => {
    // Each interview gets feedback from everyone entitled to one kind of it.
    for (const i of seed.interviews) {
      if (i.teamId === T.t2 || i.candidate.teamId === T.t2) await add(U.coach, i.id, "coach");
      if (i.locationId === LOC.dallas) await add(U.locD, i.id, "location");
      if (i.locationId === LOC.austin) await add(U.locA, i.id, "location");
      await add(i.recruiterId, i.id, "client");
    }
  });

  it.each(users)("RLS alone returns feedback on exactly the engine-visible interviews for %s", async (key) => {
    const scope = resolveScope(toUserAccess(key), "interview:read");
    const seeded = new Set(seed.interviews.map((i) => i.id));
    const expected = seed.interviews.filter((i) => activityVisible(scope, i)).map((i) => i.id).sort();
    const got = await asUser(db.app, U[key], async (c) =>
      (await c.query<{ id: string }>(`SELECT DISTINCT interview_id AS id FROM eureka.interview_feedback`)).rows
        .map((r) => r.id).filter((id) => seeded.has(id)).sort());
    expect(got).toEqual(expected);
  });

  it("authors write only as themselves, only kinds their grant covers, never 'candidate'", async () => {
    const i = seed.interviews.find((x) => x.recruiterId === U.r1a && x.locationId === LOC.dallas)!;
    await expect(add(U.r1a, i.id, "client", U.r1b)).rejects.toThrow(/row-level security/);
    await expect(add(U.r1a, i.id, "location")).rejects.toThrow(/row-level security/);
    await expect(add(U.r1a, i.id, "coach")).rejects.toThrow(/row-level security/);
    await expect(add(U.r1a, i.id, "candidate", null)).rejects.toThrow(/row-level security/);
    await expect(add(U.locA, i.id, "location")).rejects.toThrow(/row-level security/);
    await expect(add(U.coach, i.id, "coach")).rejects.toThrow(/row-level security/);
    await expect(add(U.r1b, i.id, "client")).rejects.toThrow(/row-level security/);
    await expect(asUser(db.app, U.r1a, (c) => c.query(
      `INSERT INTO eureka.interview_feedback (interview_id, author_id, kind, rating, created_at) VALUES ($1,$2,'client',3, now() - interval '1 year')`,
      [i.id, U.r1a]))).rejects.toThrow(/permission denied/);
    expect((await add(U.l1, i.id, "client")).rowCount).toBe(1);
    // Owning the candidate is enough to add client feedback on another team's interview of it.
    const cross = seed.interviews.find((x) => x.recruiterId === U.r2a && x.candidate.teamId === T.t3)!;
    expect((await add(U.l3, cross.id, "client")).rowCount).toBe(1);
  });

  it("feedback is append-only, even for the table owner", async () => {
    await expect(asUser(db.app, U.r1a, (c) => c.query(`UPDATE eureka.interview_feedback SET rating = 1`))).rejects.toThrow(/permission denied/);
    await expect(asUser(db.app, U.r1a, (c) => c.query(`DELETE FROM eureka.interview_feedback`))).rejects.toThrow(/permission denied/);
    await expect(db.admin.query(`UPDATE eureka.interview_feedback SET rating = 1`)).rejects.toThrow(/append-only/);
    await expect(db.admin.query(`DELETE FROM eureka.interview_feedback`)).rejects.toThrow(/append-only/);
  });

  it("the worker and org_admin read no feedback", async () => {
    await expect(db.worker.query(`SELECT * FROM eureka.interview_feedback`)).rejects.toThrow(/permission denied/);
    const n = await asUser(db.app, U.admin, async (c: pg.PoolClient) => (await c.query(`SELECT count(*)::int n FROM eureka.interview_feedback`)).rows[0].n);
    expect(n).toBe(0);
  });

  it("feedback_kind_allowed is NULL-safe", async () => {
    const i = seed.interviews[0]!;
    const q = (actor: string | null, id: string | null, kind: string | null) =>
      actor ? asUser(db.app, actor, async (c) => (await c.query(`SELECT authz.feedback_kind_allowed($1,$2) AS ok`, [id, kind])).rows[0].ok)
        : db.app.query(`SELECT authz.feedback_kind_allowed($1,$2) AS ok`, [id, kind]).then((r) => r.rows[0].ok);
    expect(await q(i.recruiterId, i.id, null)).toBe(false);
    expect(await q(i.recruiterId, null, "client")).toBe(false);
    expect(await q(null, i.id, "client")).toBe(false);
    expect(await q(i.recruiterId, i.id, "client")).toBe(true);
  });
});

describe("activity read policies (0034: owned candidates as a hashed set)", () => {
  const visible = async (key: keyof typeof U, table: "submission" | "interview", seeded: { id: string }[]) => {
    const ids = new Set(seeded.map((s) => s.id));
    return asUser(db.app, U[key], async (c) =>
      (await c.query<{ id: string }>(`SELECT id FROM eureka.${table}`)).rows.map((r) => r.id).filter((id) => ids.has(id)).sort());
  };

  it.each(users)("RLS alone returns exactly the engine-visible submissions and interviews for %s", async (key) => {
    const access = toUserAccess(key);
    const subScope = resolveScope(access, "submission:read");
    const intScope = resolveScope(access, "interview:read");
    expect(await visible(key, "submission", seed.submissions))
      .toEqual(seed.submissions.filter((s) => activityVisible(subScope, s)).map((s) => s.id).sort());
    expect(await visible(key, "interview", seed.interviews))
      .toEqual(seed.interviews.filter((i) => activityVisible(intScope, i)).map((i) => i.id).sort());
  });

  it("a row admitted only through candidate ownership stays visible", async () => {
    // r2a (team t2) submitted t3's Open-to-all-teams candidates: t3's lead sees them through the candidate only.
    const viaCandidate = seed.submissions.filter((s) => s.recruiterId === U.r2a && s.candidate.teamId === T.t3);
    expect(viaCandidate.length).toBeGreaterThan(0);
    expect(await visible("l3", "submission", viaCandidate)).toEqual(viaCandidate.map((s) => s.id).sort());
    expect(await visible("r1a", "submission", viaCandidate)).toEqual([]);
  });

  it.each(["submission", "interview"] as const)("the %s read policy probes a hashed set, never an array per row", async (table) => {
    const plan = await asUser(db.app, U.r1a, async (c) =>
      (await c.query<{ "QUERY PLAN": string }>(`EXPLAIN SELECT count(*) FROM eureka.${table}`)).rows.map((r) => r["QUERY PLAN"]).join("\n"));
    expect(plan).toMatch(/hashed SubPlan/);
    expect(plan).not.toMatch(/candidate_id = ANY/);
    const { rows } = await db.admin.query<{ qual: string }>(
      `SELECT qual FROM pg_policies WHERE schemaname = 'eureka' AND tablename = $1 AND policyname = $2`, [table, `${table}_read`]);
    expect(rows[0]!.qual).toMatch(/unnest\(\( SELECT authz\.owned_candidate_ids/);
  });
});
