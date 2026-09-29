import type { ActivityRef } from "@eureka/shared";
import { asUser, type TestDb } from "./db-harness.js";
import { CLIENT_ID, T, U, type FixtureCandidate } from "./fixtures.js";

export interface SeededActivity extends ActivityRef { id: string; candidate: FixtureCandidate }
export interface PipelineSeed {
  submissions: SeededActivity[];
  interviews: (SeededActivity & { submissionId: string })[];
}

/** First instant used for seeded interviews; each gets its own hour. */
export const BASE = Date.parse("2030-01-07T14:00:00Z");
export const at = (hour: number) => new Date(BASE + hour * 3_600_000).toISOString();

/**
 * Submissions and interviews for the pipeline tests, written as each actor
 * through the app role (so snapshots and policies apply):
 *   - every recruiter submits each of their own active candidates
 *   - r2a submits another team's (t3) Open-to-all-teams candidates
 *   - l1 submits unassigned t1 candidates
 * Each submission gets one interview. Snapshots are read back as data.
 */
export async function seedPipeline(db: TestDb, candidates: FixtureCandidate[]): Promise<PipelineSeed> {
  const plan: { actor: string; cand: FixtureCandidate }[] = [];
  for (const cand of candidates.filter((c) => c.marketingStatus === "active")) {
    if (cand.recruiterId) plan.push({ actor: cand.recruiterId, cand });
    if (cand.teamId === T.t3 && cand.visibility === "all_teams") plan.push({ actor: U.r2a, cand });
    if (cand.teamId === T.t1 && cand.recruiterId === null) plan.push({ actor: U.l1, cand });
  }
  const out: PipelineSeed = { submissions: [], interviews: [] };
  let hour = 0;
  for (const { actor, cand } of plan) {
    const subId = await asUser(db.app, actor, async (c) =>
      (await c.query<{ id: string }>(
        `INSERT INTO eureka.submission (candidate_id, job_title, client_id, rate) VALUES ($1,'Java Developer',$2,55) RETURNING id`,
        [cand.id, CLIENT_ID])).rows[0]!.id, true);
    const intId = await asUser(db.app, actor, async (c) =>
      (await c.query<{ id: string }>(
        `INSERT INTO eureka.interview (submission_id, round, starts_at, ends_at) VALUES ($1,'L1',$2,$3) RETURNING id`,
        [subId, at(hour), at(hour + 1)])).rows[0]!.id, true);
    hour += 2;
    const s = (await db.admin.query(`SELECT recruiter_id, team_id, location_id FROM eureka.submission WHERE id = $1`, [subId])).rows[0];
    const ref = { recruiterId: s.recruiter_id, teamId: s.team_id, locationId: s.location_id, candidate: cand };
    out.submissions.push({ id: subId, ...ref });
    out.interviews.push({ id: intId, submissionId: subId, ...ref });
  }
  return out;
}
