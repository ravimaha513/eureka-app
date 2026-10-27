import {
  ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, ServiceUnavailableException,
} from "@nestjs/common";
import type pg from "pg";
import { ownsActivity, ownsCandidate, resolveScope, type EffectiveScope } from "@eureka/shared";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { AuditService } from "../../platform/audit.service.js";
import { DbService } from "../../platform/db.service.js";
import { RateLimiter } from "../../platform/rate-limit.js";
import { scopePredicate } from "../candidates/candidates.service.js";
import { activityPredicate } from "../submissions/submissions.service.js";
import { mapPvError } from "./pipeline-report.errors.js";
import type { CreateAssessment, PipelineQuery, PipelineStage, UpdateAssessment } from "./pipeline-report.schemas.js";

/** Pipeline report requests per user per minute (per API task, like the dashboard). */
export const PIPELINE_REQUESTS_PER_MINUTE = 20;

type Params = unknown[];
const bind = (params: Params) => (v: unknown) => { params.push(v); return `$${params.length}`; };
/** Ownership only (never the Open-to-all-teams or open Hot List rules). */
const owned = (s: EffectiveScope): EffectiveScope => ({ ...s, allTeams: false, hotlistOpen: false });

/** Interviews that happen (or happened): not cancelled, rescheduled or without an invite (as the dashboard counts them). */
const LIVE_INTERVIEW = `i.call_status NOT IN ('cancelled', 'rescheduled', 'no_invite')`;
/** Candidate statuses that mean marketing has started. */
const MARKETING_SQL = `('active', 'on_hold', 'full_of_interviews', 'confirmation', 'bench')`;

interface PipelineRow {
  id: string; name: string | null;
  technology_id: string; technology: string | null;
  team_id: string; team: string | null;
  recruiter_id: string | null; recruiter: string | null;
  location_id: string; location: string | null;
  marketing_status: string; marketing_start_date: string | null;
  sub_n: number; sub_last: Date | null;
  iv_n: number; iv_cleared: number; iv_last: Date | null;
  asm_n: number; asm_passed: number; asm_last: string | null;
  pl_id: string | null; pl_status: string | null; pl_created: Date | null; pl_start: string | null; pl_joined: Date | null;
  ck_total: number | null; ck_done: number | null;
  not_responding: boolean; stage: PipelineStage; total: number;
}

interface SummaryRow {
  total: number; marketing: number; submitted: number; interviewing: number; assessment: number;
  confirmed: number; paperwork: number; joined: number; not_responding: number; by_stage: Record<string, number> | null;
}

interface AssessmentRow {
  id: string; submission_id: string; candidate_id: string; platform: string; status: string;
  assigned_on: string; due_on: string | null; completed_on: string | null; score: number | null;
  created_at: Date; updated_at: Date; row_version: number;
}

interface SubmissionRef { id: string; recruiter_id: string; team_id: string | null; location_id: string | null; candidate_id: string }

const presentAssessment = (r: AssessmentRow) => ({
  id: r.id, submissionId: r.submission_id, candidateId: r.candidate_id, platform: r.platform, status: r.status,
  assignedOn: r.assigned_on, dueOn: r.due_on, completedOn: r.completed_on, score: r.score,
  createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(), rowVersion: r.row_version,
});
const ASSESSMENT_COLS = `a.id, a.submission_id, a.candidate_id, a.platform, a.status, a.assigned_on::text AS assigned_on,
  a.due_on::text AS due_on, a.completed_on::text AS completed_on, a.score, a.created_at, a.updated_at, a.row_version`;

interface FlagRow {
  id: string; reason: string; status: string; resolution: string | null; flagged_at: Date; flagged_by_name: string | null;
  resolved_at: Date | null; hold_reached_at: Date | null; warning_mail_sent_at: Date | null; hold_mail_sent_at: Date | null;
}
const presentFlag = (f: FlagRow) => ({
  id: f.id, reason: f.reason, status: f.status, resolution: f.resolution,
  flaggedAt: f.flagged_at.toISOString(), flaggedBy: f.flagged_by_name,
  resolvedAt: f.resolved_at?.toISOString() ?? null,
  holdReachedAt: f.hold_reached_at?.toISOString() ?? null,
  candidateWarnedAt: f.warning_mail_sent_at?.toISOString() ?? null,
  candidateHoldNoticeAt: f.hold_mail_sent_at?.toISOString() ?? null,
});

@Injectable()
export class PipelineReportService {
  private readonly limiter = new RateLimiter(PIPELINE_REQUESTS_PER_MINUTE, 60_000);

  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  // ---------------------------------------------------------------- report (PV-1, PV-2)

  async report(user: AuthedUser, q: PipelineQuery) {
    const report = resolveScope(user.access, "report:read");
    const cand = resolveScope(user.access, "candidate:read");
    if (!report || !cand) throw new ForbiddenException("Not permitted");
    if (!this.limiter.take(user.id)) {
      throw new HttpException("Too many pipeline report requests; try again in a minute", HttpStatus.TOO_MANY_REQUESTS);
    }
    try {
      return await this.db.withUser(user.id, async (c) => {
        if (report.all) await c.query("SET LOCAL statement_timeout = '60s'");
        const params: Params = [];
        const base = this.baseSql(params, report, cand, q);
        const p = bind(params);
        const page = await c.query<PipelineRow>(`${base}
          SELECT r.*, CASE WHEN pe.id IS NOT NULL THEN pe.first_name || ' ' || pe.last_name END AS name,
                 te.name AS technology, tm.name AS team, ru.display_name AS recruiter, lo.name AS location,
                 count(*) OVER ()::int AS total
            FROM rows r
            LEFT JOIN eureka.person pe ON pe.id = r.person_id
            LEFT JOIN eureka.technology te ON te.id = r.technology_id
            LEFT JOIN eureka.team tm ON tm.id = r.team_id
            LEFT JOIN eureka.app_user ru ON ru.id = r.recruiter_id
            LEFT JOIN eureka.location lo ON lo.id = r.location_id
           ORDER BY lower(pe.first_name || ' ' || pe.last_name) NULLS LAST, r.id
           LIMIT ${p(q.limit)} OFFSET ${p(q.offset)}`, params);
        const sParams: Params = [];
        const sBase = this.baseSql(sParams, report, cand, q);
        const s = (await c.query<SummaryRow>(`${sBase}
          SELECT count(*)::int AS total,
                 count(*) FILTER (WHERE stage <> 'not_started')::int AS marketing,
                 count(*) FILTER (WHERE sub_n > 0)::int AS submitted,
                 count(*) FILTER (WHERE iv_n > 0)::int AS interviewing,
                 count(*) FILTER (WHERE asm_n > 0)::int AS assessment,
                 count(*) FILTER (WHERE pl_id IS NOT NULL)::int AS confirmed,
                 count(*) FILTER (WHERE pl_status IN ('paperwork', 'bgc', 'ready', 'joined'))::int AS paperwork,
                 count(*) FILTER (WHERE pl_status = 'joined')::int AS joined,
                 count(*) FILTER (WHERE not_responding)::int AS not_responding,
                 (SELECT pg_catalog.jsonb_object_agg(stage, n) FROM (SELECT stage, count(*)::int AS n FROM rows GROUP BY stage) g) AS by_stage
            FROM rows`, sParams)).rows[0]!;
        return {
          period: q.from ? { from: q.from, to: q.to } : null,
          total: s.total,
          funnel: {
            marketing: s.marketing, submitted: s.submitted, interviewing: s.interviewing, assessment: s.assessment,
            confirmed: s.confirmed, paperwork: s.paperwork, joined: s.joined,
          },
          notResponding: s.not_responding,
          byStage: s.by_stage ?? {},
          items: page.rows.map((r) => ({
            candidate: { id: r.id, name: r.name },
            technology: { id: r.technology_id, name: r.technology },
            team: { id: r.team_id, name: r.team },
            recruiter: r.recruiter_id ? { id: r.recruiter_id, name: r.recruiter } : null,
            location: { id: r.location_id, name: r.location },
            marketingStatus: r.marketing_status,
            marketingStartDate: r.marketing_start_date,
            submissions: { count: r.sub_n, lastAt: r.sub_last?.toISOString() ?? null },
            interviews: { count: r.iv_n, cleared: r.iv_cleared, lastAt: r.iv_last?.toISOString() ?? null },
            assessments: { count: r.asm_n, passed: r.asm_passed, lastOn: r.asm_last },
            placement: r.pl_id ? {
              id: r.pl_id, status: r.pl_status, confirmedAt: r.pl_created!.toISOString(), tentativeStart: r.pl_start,
              joinedAt: r.pl_joined?.toISOString() ?? null,
              paperwork: r.ck_total ? { done: r.ck_done ?? 0, total: r.ck_total } : null,
            } : null,
            notResponding: r.not_responding,
            stage: r.stage,
          })),
          limit: q.limit,
          offset: q.offset,
        };
      });
    } catch (err) {
      if ((err as { code?: string }).code === "57014") {
        throw new ServiceUnavailableException("The report took too long; narrow the filters and try again");
      }
      throw err;
    }
  }

  /**
   * The `WITH ... rows AS (...)` prefix: one row per candidate the caller owns
   * under candidate:read, narrowed to report:read (like the dashboard), with
   * the pipeline aggregates. Activity tables are read under their own RLS, so
   * a count only includes rows the caller could list.
   */
  private baseSql(params: Params, report: EffectiveScope, cand: EffectiveScope, q: PipelineQuery): string {
    const p = bind(params);
    const where = [scopePredicate(owned(cand), params, "c")];
    if (!report.all) where.push(scopePredicate(owned(report), params, "c"));
    if (q.technologyId) where.push(`c.technology_id = ${p(q.technologyId)}::uuid`);
    if (q.teamId) where.push(`c.team_id = ${p(q.teamId)}::uuid`);
    if (q.recruiterId) where.push(`c.recruiter_id = ${p(q.recruiterId)}::uuid`);
    if (q.locationId) where.push(`c.location_id = ${p(q.locationId)}::uuid`);
    if (q.marketingStatus) where.push(`c.marketing_status = ${p(q.marketingStatus)}`);

    let inTs = (_col: string) => "true";
    let inDay = (_col: string) => "true";
    if (q.from && q.to) {
      const from = p(q.from);
      const to = p(q.to);
      // Calendar days in UTC, `to` inclusive.
      inTs = (col) => `(${col} >= (${from}::date::timestamp AT TIME ZONE 'UTC') AND ${col} < ((${to}::date + 1)::timestamp AT TIME ZONE 'UTC'))`;
      inDay = (col) => `(${col} BETWEEN ${from}::date AND ${to}::date)`;
    }
    const filters: string[] = [];
    if (q.from) {
      filters.push(`(sub_n > 0 OR iv_n > 0 OR iv_cleared > 0 OR asm_n > 0 OR ${inDay("marketing_start_date")}
        OR ${inTs("pl_created")} OR ${inTs("pl_joined")})`);
    }
    if (q.stage) filters.push(`stage = ${p(q.stage)}`);
    if (q.notResponding !== undefined) filters.push(q.notResponding ? "not_responding" : "NOT not_responding");

    return `WITH cand AS MATERIALIZED (
        SELECT c.id, c.person_id, c.technology_id, c.team_id, c.recruiter_id, c.location_id, c.marketing_status,
               c.marketing_start_date
          FROM eureka.candidate c WHERE ${where.join(" AND ")}),
      sub AS (
        SELECT s.candidate_id, count(*)::int AS n_all,
               count(*) FILTER (WHERE ${inTs("s.submitted_at")})::int AS n,
               max(s.submitted_at) FILTER (WHERE ${inTs("s.submitted_at")}) AS last_at
          FROM eureka.submission s WHERE s.candidate_id IN (SELECT id FROM cand) GROUP BY s.candidate_id),
      iv AS (
        SELECT i.candidate_id, count(*) FILTER (WHERE ${LIVE_INTERVIEW})::int AS n_all,
               count(*) FILTER (WHERE ${LIVE_INTERVIEW} AND ${inTs("i.starts_at")})::int AS n,
               count(*) FILTER (WHERE i.cleared AND ${inTs("i.cleared_at")})::int AS cleared,
               max(i.starts_at) FILTER (WHERE ${LIVE_INTERVIEW} AND ${inTs("i.starts_at")}) AS last_at
          FROM eureka.interview i WHERE i.candidate_id IN (SELECT id FROM cand) GROUP BY i.candidate_id),
      asm AS (
        SELECT a.candidate_id, count(*) FILTER (WHERE a.status <> 'cancelled')::int AS n_all,
               count(*) FILTER (WHERE a.status <> 'cancelled' AND ${inDay("a.assigned_on")})::int AS n,
               count(*) FILTER (WHERE a.status = 'passed' AND ${inDay("a.completed_on")})::int AS passed,
               max(a.assigned_on) FILTER (WHERE a.status <> 'cancelled' AND ${inDay("a.assigned_on")})::text AS last_on
          FROM eureka.assessment a WHERE a.candidate_id IN (SELECT id FROM cand) GROUP BY a.candidate_id),
      pl AS (
        SELECT DISTINCT ON (x.candidate_id) x.candidate_id, x.id, x.status, x.created_at, x.tentative_start, x.joined_at
          FROM eureka.placement x
         WHERE x.candidate_id IN (SELECT id FROM cand) AND x.status NOT IN ('backout', 'bgc_failed')
         ORDER BY x.candidate_id, x.created_at DESC, x.id DESC),
      ck AS (
        SELECT ci.placement_id, count(*) FILTER (WHERE ci.required)::int AS total,
               count(*) FILTER (WHERE ci.required AND ci.status IN ('verified', 'waived'))::int AS done
          FROM eureka.checklist_item ci WHERE ci.placement_id IN (SELECT id FROM pl) GROUP BY ci.placement_id),
      nr AS (
        SELECT DISTINCT f.candidate_id FROM eureka.candidate_nonresponse f
         WHERE f.status = 'open' AND f.candidate_id IN (SELECT id FROM cand)),
      agg AS (
        SELECT cand.*,
               coalesce(sub.n, 0) AS sub_n, sub.last_at AS sub_last,
               coalesce(iv.n, 0) AS iv_n, coalesce(iv.cleared, 0) AS iv_cleared, iv.last_at AS iv_last,
               coalesce(asm.n, 0) AS asm_n, coalesce(asm.passed, 0) AS asm_passed, asm.last_on AS asm_last,
               pl.id AS pl_id, pl.status AS pl_status, pl.created_at AS pl_created, pl.tentative_start::text AS pl_start,
               pl.joined_at AS pl_joined, ck.total AS ck_total, ck.done AS ck_done,
               (nr.candidate_id IS NOT NULL) AS not_responding,
               CASE WHEN pl.status = 'joined' THEN 'joined'
                    WHEN pl.status IN ('paperwork', 'bgc', 'ready') THEN 'paperwork'
                    WHEN pl.status = 'confirmed' THEN 'confirmed'
                    WHEN coalesce(asm.n_all, 0) > 0 THEN 'assessment'
                    WHEN coalesce(iv.n_all, 0) > 0 THEN 'interviewing'
                    WHEN coalesce(sub.n_all, 0) > 0 THEN 'submitted'
                    WHEN cand.marketing_start_date IS NOT NULL OR cand.marketing_status IN ${MARKETING_SQL} THEN 'marketing'
                    ELSE 'not_started' END AS stage
          FROM cand
          LEFT JOIN sub ON sub.candidate_id = cand.id
          LEFT JOIN iv ON iv.candidate_id = cand.id
          LEFT JOIN asm ON asm.candidate_id = cand.id
          LEFT JOIN pl ON pl.candidate_id = cand.id
          LEFT JOIN ck ON ck.placement_id = pl.id
          LEFT JOIN nr ON nr.candidate_id = cand.id),
      rows AS (SELECT * FROM agg${filters.length ? ` WHERE ${filters.join(" AND ")}` : ""})`;
  }

  // ---------------------------------------------------------------- assessments (PV-3, PV-4)

  /** The submission as the caller lists it (the activity predicate under RLS); 404 otherwise. */
  private async loadSubmission(c: pg.PoolClient, user: AuthedUser, id: string): Promise<SubmissionRef> {
    const scope = resolveScope(user.access, "submission:read");
    if (!scope) throw new NotFoundException();
    const params: Params = [id];
    const r = await c.query<SubmissionRef>(`SELECT s.id, s.recruiter_id, s.team_id, s.location_id, s.candidate_id
      FROM eureka.submission s LEFT JOIN eureka.candidate c ON c.id = s.candidate_id
      WHERE s.id = $1 AND ${activityPredicate(scope, params)}`, params);
    if (!r.rows[0]) throw new NotFoundException();
    return r.rows[0];
  }

  private canEdit(user: AuthedUser, s: SubmissionRef): boolean {
    return ownsActivity(resolveScope(user.access, "submission:update"),
      { recruiterId: s.recruiter_id, teamId: s.team_id, locationId: s.location_id });
  }

  async listAssessments(user: AuthedUser, submissionId: string) {
    return this.db.withUser(user.id, async (c) => {
      const s = await this.loadSubmission(c, user, submissionId);
      const rows = (await c.query<AssessmentRow>(`SELECT ${ASSESSMENT_COLS} FROM eureka.assessment a
        WHERE a.submission_id = $1 ORDER BY a.assigned_on DESC, a.created_at DESC, a.id`, [s.id])).rows;
      return { items: rows.map(presentAssessment), actions: { create: this.canEdit(user, s), update: this.canEdit(user, s) } };
    });
  }

  async createAssessment(user: AuthedUser, submissionId: string, body: CreateAssessment) {
    return this.db.withUser(user.id, async (c) => {
      const s = await this.loadSubmission(c, user, submissionId);
      if (!this.canEdit(user, s)) throw new ForbiddenException("Not permitted");
      const id = (await c.query<{ id: string }>(`SELECT authz.assessment_create($1, $2, $3, $4::date, $5::date, $6::date, $7) AS id`,
        [s.id, body.platform, body.status, body.assignedOn, body.dueOn ?? null, body.completedOn ?? null, body.score ?? null])
        .catch(mapPvError)).rows[0]!.id;
      await this.audit.record(c, {
        actorId: user.id, action: "assessment.created", entityType: "assessment", entityId: id,
        changes: { submissionId: s.id, candidateId: s.candidate_id, platform: body.platform, status: body.status },
      });
      const row = (await c.query<AssessmentRow>(`SELECT ${ASSESSMENT_COLS} FROM eureka.assessment a WHERE a.id = $1`, [id])).rows[0]!;
      return presentAssessment(row);
    });
  }

  async updateAssessment(user: AuthedUser, id: string, expected: number | null, parse: () => UpdateAssessment) {
    return this.db.withUser(user.id, async (c) => {
      const a = (await c.query<AssessmentRow>(`SELECT ${ASSESSMENT_COLS} FROM eureka.assessment a WHERE a.id = $1`, [id])).rows[0];
      if (!a) throw new NotFoundException();
      const s = await this.loadSubmission(c, user, a.submission_id);
      if (!this.canEdit(user, s)) throw new ForbiddenException("Not permitted");
      const body = parse();
      if (expected === null) throw new HttpException("if_match_required", HttpStatus.PRECONDITION_REQUIRED);
      if (expected !== a.row_version) throw new HttpException("stale", HttpStatus.PRECONDITION_FAILED);
      await c.query(`SELECT authz.assessment_update($1, $2, $3, $4, $5::date, $6::date, $7::date, $8)`,
        [id, expected, body.platform, body.status, body.assignedOn, body.dueOn ?? null, body.completedOn ?? null, body.score ?? null])
        .catch(mapPvError);
      await this.audit.record(c, {
        actorId: user.id, action: "assessment.updated", entityType: "assessment", entityId: id,
        changes: { submissionId: a.submission_id, platform: body.platform, status: body.status, fromStatus: a.status },
      });
      const row = (await c.query<AssessmentRow>(`SELECT ${ASSESSMENT_COLS} FROM eureka.assessment a WHERE a.id = $1`, [id])).rows[0]!;
      return presentAssessment(row);
    });
  }

  // ---------------------------------------------------------------- not responding (PV-5, PV-6)

  /** The candidate under candidate RLS (Open to all teams included, as the profile); 404 otherwise. */
  private async loadCandidate(c: pg.PoolClient, id: string) {
    const r = await c.query<{ id: string; recruiter_id: string | null; team_id: string; location_id: string; visibility: "team" | "all_teams" | "selected_teams"; marketing_status: string }>(
      `SELECT id, recruiter_id, team_id, location_id, visibility, marketing_status FROM eureka.candidate WHERE id = $1`, [id]);
    if (!r.rows[0]) throw new NotFoundException();
    return r.rows[0];
  }

  private canFlag(user: AuthedUser, cand: Awaited<ReturnType<PipelineReportService["loadCandidate"]>>): boolean {
    const scope = resolveScope(user.access, "candidate:update");
    return scope !== null && ownsCandidate(scope, {
      recruiterId: cand.recruiter_id, teamId: cand.team_id, locationId: cand.location_id,
      visibility: cand.visibility, marketingStatus: cand.marketing_status,
    });
  }

  async nonResponse(user: AuthedUser, candidateId: string) {
    return this.db.withUser(user.id, async (c) => {
      const cand = await this.loadCandidate(c, candidateId);
      const flags = (await c.query<FlagRow>(`SELECT f.id, f.reason, f.status, f.resolution, f.flagged_at, u.display_name AS flagged_by_name,
          f.resolved_at, f.hold_reached_at, f.warning_mail_sent_at, f.hold_mail_sent_at
        FROM eureka.candidate_nonresponse f LEFT JOIN eureka.app_user u ON u.id = f.flagged_by
        WHERE f.candidate_id = $1 ORDER BY f.flagged_at DESC, f.id LIMIT 10`, [cand.id])).rows;
      const open = flags.find((f) => f.status === "open") ?? null;
      const may = this.canFlag(user, cand);
      return {
        current: open ? presentFlag(open) : null,
        history: flags.filter((f) => f.status !== "open").map(presentFlag),
        actions: {
          flag: may && !open && !["placed", "terminated", "stopped"].includes(cand.marketing_status),
          resolve: may && open !== null,
        },
      };
    });
  }

  async flagNonResponse(user: AuthedUser, candidateId: string, reason: string) {
    return this.db.withUser(user.id, async (c) => {
      const cand = await this.loadCandidate(c, candidateId);
      if (!this.canFlag(user, cand)) throw new ForbiddenException("Not permitted");
      const id = (await c.query<{ id: string }>(`SELECT authz.nonresponse_flag($1, $2) AS id`, [cand.id, reason]).catch(mapPvError)).rows[0]!.id;
      await this.audit.record(c, {
        actorId: user.id, action: "candidate.nonresponse_flagged", entityType: "candidate", entityId: cand.id,
        changes: { flagId: id, reason },
      });
      return { id };
    });
  }

  async resolveNonResponse(user: AuthedUser, candidateId: string, resolution: string) {
    return this.db.withUser(user.id, async (c) => {
      const cand = await this.loadCandidate(c, candidateId);
      if (!this.canFlag(user, cand)) throw new ForbiddenException("Not permitted");
      const id = (await c.query<{ id: string }>(`SELECT authz.nonresponse_resolve($1, $2) AS id`, [cand.id, resolution]).catch(mapPvError)).rows[0]!.id;
      await this.audit.record(c, {
        actorId: user.id, action: "candidate.nonresponse_resolved", entityType: "candidate", entityId: cand.id,
        changes: { flagId: id, resolution },
      });
      return { id };
    });
  }
}
