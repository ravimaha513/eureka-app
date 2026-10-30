import { Injectable, NotFoundException } from "@nestjs/common";
import { resolveScope } from "@eureka/shared";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { activityPredicate } from "../submissions/submissions.service.js";
import { scopePredicate } from "./candidates.service.js";

interface SubmissionCounts {
  total: number;
  last_30_days: number;
  with_interview: number;
  clients: number;
  first_at: Date | null;
  last_at: Date | null;
  by_status: Record<string, number> | null;
}

interface InterviewCounts {
  total: number;
  upcoming: number;
  completed: number;
  cleared: number;
  not_cleared: number;
  cancelled: number;
  last_at: Date | null;
  next_at: Date | null;
  by_round: Record<string, number> | null;
}

interface PlacementCounts {
  total: number;
  active: number;
  joined: number;
  fell_through: number;
}

/**
 * Per-candidate pipeline counts (docs/candidates-api.md "Metrics"). The candidate
 * must be readable (404 otherwise); each section counts only the submissions,
 * interviews and placements the caller could list, and is omitted without that
 * section's read permission. Counts only: no rates, names or notes.
 */
@Injectable()
export class CandidateMetricsService {
  constructor(private readonly db: DbService) {}

  async metrics(user: AuthedUser, id: string) {
    const readScope = resolveScope(user.access, "candidate:read");
    if (!readScope) throw new NotFoundException();
    const subScope = resolveScope(user.access, "submission:read");
    const ivScope = resolveScope(user.access, "interview:read");
    const plScope = resolveScope(user.access, "placement:read");

    return this.db.withUser(user.id, async (c) => {
      const cp: unknown[] = [id];
      const visible = await c.query(`SELECT 1 FROM eureka.candidate c WHERE c.id = $1 AND ${scopePredicate(readScope, cp)}`, cp);
      if (!visible.rows[0]) throw new NotFoundException();

      let submissions: SubmissionCounts | undefined;
      if (subScope) {
        const p: unknown[] = [id];
        submissions = (await c.query<SubmissionCounts>(
          `WITH s AS (
             SELECT s.* FROM eureka.submission s LEFT JOIN eureka.candidate c ON c.id = s.candidate_id
             WHERE s.candidate_id = $1 AND ${activityPredicate(subScope, p)})
           SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE submitted_at >= now() - interval '30 days')::int AS last_30_days,
                  -- Interviews under RLS: a submission counts when the caller can see one of its interviews.
                  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM eureka.interview i WHERE i.submission_id = s.id))::int AS with_interview,
                  count(DISTINCT client_id)::int AS clients,
                  min(submitted_at) AS first_at, max(submitted_at) AS last_at,
                  (SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*)::int AS n FROM s GROUP BY status) x) AS by_status
           FROM s`, p)).rows[0];
      }

      let interviews: InterviewCounts | undefined;
      if (ivScope) {
        const p: unknown[] = [id];
        interviews = (await c.query<InterviewCounts>(
          `WITH i AS (
             SELECT i.* FROM eureka.interview i LEFT JOIN eureka.candidate c ON c.id = i.candidate_id
             WHERE i.candidate_id = $1 AND ${activityPredicate(ivScope, p, "i", "c")})
           SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE call_status IN ('scheduled', 'rescheduled') AND starts_at > now())::int AS upcoming,
                  count(*) FILTER (WHERE call_status = 'completed' OR cleared)::int AS completed,
                  count(*) FILTER (WHERE cleared)::int AS cleared,
                  count(*) FILTER (WHERE call_status = 'completed' AND NOT cleared)::int AS not_cleared,
                  count(*) FILTER (WHERE call_status IN ('cancelled', 'no_invite'))::int AS cancelled,
                  max(starts_at) FILTER (WHERE starts_at <= now()) AS last_at,
                  min(starts_at) FILTER (WHERE starts_at > now() AND call_status IN ('scheduled', 'rescheduled')) AS next_at,
                  (SELECT jsonb_object_agg(round, n)
                     FROM (SELECT round, count(*)::int AS n FROM i GROUP BY round) x) AS by_round
           FROM i`, p)).rows[0];
      }

      let placements: PlacementCounts | undefined;
      if (plScope) {
        const p: unknown[] = [id];
        placements = (await c.query<PlacementCounts>(
          `SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE pl.status IN ('confirmed', 'paperwork', 'bgc', 'ready'))::int AS active,
                  count(*) FILTER (WHERE pl.status = 'joined')::int AS joined,
                  count(*) FILTER (WHERE pl.status IN ('backout', 'bgc_failed', 'joining_issue'))::int AS fell_through
           FROM eureka.placement pl LEFT JOIN eureka.candidate c ON c.id = pl.candidate_id
           WHERE pl.candidate_id = $1 AND ${activityPredicate(plScope, p, "pl", "c")}`, p)).rows[0];
      }

      return {
        ...(submissions ? { submissions: {
          total: submissions.total,
          last30Days: submissions.last_30_days,
          withInterview: submissions.with_interview,
          clients: submissions.clients,
          firstAt: submissions.first_at,
          lastAt: submissions.last_at,
          byStatus: submissions.by_status ?? {},
        } } : {}),
        ...(interviews ? { interviews: {
          total: interviews.total,
          upcoming: interviews.upcoming,
          completed: interviews.completed,
          cleared: interviews.cleared,
          notCleared: interviews.not_cleared,
          cancelled: interviews.cancelled,
          lastAt: interviews.last_at,
          nextAt: interviews.next_at,
          byRound: interviews.by_round ?? {},
        } } : {}),
        ...(placements ? { placements: {
          total: placements.total,
          active: placements.active,
          joined: placements.joined,
          fellThrough: placements.fell_through,
        } } : {}),
      };
    });
  }
}
