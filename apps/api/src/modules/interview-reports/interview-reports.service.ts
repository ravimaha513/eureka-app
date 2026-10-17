import type pg from "pg";
import { ForbiddenException, HttpException, HttpStatus, Injectable, ServiceUnavailableException } from "@nestjs/common";
import {
  INTERVIEW_DURATION_BUCKETS,
  INTERVIEW_REPORT_EXCLUDED_STATUSES,
  resolveScope,
  type EffectiveScope,
  type InterviewReportGroup,
} from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { RateLimiter } from "../../platform/rate-limit.js";
import { toCsv } from "../hotlist/csv.js";
import { EXPORTS_PER_WINDOW, EXPORT_ROW_CAP, EXPORT_WINDOW_MS } from "../hotlist/hotlist.service.js";
import { activityPredicate } from "../submissions/submissions.service.js";
import type { DailyInterviewsQuery, InterviewReportQuery } from "./interview-reports.schemas.js";

/**
 * Interview reports (gap L4; docs/interviews-settings-api.md "Interview
 * reports"). Parameterized SQL over eureka.interview under the caller's RLS
 * plus the engine's interview:read AND report:read predicates (the rows the
 * caller can see on the board, limited to where they may read reports).
 * Exports also need report:export over the row, are capped, rate-limited and
 * audited (period, grouping and row count only: no names or feedback text).
 */

/** Groups returned in the JSON view (totals always cover every matching interview). */
export const INTERVIEW_REPORT_GROUP_CAP = 1000;
/** Rows of the daily report in the JSON view. */
export const DAILY_REPORT_VIEW_CAP = 1000;
/** JSON report requests per user per minute (design A6.5). */
export const INTERVIEW_REPORT_VIEWS_PER_MINUTE = 30;

const DURATION_MIN = `(extract(epoch FROM (i.ends_at - i.starts_at)) / 60)`;
const BUCKET_SQL = `CASE ${INTERVIEW_DURATION_BUCKETS.filter((b) => b.max !== null)
  .map((b) => `WHEN ${DURATION_MIN} < ${b.max} THEN '${b.key}'`).join(" ")} ELSE '${INTERVIEW_DURATION_BUCKETS[INTERVIEW_DURATION_BUCKETS.length - 1]!.key}' END`;
const BUCKET_ORDER_SQL = `CASE ${INTERVIEW_DURATION_BUCKETS.map((b, n) => `WHEN ${BUCKET_SQL} = '${b.key}' THEN ${n}`).join(" ")} END`;
const BUCKET_LABEL = new Map<string, string>(INTERVIEW_DURATION_BUCKETS.map((b) => [b.key, b.label]));
const EXCLUDED = INTERVIEW_REPORT_EXCLUDED_STATUSES.map((s) => `'${s}'`).join(", ");
const CANDIDATE_NAME = `CASE WHEN p.id IS NOT NULL THEN p.first_name || ' ' || p.last_name END`;

/** Group key and label per grouping; both are SQL expressions over the FROM below. */
const GROUP_SQL: Record<InterviewReportGroup, { key: string; label: string; order: string }> = {
  coach: { key: "i.coach_id::text", label: "cu.display_name", order: "label NULLS LAST, key" },
  technology: { key: "c.technology_id::text", label: "t.name", order: "label NULLS LAST, key" },
  candidate: { key: "i.candidate_id::text", label: CANDIDATE_NAME, order: "label NULLS LAST, key" },
  duration: { key: BUCKET_SQL, label: "NULL::text", order: `min(${BUCKET_ORDER_SQL})` },
};

const FROM = `
  FROM eureka.interview i
  LEFT JOIN eureka.candidate c ON c.id = i.candidate_id
  LEFT JOIN eureka.person p ON p.id = c.person_id
  LEFT JOIN eureka.technology t ON t.id = c.technology_id
  LEFT JOIN eureka.app_user cu ON cu.id = i.coach_id`;

interface GroupRow {
  key: string | null; label: string | null; interviews: number; cleared: number; completed: number;
  total_min: string | null; avg_min: string | null;
}

interface DailyRow {
  id: string; starts_at: Date; ends_at: Date; round: string; interview_type: string | null; call_status: string;
  cleared: boolean; candidate_id: string; candidate_name: string | null; technology: string | null; client: string | null;
  recruiter: string | null; team: string | null; location: string | null; coach_id: string | null; coach: string | null;
  fb_rating: number | null; fb_notes: string | null; fb_format: string | null; fb_next_step: string | null; fb_at: Date | null;
}

export interface InterviewReportGroupItem {
  key: string | null;
  label: string;
  interviews: number;
  cleared: number;
  completed: number;
  totalDurationMin: number;
  avgDurationMin: number | null;
}

async function timed<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if ((err as { code?: string }).code === "57014") throw new ServiceUnavailableException("The report took too long. Choose a shorter period.");
    throw err;
  }
}

const num = (v: string | null) => (v === null ? 0 : Number(v));
const fallbackLabel: Record<InterviewReportGroup, string> = {
  coach: "Unassigned", technology: "(not visible)", candidate: "(not visible)", duration: "",
};
const callStatusLabel = (s: string) => { const t = s.replace(/_/g, " "); return t.charAt(0).toUpperCase() + t.slice(1); };

@Injectable()
export class InterviewReportsService {
  private readonly exportLimiter = new RateLimiter(EXPORTS_PER_WINDOW, EXPORT_WINDOW_MS);
  private readonly viewLimiter = new RateLimiter(INTERVIEW_REPORT_VIEWS_PER_MINUTE, 60_000);

  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  /** interview:read AND report:read; [] when the caller can read no interview (empty report, not an error). */
  private readScopes(user: AuthedUser): EffectiveScope[] {
    const report = resolveScope(user.access, "report:read");
    if (!report) throw new ForbiddenException();
    const interview = resolveScope(user.access, "interview:read");
    return interview ? [interview, report] : [];
  }

  private exportScopes(user: AuthedUser): EffectiveScope[] {
    const exportScope = resolveScope(user.access, "report:export");
    if (!exportScope) throw new ForbiddenException();
    const scopes = this.readScopes(user);
    if (!this.exportLimiter.take(user.id)) {
      throw new HttpException("Too many exports; try again in a few minutes", HttpStatus.TOO_MANY_REQUESTS);
    }
    return scopes.length ? [...scopes, exportScope] : [];
  }

  private takeView(user: AuthedUser) {
    if (!this.viewLimiter.take(user.id)) {
      throw new HttpException("Too many report requests; try again in a minute", HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private where(scopes: EffectiveScope[], params: unknown[], from: string, to: string): string {
    params.push(from, to);
    const range = `i.starts_at >= $${params.length - 1}::timestamptz AND i.starts_at < $${params.length}::timestamptz`;
    return [range, ...scopes.map((s) => activityPredicate(s, params, "i", "c"))].join(" AND ");
  }

  private async run<T extends pg.QueryResultRow>(user: AuthedUser, sql: string, params: unknown[],
    after?: (c: pg.PoolClient, rows: T[]) => Promise<void>): Promise<T[]> {
    return this.db.withUserExport(user.id, async (c) => {
      const rows = (await timed(() => c.query<T>(sql, params))).rows;
      if (after) await after(c, rows);
      return rows;
    });
  }

  private groupSql(scopes: EffectiveScope[], q: InterviewReportQuery, params: unknown[], limit: number | null): string {
    const g = GROUP_SQL[q.groupBy];
    const where = this.where(scopes, params, q.from, q.to);
    return `
      SELECT ${g.key} AS key, ${g.label === "NULL::text" ? "NULL::text" : `min(${g.label})`} AS label,
             count(*)::int AS interviews,
             count(*) FILTER (WHERE i.cleared)::int AS cleared,
             count(*) FILTER (WHERE i.call_status = 'completed')::int AS completed,
             round(sum(${DURATION_MIN}))::text AS total_min,
             round(avg(${DURATION_MIN}), 1)::text AS avg_min
      ${FROM}
      WHERE ${where} AND i.call_status NOT IN (${EXCLUDED})
      GROUP BY ${g.key}
      ORDER BY ${q.groupBy === "duration" ? g.order : `interviews DESC, ${g.order}`}
      ${limit === null ? "" : `LIMIT ${limit}`}`;
  }

  private totalsSql(scopes: EffectiveScope[], q: InterviewReportQuery, params: unknown[]): string {
    return `
      SELECT NULL::text AS key, NULL::text AS label, count(*)::int AS interviews,
             count(*) FILTER (WHERE i.cleared)::int AS cleared,
             count(*) FILTER (WHERE i.call_status = 'completed')::int AS completed,
             round(sum(${DURATION_MIN}))::text AS total_min,
             round(avg(${DURATION_MIN}), 1)::text AS avg_min
      ${FROM}
      WHERE ${this.where(scopes, params, q.from, q.to)} AND i.call_status NOT IN (${EXCLUDED})`;
  }

  private item(groupBy: InterviewReportGroup, r: GroupRow): InterviewReportGroupItem {
    const label = groupBy === "duration" ? (BUCKET_LABEL.get(r.key ?? "") ?? String(r.key)) : (r.label ?? fallbackLabel[groupBy]);
    return {
      key: r.key, label, interviews: r.interviews, cleared: r.cleared, completed: r.completed,
      totalDurationMin: num(r.total_min), avgDurationMin: r.avg_min === null ? null : Number(r.avg_min),
    };
  }

  async report(user: AuthedUser, q: InterviewReportQuery) {
    const scopes = this.readScopes(user);
    this.takeView(user);
    const empty: GroupRow = { key: null, label: null, interviews: 0, cleared: 0, completed: 0, total_min: null, avg_min: null };
    let groups: GroupRow[] = [];
    let total = empty;
    if (scopes.length) {
      const gp: unknown[] = [];
      groups = await this.run<GroupRow>(user, this.groupSql(scopes, q, gp, INTERVIEW_REPORT_GROUP_CAP + 1), gp);
      const tp: unknown[] = [];
      total = (await this.run<GroupRow>(user, this.totalsSql(scopes, q, tp), tp))[0] ?? empty;
    }
    const t = this.item(q.groupBy, total);
    return {
      from: q.from,
      to: q.to,
      groupBy: q.groupBy,
      totals: { interviews: t.interviews, cleared: t.cleared, completed: t.completed, totalDurationMin: t.totalDurationMin, avgDurationMin: t.avgDurationMin },
      groups: groups.slice(0, INTERVIEW_REPORT_GROUP_CAP).map((r) => this.item(q.groupBy, r)),
      truncated: groups.length > INTERVIEW_REPORT_GROUP_CAP,
    };
  }

  async exportReport(user: AuthedUser, q: InterviewReportQuery): Promise<{ csv: string; rows: number; truncated: boolean }> {
    const scopes = this.exportScopes(user);
    const audit = async (c: pg.PoolClient, rows: GroupRow[]) => {
      await this.audit.record(c, {
        actorId: user.id, action: "report.export", entityType: "interview",
        changes: { report: "interviews", groupBy: q.groupBy, from: q.from, to: q.to,
          rows: Math.min(rows.length, EXPORT_ROW_CAP), truncated: rows.length > EXPORT_ROW_CAP, cap: EXPORT_ROW_CAP },
      });
    };
    const params: unknown[] = [];
    const rows = scopes.length
      ? await this.run<GroupRow>(user, this.groupSql(scopes, q, params, EXPORT_ROW_CAP + 1), params, audit)
      : await this.db.withUserExport(user.id, async (c) => { await audit(c, []); return [] as GroupRow[]; });
    const page = rows.slice(0, EXPORT_ROW_CAP).map((r) => this.item(q.groupBy, r));
    const head: Record<InterviewReportGroup, string> = { coach: "Interview coach", technology: "Technology", candidate: "Candidate", duration: "Duration" };
    const csv = toCsv(
      [head[q.groupBy], "Interviews", "Cleared", "Completed", "Total duration (min)", "Average duration (min)"],
      page.map((g) => [g.label, g.interviews, g.cleared, g.completed, g.totalDurationMin, g.avgDurationMin ?? ""]),
    );
    return { csv, rows: page.length, truncated: rows.length > EXPORT_ROW_CAP };
  }

  /**
   * One row per interview starting in [from, to), cancelled ones included
   * (with their call status), and the latest candidate feedback (kind
   * 'candidate', from the feedback email about an hour after the interview).
   * Feedback is readable wherever the interview is (feedback_read, 0017).
   */
  private dailySql(scopes: EffectiveScope[], q: DailyInterviewsQuery, params: unknown[], limit: number): string {
    return `
      SELECT i.id, i.starts_at, i.ends_at, i.round, i.interview_type, i.call_status, i.cleared,
             i.candidate_id, ${CANDIDATE_NAME} AS candidate_name, t.name AS technology, cl.name AS client,
             ru.display_name AS recruiter, tm.name AS team, l.name AS location, i.coach_id, cu.display_name AS coach,
             fb.rating AS fb_rating, fb.notes AS fb_notes, fb.format AS fb_format, fb.next_step AS fb_next_step, fb.created_at AS fb_at
      ${FROM}
      LEFT JOIN eureka.client cl ON cl.id = i.client_id
      LEFT JOIN eureka.app_user ru ON ru.id = i.recruiter_id
      LEFT JOIN eureka.team tm ON tm.id = i.team_id
      LEFT JOIN eureka.location l ON l.id = i.location_id
      LEFT JOIN LATERAL (
        SELECT f.rating, f.notes, f.format, f.next_step, f.created_at FROM eureka.interview_feedback f
        WHERE f.interview_id = i.id AND f.kind = 'candidate' ORDER BY f.created_at DESC, f.id DESC LIMIT 1
      ) fb ON true
      WHERE ${this.where(scopes, params, q.from, q.to)}
      ORDER BY i.starts_at, i.id
      LIMIT ${limit}`;
  }

  private dailyItem(r: DailyRow) {
    return {
      id: r.id,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      durationMin: Math.round((r.ends_at.getTime() - r.starts_at.getTime()) / 60_000),
      round: r.round,
      interviewType: r.interview_type,
      callStatus: r.call_status,
      cleared: r.cleared,
      candidate: { id: r.candidate_id, name: r.candidate_name },
      technology: r.technology,
      client: r.client,
      recruiter: r.recruiter,
      team: r.team,
      location: r.location,
      coach: r.coach_id ? { id: r.coach_id, name: r.coach } : null,
      candidateFeedback: r.fb_at === null ? null : {
        rating: r.fb_rating, notes: r.fb_notes, format: r.fb_format, nextStep: r.fb_next_step, submittedAt: r.fb_at,
      },
    };
  }

  async daily(user: AuthedUser, q: DailyInterviewsQuery) {
    const scopes = this.readScopes(user);
    this.takeView(user);
    const params: unknown[] = [];
    const rows = scopes.length ? await this.run<DailyRow>(user, this.dailySql(scopes, q, params, DAILY_REPORT_VIEW_CAP + 1), params) : [];
    const items = rows.slice(0, DAILY_REPORT_VIEW_CAP).map((r) => this.dailyItem(r));
    const counted = items.filter((i) => !(INTERVIEW_REPORT_EXCLUDED_STATUSES as readonly string[]).includes(i.callStatus));
    return {
      from: q.from,
      to: q.to,
      totals: {
        interviews: counted.length,
        cleared: counted.filter((i) => i.cleared).length,
        withCandidateFeedback: items.filter((i) => i.candidateFeedback !== null).length,
      },
      items,
      truncated: rows.length > DAILY_REPORT_VIEW_CAP,
    };
  }

  async exportDaily(user: AuthedUser, q: DailyInterviewsQuery): Promise<{ csv: string; rows: number; truncated: boolean }> {
    const scopes = this.exportScopes(user);
    const audit = async (c: pg.PoolClient, rows: DailyRow[]) => {
      await this.audit.record(c, {
        actorId: user.id, action: "report.export", entityType: "interview",
        changes: { report: "interviews_daily", from: q.from, to: q.to,
          rows: Math.min(rows.length, EXPORT_ROW_CAP), truncated: rows.length > EXPORT_ROW_CAP, cap: EXPORT_ROW_CAP },
      });
    };
    const params: unknown[] = [];
    const rows = scopes.length
      ? await this.run<DailyRow>(user, this.dailySql(scopes, q, params, EXPORT_ROW_CAP + 1), params, audit)
      : await this.db.withUserExport(user.id, async (c) => { await audit(c, []); return [] as DailyRow[]; });
    const page = rows.slice(0, EXPORT_ROW_CAP).map((r) => this.dailyItem(r));
    const csv = toCsv(
      ["Start", "End", "Duration (min)", "Candidate", "Technology", "Client", "Round", "Recruiter", "Team", "Location",
        "Interview coach", "Call status", "Cleared", "Candidate rating", "Candidate feedback", "Candidate next step"],
      page.map((i) => [
        i.startsAt.toISOString(), i.endsAt.toISOString(), i.durationMin, i.candidate.name ?? "(not visible)", i.technology ?? "",
        i.client ?? "", i.round, i.recruiter ?? "", i.team ?? "", i.location ?? "", i.coach?.name ?? "", callStatusLabel(i.callStatus),
        i.cleared ? "Yes" : "No", i.candidateFeedback?.rating ?? "", i.candidateFeedback?.notes ?? "", i.candidateFeedback?.nextStep ?? "",
      ]),
    );
    return { csv, rows: page.length, truncated: rows.length > EXPORT_ROW_CAP };
  }
}
