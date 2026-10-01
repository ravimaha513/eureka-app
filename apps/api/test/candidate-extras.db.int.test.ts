import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityVisible, can, candidateVisible, canCreateBatch, resolveScope, type CandidateRef, type Permission } from "@eureka/shared";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, TECH_ID, U, seedFixtures, toUserAccess, type FixtureCandidate } from "./fixtures.js";
import { seedPipeline } from "./pipeline-seed.js";
import { createPlacement, newCandidate, selectedSubmission, transitionPlacement } from "./placement-seed.js";

/**
 * Database-only checks for migration 0026 (batches, candidate_event timeline,
 * duplicate check): every rule holds with the API removed (design B8).
 */
let db: TestDb;
let candidates: FixtureCandidate[];
const users = Object.keys(U) as (keyof typeof U)[];

beforeAll(async () => {
  db = await createTestDb();
  candidates = await seedFixtures(db.admin);
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

const createBatch = (actor: string, location: string, month: string, size: number | null = 20) =>
  asUser(db.app, actor, async (c) =>
    (await c.query<{ id: string }>(`SELECT authz.create_batch($1, $2, $3::date, $4) AS id`, [location, TECH_ID, month, size])).rows[0]!.id, true);

const events = async (candidateId: string) =>
  (await db.admin.query(
    `SELECT type, actor_id, ref_type, ref_id, from_value, to_value FROM eureka.candidate_event WHERE candidate_id = $1 ORDER BY id`,
    [candidateId])).rows;

/** Superuser write with triggers off (test setup only). */
async function force(sql: string, params: unknown[]) {
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

describe("batches", () => {
  let dallasBatch: string;

  beforeAll(async () => {
    dallasBatch = await createBatch(U.l1, LOC.dallas, "2026-11-17");
  });

  it("Sales leadership creates batches; the server sets month start, status, creator and time", async () => {
    const { rows } = await db.admin.query(`SELECT * FROM eureka.batch WHERE id = $1`, [dallasBatch]);
    expect(rows[0]).toMatchObject({ location_id: LOC.dallas, technology_id: TECH_ID, size_planned: 20, status: "planned", created_by: U.l1 });
    expect(rows[0].start_month.toISOString().slice(0, 7)).toBe("2026-11");
    expect(await createBatch(U.m1, LOC.austin, "2026-12-01", null)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each(users)("authz.create_batch for %s matches the engine (canCreateBatch)", async (key) => {
    const month = `${2030 + users.indexOf(key)}-03-01`; // one batch per user, no collisions
    const run = asUser(db.app, U[key], (c) =>
      c.query(`SELECT authz.create_batch($1, $2, $3::date, 10)`, [LOC.austin, TECH_ID, month]));
    if (canCreateBatch(toUserAccess(key))) await expect(run).resolves.toBeDefined();
    else await expect(run).rejects.toThrow(/not_permitted/);
  });

  it("refuses duplicates, bad input and a missing user context", async () => {
    await expect(createBatch(U.l1, LOC.dallas, "2026-11-01")).rejects.toThrow(/batch_exists/);
    await expect(createBatch(U.l1, LOC.dallas, "2028-01-01", 0)).rejects.toThrow(/invalid_batch/);
    await expect(createBatch(U.l1, "00000000-0000-0000-0000-00000000beef", "2028-01-01")).rejects.toThrow(/invalid_batch/);
    await expect(db.app.query(`SELECT authz.create_batch($1, $2, '2028-02-01', 5)`, [LOC.dallas, TECH_ID])).rejects.toThrow(/not_permitted/);
  });

  it("the app cannot write batches directly; nobody updates or deletes them outside the functions", async () => {
    await expect(asUser(db.app, U.l1, (c) => c.query(
      `INSERT INTO eureka.batch (location_id, technology_id, start_month, created_by) VALUES ($1,$2,'2029-01-01',$3)`,
      [LOC.dallas, TECH_ID, U.l1]))).rejects.toThrow(/permission denied/);
    await expect(asUser(db.app, U.l1, (c) => c.query(`UPDATE eureka.batch SET status = 'cancelled'`))).rejects.toThrow(/permission denied/);
    await expect(db.admin.query(`UPDATE eureka.batch SET status = 'cancelled' WHERE id = $1`, [dallasBatch])).rejects.toThrow(/written only by definer/);
    await expect(db.admin.query(`DELETE FROM eureka.batch WHERE id = $1`, [dallasBatch])).rejects.toThrow(/written only by definer/);
  });

  it.each(users)("batch rows readable by %s: every candidate:read holder, nobody else", async (key) => {
    const total = (await db.admin.query(`SELECT count(*)::int n FROM eureka.batch`)).rows[0].n;
    const n = await asUser(db.app, U[key], async (c) => (await c.query(`SELECT count(*)::int n FROM eureka.batch`)).rows[0].n);
    expect(n).toBe(can(toUserAccess(key), "candidate:read") ? total : 0);
  });

  describe("assigning candidates (candidate.batch_id)", () => {
    const ownDallas = () => candidates.find((c) => c.recruiterId === U.r1a && c.locationId === LOC.dallas && c.visibility === "team")!;
    const ownAustin = () => candidates.find((c) => c.recruiterId === U.r1a && c.locationId === LOC.austin && c.visibility === "team")!;

    it("candidate:update holders assign a batch of the candidate's location and the change is on the timeline", async () => {
      const id = ownDallas().id;
      const n = await asUser(db.app, U.r1a, async (c) =>
        (await c.query(`UPDATE eureka.candidate SET batch_id = $2 WHERE id = $1`, [id, dallasBatch])).rowCount, true);
      expect(n).toBe(1);
      expect((await events(id)).at(-1)).toEqual({ type: "candidate.batch_changed", actor_id: U.r1a, ref_type: "batch", ref_id: dallasBatch, from_value: null, to_value: null });
    });

    it("refuses a batch at another location", async () => {
      await expect(asUser(db.app, U.r1a, (c) => c.query(`UPDATE eureka.candidate SET batch_id = $2 WHERE id = $1`, [ownAustin().id, dallasBatch])))
        .rejects.toThrow(/batch_not_allowed/);
    });

    it("refuses a completed or cancelled batch", async () => {
      const closed = await createBatch(U.l1, LOC.austin, "2026-06-01");
      await force(`UPDATE eureka.batch SET status = 'completed' WHERE id = $1`, [closed]);
      await expect(asUser(db.app, U.r1a, (c) => c.query(`UPDATE eureka.candidate SET batch_id = $2 WHERE id = $1`, [ownAustin().id, closed])))
        .rejects.toThrow(/batch_not_allowed/);
    });

    it("a rating-only location grant cannot change the batch (column guard)", async () => {
      const dallasOther = candidates.find((c) => c.locationId === LOC.dallas && c.teamId === T.t3)!;
      await expect(asUser(db.app, U.locD, (c) => c.query(`UPDATE eureka.candidate SET batch_id = $2 WHERE id = $1`, [dallasOther.id, dallasBatch])))
        .rejects.toThrow(/not permitted to update profile fields/);
    });

    it("a teammate's candidate cannot be assigned by a recruiter (RLS / guard)", async () => {
      const mate = candidates.find((c) => c.recruiterId === U.r1b && c.locationId === LOC.dallas)!;
      const n = await asUser(db.app, U.r1a, async (c) => {
        try { return (await c.query(`UPDATE eureka.candidate SET batch_id = $2 WHERE id = $1`, [mate.id, dallasBatch])).rowCount; }
        catch (e) { return (e as Error).message; }
      });
      expect([0, "not permitted to update profile fields"]).toContain(n);
      expect((await db.admin.query(`SELECT batch_id FROM eureka.candidate WHERE id = $1`, [mate.id])).rows[0].batch_id).toBeNull();
    });
  });
});

describe("candidate_event: rows written for each action", () => {
  it("creation, status, visibility, rating and assignment", async () => {
    const created = await asUser(db.app, U.l1, async (c) => {
      await c.query(`INSERT INTO eureka.person (id, first_name, last_name) VALUES ('00000000-0000-0000-0000-0000000e0001','Ev','Ent')`);
      return (await c.query<{ id: string }>(
        `INSERT INTO eureka.candidate (person_id, technology_id, team_id, recruiter_id, location_id)
         VALUES ('00000000-0000-0000-0000-0000000e0001', $1, $2, $3, $4) RETURNING id`, [TECH_ID, T.t1, U.r1a, LOC.dallas])).rows[0]!.id;
    }, true);
    await asUser(db.app, U.l1, (c) => c.query(`SELECT authz.transition_candidate($1, 'active')`, [created]), true);
    await asUser(db.app, U.l1, (c) => c.query(`UPDATE eureka.candidate SET visibility = 'all_teams' WHERE id = $1`, [created]), true);
    await asUser(db.app, U.locD, (c) => c.query(`UPDATE eureka.candidate SET technical_rating = 4 WHERE id = $1`, [created]), true);
    await asUser(db.app, U.l1, (c) => c.query(`UPDATE eureka.candidate SET recruiter_id = $2 WHERE id = $1`, [created, U.r1b]), true);
    // A profile edit that touches none of the tracked columns adds nothing.
    await asUser(db.app, U.r1b, (c) => c.query(`UPDATE eureka.candidate SET priority = 'P1' WHERE id = $1`, [created]), true);
    expect(await events(created)).toEqual([
      { type: "candidate.created", actor_id: U.l1, ref_type: null, ref_id: null, from_value: null, to_value: "in_training" },
      { type: "candidate.status_changed", actor_id: U.l1, ref_type: null, ref_id: null, from_value: "in_training", to_value: "active" },
      { type: "candidate.visibility_changed", actor_id: U.l1, ref_type: null, ref_id: null, from_value: "team", to_value: "all_teams" },
      { type: "candidate.rating_changed", actor_id: U.locD, ref_type: null, ref_id: null, from_value: null, to_value: "4" },
      { type: "candidate.assigned", actor_id: U.l1, ref_type: "team", ref_id: T.t1, from_value: null, to_value: null },
    ]);
  });

  it("submissions, interviews and placements (including the candidate status they drive)", async () => {
    const cand = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
    const sub = await selectedSubmission(db, U.r1a, cand.id, "interview_scheduled");
    const interview = await asUser(db.app, U.r1a, async (c) => (await c.query<{ id: string }>(
      `INSERT INTO eureka.interview (submission_id, round, starts_at, ends_at)
       VALUES ($1, 'L1', '2031-03-01T15:00:00Z', '2031-03-01T16:00:00Z') RETURNING id`, [sub])).rows[0]!.id, true);
    await asUser(db.app, U.r1a, (c) => c.query(`UPDATE eureka.interview SET call_status = 'completed' WHERE id = $1`, [interview]), true);
    await asUser(db.app, U.locD, (c) => c.query(`UPDATE eureka.interview SET cleared = true WHERE id = $1`, [interview]), true);
    for (const to of ["interview_completed", "selected"]) {
      await asUser(db.app, U.r1a, (c) => c.query(`SELECT authz.transition_submission($1, $2, NULL)`, [sub, to]), true);
    }
    const placement = await createPlacement(db, U.r1a, sub);
    await transitionPlacement(db, U.r1a, placement.id, "paperwork");
    await transitionPlacement(db, U.r1a, placement.id, "backout", "Candidate accepted another offer");

    const rows = await events(cand.id);
    const view = rows.map((r) => [r.type, r.ref_type, r.from_value, r.to_value]);
    expect(view).toEqual([
      ["candidate.created", null, null, "active"],
      ["submission.created", "submission", null, "submitted"],
      ["submission.status_changed", "submission", "submitted", "under_review"],
      ["submission.status_changed", "submission", "under_review", "interview_requested"],
      ["submission.status_changed", "submission", "interview_requested", "interview_scheduled"],
      ["interview.scheduled", "interview", null, "scheduled"],
      ["interview.status_changed", "interview", "scheduled", "completed"],
      ["interview.cleared", "interview", null, "cleared"],
      ["submission.status_changed", "submission", "interview_scheduled", "interview_completed"],
      ["submission.status_changed", "submission", "interview_completed", "selected"],
      ["placement.created", "placement", null, "confirmed"],
      ["candidate.status_changed", null, "active", "confirmation"],
      ["placement.status_changed", "placement", "confirmed", "paperwork"],
      ["candidate.status_changed", null, "confirmation", "active"],
      ["placement.status_changed", "placement", "paperwork", "backout"],
    ]);
    expect(rows.filter((r) => r.ref_type === "placement").every((r) => r.ref_id === placement.id)).toBe(true);
    expect(rows.find((r) => r.type === "interview.cleared")!.actor_id).toBe(U.locD);
  });

  it("carries no free text: the backout reason, names, phones and rates appear nowhere", async () => {
    const { rows } = await db.admin.query(`SELECT to_jsonb(e)::text AS j FROM eureka.candidate_event e`);
    const all = rows.map((r) => r.j).join("\n");
    expect(all).not.toMatch(/another offer|\+1469|Java Developer|"55"|Ev|Ent/);
  });

  it("is append-only and written only by the definer triggers (even the owner is refused)", async () => {
    const someCand = candidates[0]!.id;
    await expect(asUser(db.app, U.l1, (c) => c.query(
      `INSERT INTO eureka.candidate_event (candidate_id, type) VALUES ($1, 'candidate.created')`, [someCand]))).rejects.toThrow(/permission denied/);
    await expect(asUser(db.app, U.admin, (c) => c.query(`DELETE FROM eureka.candidate_event`))).rejects.toThrow(/permission denied/);
    await expect(db.admin.query(`UPDATE eureka.candidate_event SET to_value = 'x' WHERE candidate_id = $1`, [someCand])).rejects.toThrow(/written only by definer/);
    await expect(db.admin.query(`DELETE FROM eureka.candidate_event WHERE candidate_id = $1`, [someCand])).rejects.toThrow(/written only by definer/);
    await expect(db.admin.query(`INSERT INTO eureka.candidate_event (candidate_id, type) VALUES ($1, 'candidate.created')`, [someCand]))
      .rejects.toThrow(/written only by definer/);
  });

  it("the internal writer and trigger functions are not executable by the app", async () => {
    await expect(asUser(db.app, U.l1, (c) => c.query(
      `SELECT authz.add_candidate_event($1, 'candidate.created', NULL, NULL, NULL, 'active')`, [candidates[0]!.id]))).rejects.toThrow(/permission denied/);
    await expect(asUser(db.app, U.l1, (c) => c.query(`SELECT authz.batch_manager()`))).rejects.toThrow(/permission denied/);
  });
});

describe("candidate_event: RLS differential against the engine", () => {
  const READ_PERM: Record<string, Permission> = { submission: "submission:read", interview: "interview:read", placement: "placement:read" };

  beforeAll(async () => {
    await seedPipeline(db, candidates);
    // An Open-to-all-teams candidate placed by another team's recruiter (r2a, team t2).
    const open = await newCandidate(db, { teamId: T.t3, recruiterId: U.r3a, locationId: LOC.austin, visibility: "all_teams" });
    const sub = await selectedSubmission(db, U.r2a, open.id);
    await createPlacement(db, U.r2a, sub);
  }, 120_000);

  it.each(users)("events readable by %s = engine candidate:read plus activity read scope", async (key) => {
    const access = toUserAccess(key);
    const { rows } = await db.admin.query(`
      SELECT e.id::text, e.ref_type,
             c.recruiter_id, c.team_id, c.location_id, c.visibility, c.marketing_status,
             coalesce(s.recruiter_id, i.recruiter_id, p.recruiter_id) AS a_recruiter,
             coalesce(s.team_id, i.team_id, p.team_id) AS a_team,
             coalesce(s.location_id, i.location_id, p.location_id) AS a_location
      FROM eureka.candidate_event e
      JOIN eureka.candidate c ON c.id = e.candidate_id
      LEFT JOIN eureka.submission s ON e.ref_type = 'submission' AND s.id = e.ref_id
      LEFT JOIN eureka.interview i ON e.ref_type = 'interview' AND i.id = e.ref_id
      LEFT JOIN eureka.placement p ON e.ref_type = 'placement' AND p.id = e.ref_id`);
    const readScope = resolveScope(access, "candidate:read");
    const expected = rows.filter((r) => {
      const cand: CandidateRef = { recruiterId: r.recruiter_id, teamId: r.team_id, locationId: r.location_id, visibility: r.visibility, marketingStatus: r.marketing_status };
      if (!candidateVisible(readScope, cand)) return false;
      const perm = READ_PERM[r.ref_type];
      if (!perm) return true;
      return activityVisible(resolveScope(access, perm), { recruiterId: r.a_recruiter, teamId: r.a_team, locationId: r.a_location, candidate: cand });
    }).map((r) => r.id).sort();
    const actual = await asUser(db.app, access.userId, async (c) =>
      (await c.query<{ id: string }>(`SELECT id::text FROM eureka.candidate_event`)).rows.map((r) => r.id).sort());
    expect(actual).toEqual(expected);
    if (readScope) expect(actual.length).toBeGreaterThan(0);
  });

  it("a teammate sees the candidate's own events but not another recruiter's submissions (D-02)", async () => {
    const cand = candidates.find((c) => c.recruiterId === U.r1a && c.marketingStatus === "active" && c.visibility === "team")!;
    const visible = await asUser(db.app, U.r1b, async (c) =>
      (await c.query(`SELECT type FROM eureka.candidate_event WHERE candidate_id = $1`, [cand.id])).rows.map((r) => r.type));
    expect(visible).toContain("candidate.created");
    expect(visible.filter((t: string) => t.startsWith("submission.") || t.startsWith("interview."))).toEqual([]);
    const owner = await asUser(db.app, U.r1a, async (c) =>
      (await c.query(`SELECT type FROM eureka.candidate_event WHERE candidate_id = $1`, [cand.id])).rows.map((r) => r.type));
    expect(owner).toEqual(expect.arrayContaining(["submission.created", "interview.scheduled"]));
  });

  it("no user context sees no events", async () => {
    expect((await db.app.query(`SELECT count(*)::int n FROM eureka.candidate_event`)).rows[0].n).toBe(0);
  });
});

describe("authz.candidate_duplicates", () => {
  type Dup = { candidate_id: string | null; team_name: string; contact_name: string; matched_on: string[] };
  const check = (actor: string, first: string | null, last: string | null, email: string | null, phone: string | null) =>
    asUser(db.app, actor, async (c) =>
      (await c.query<Dup>(`SELECT * FROM authz.candidate_duplicates($1, $2, $3, $4)`, [first, last, email, phone])).rows);

  // Fixture candidate 1 belongs to team t1 (lead l1, recruiter r1a) with phone +14695550001.
  const first = () => candidates[0]!;

  beforeAll(async () => {
    await db.admin.query(`UPDATE eureka.person p SET personal_email = 'Cand1.Test@Example.com' FROM eureka.candidate c WHERE c.person_id = p.id AND c.id = $1`, [first().id]);
  });

  it("matches the normalized phone and email; the owner's team gets the candidate id", async () => {
    expect(first().teamId).toBe(T.t1);
    const rows = await check(U.r1b, "Someone", "Else", "cand1.test@example.com", "+14695550001");
    expect(rows).toEqual([{ candidate_id: first().id, team_name: "Team Rohit", contact_name: "l1", matched_on: ["email", "phone"] }]);
  });

  it("outside the caller's read scope it reveals only team and contact, never the id", async () => {
    const rows = await check(U.r3a, "Someone", "Else", null, "+14695550001");
    expect(rows).toEqual([{ candidate_id: null, team_name: "Team Rohit", contact_name: "l1", matched_on: ["phone"] }]);
    // Only these four columns exist: no name, phone, email or status of the other record.
    const cols = await asUser(db.app, U.r3a, async (c) =>
      (await c.query(`SELECT * FROM authz.candidate_duplicates('A', 'B', NULL, '+14695550001')`)).fields.map((f) => f.name));
    expect(cols).toEqual(["candidate_id", "team_name", "contact_name", "matched_on"]);
  });

  it("matches the marketing email too, case-insensitively", async () => {
    const own = candidates.find((c) => c.recruiterId === U.r3a)!;
    await asUser(db.app, U.r3a, (c) => c.query(`UPDATE eureka.candidate SET marketing_email = 'Mkt.R3a@Eureka.example' WHERE id = $1`, [own.id]), true);
    const rows = await check(U.r1a, "X", "Y", "mkt.r3a@eureka.example", null);
    expect(rows).toEqual([{ candidate_id: null, team_name: "Team Vikram", contact_name: "l3", matched_on: ["email"] }]);
  });

  it("no match answers with no rows", async () => {
    expect(await check(U.r1a, "Nobody", "Here", "nobody@example.com", "+919999999999")).toEqual([]);
  });

  it("needs a name plus email or phone, valid values, a user and candidate:create", async () => {
    await expect(check(U.r1a, "", "Y", null, "+14695550001")).rejects.toThrow(/name_and_contact_required/);
    await expect(check(U.r1a, "X", "Y", null, null)).rejects.toThrow(/name_and_contact_required/);
    await expect(check(U.r1a, "X", "Y", null, "4695550001")).rejects.toThrow(/invalid_contact/);
    await expect(check(U.r1a, "X", "Y", "not-an-email", null)).rejects.toThrow(/invalid_contact/);
    for (const key of ["hr", "locD", "coach", "admin", "ceo"] as const) {
      await expect(check(U[key], "X", "Y", null, "+14695550001")).rejects.toThrow(/not_permitted/);
    }
    await expect(db.app.query(`SELECT * FROM authz.candidate_duplicates('X','Y',NULL,'+14695550001')`)).rejects.toThrow(/not_permitted/);
  });
});
