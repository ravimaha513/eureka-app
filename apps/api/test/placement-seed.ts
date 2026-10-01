import type { CandidateRef } from "@eureka/shared";
import { asUser, type TestDb } from "./db-harness.js";
import { CLIENT_ID, TECH_ID, type FixtureCandidate } from "./fixtures.js";

const SUBMISSION_PATH = ["under_review", "interview_requested", "interview_scheduled", "interview_completed", "selected"];

let n = 0;
/** A fresh candidate (as superuser), so placement side effects never collide between tests. */
export async function newCandidate(
  db: TestDb,
  c: Omit<CandidateRef, "visibility" | "marketingStatus"> & Partial<Pick<CandidateRef, "visibility" | "marketingStatus">>,
): Promise<FixtureCandidate> {
  n++;
  const p = await db.admin.query<{ id: string }>(
    `INSERT INTO eureka.person (first_name, last_name) VALUES ($1, 'Placed') RETURNING id`, [`PlCand${n}`]);
  const visibility = c.visibility ?? "team";
  const marketingStatus = c.marketingStatus ?? "active";
  const r = await db.admin.query<{ id: string }>(
    `INSERT INTO eureka.candidate (person_id, technology_id, team_id, recruiter_id, location_id, visibility, marketing_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [p.rows[0]!.id, TECH_ID, c.teamId, c.recruiterId, c.locationId, visibility, marketingStatus]);
  return { id: r.rows[0]!.id, teamId: c.teamId, recruiterId: c.recruiterId, locationId: c.locationId, visibility, marketingStatus };
}

/** A submission by `actor`, walked to `selected` through authz.transition_submission. */
export async function selectedSubmission(db: TestDb, actor: string, candidateId: string, upTo = "selected"): Promise<string> {
  const id = await asUser(db.app, actor, async (c) => (await c.query<{ id: string }>(
    `INSERT INTO eureka.submission (candidate_id, job_title, client_id, rate) VALUES ($1,'Java Developer',$2,55) RETURNING id`,
    [candidateId, CLIENT_ID])).rows[0]!.id, true);
  for (const to of SUBMISSION_PATH.slice(0, SUBMISSION_PATH.indexOf(upTo) + 1)) {
    await asUser(db.app, actor, (c) => c.query(`SELECT authz.transition_submission($1,$2,NULL)`, [id, to]), true);
  }
  return id;
}

export interface PlacementArgs {
  type?: string | null;
  rate?: number | null;
  workMode?: string | null;
  city?: string | null;
  state?: string | null;
  start?: string | null;
  partner?: string | null;
  contacts?: unknown;
}

/** Calls authz.create_placement as `actor` (null: no user context). */
export async function createPlacement(db: TestDb, actor: string | null, submissionId: string | null, a: PlacementArgs = {}) {
  const sql = `SELECT * FROM authz.create_placement($1,$2,$3,$4,$5,$6,$7::date,$8,$9::jsonb)`;
  const params = [submissionId, a.type === undefined ? "w2" : a.type, a.rate === undefined ? 60 : a.rate,
    a.workMode === undefined ? "onsite" : a.workMode, a.city ?? "Dallas", a.state ?? "TX",
    a.start === undefined ? "2031-01-05" : a.start, a.partner ?? null,
    a.contacts === undefined ? null : JSON.stringify(a.contacts)];
  const run = async (q: (sql: string, params: unknown[]) => Promise<{ rows: { placement_id: string; is_first_placement: boolean }[] }>) => {
    const r = await q(sql, params);
    return { id: r.rows[0]!.placement_id, isFirst: r.rows[0]!.is_first_placement };
  };
  return actor ? asUser(db.app, actor, (c) => run((s, p) => c.query(s, p)), true) : run((s, p) => db.app.query(s, p));
}

export async function transitionPlacement(db: TestDb, actor: string | null, id: string | null, to: string | null, reason: string | null = null) {
  const sql = `SELECT authz.transition_placement($1,$2,$3) AS s`;
  const r = actor
    ? await asUser(db.app, actor, (c) => c.query<{ s: string }>(sql, [id, to, reason]), true)
    : await db.app.query<{ s: string }>(sql, [id, to, reason]);
  return r.rows[0]!.s;
}
