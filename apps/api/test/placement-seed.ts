import type { CandidateRef, Role, UserAccess } from "@eureka/shared";
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
  type Row = { placement_id: string; is_first_placement: boolean; candidate_from: string | null; candidate_to: string | null };
  const run = async (q: (sql: string, params: unknown[]) => Promise<{ rows: Row[] }>) => {
    const r = (await q(sql, params)).rows[0]!;
    return { id: r.placement_id, isFirst: r.is_first_placement, candidateFrom: r.candidate_from, candidateTo: r.candidate_to };
  };
  return actor ? asUser(db.app, actor, (c) => run((s, p) => c.query(s, p)), true) : run((s, p) => db.app.query(s, p));
}

export interface TransitionResult {
  from_status: string;
  to_status: string;
  candidate_from: string | null;
  candidate_to: string | null;
}

/** Calls authz.transition_placement and returns its full row (actual from/to, candidate change). */
export async function transitionPlacementRow(
  db: TestDb, actor: string | null, id: string | null, to: string | null, reason: string | null = null,
): Promise<TransitionResult> {
  const sql = `SELECT * FROM authz.transition_placement($1,$2,$3)`;
  const r = actor
    ? await asUser(db.app, actor, (c) => c.query<TransitionResult>(sql, [id, to, reason]), true)
    : await db.app.query<TransitionResult>(sql, [id, to, reason]);
  return r.rows[0]!;
}

/** The new placement status. */
export async function transitionPlacement(db: TestDb, actor: string | null, id: string | null, to: string | null, reason: string | null = null) {
  return (await transitionPlacementRow(db, actor, id, to, reason)).to_status;
}

/**
 * An org-scoped user outside the shared fixtures (e.g. associate_hr), signed in
 * as `${key}@eureka.example`. Returns the id and the engine's view of access.
 */
export async function extraUser(db: TestDb, key: string, role: Role): Promise<{ id: string; access: UserAccess }> {
  const r = await db.admin.query<{ id: string }>(
    `INSERT INTO eureka.app_user (email, display_name) VALUES ($1, $2) RETURNING id`, [`${key}@eureka.example`, key]);
  const id = r.rows[0]!.id;
  await db.admin.query(`INSERT INTO eureka.user_role (user_id, role_key) VALUES ($1, $2)`, [id, role]);
  return { id, access: { userId: id, roles: [{ role }], teamIds: [], subordinateUserIds: [], subtreeTeamIds: [], coachedTeamIds: [] } };
}
