import { ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import type pg from "pg";
import { z } from "zod";
import {
  INTERVIEW_STAGES,
  activityVisible,
  candidateVisible,
  ownsActivity,
  resolveScope,
  submissionActions,
  type CandidateRef,
  type EffectiveScope,
  type UserAccess,
} from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { likeContains } from "../../platform/sql.js";
import { scopePredicate } from "../candidates/candidates.service.js";
import {
  Cursor,
  QueryInstant,
  SUBMISSION_STATUSES,
  fromMicros,
  interviewStageSql,
  mapPipelineError,
  splitCursor,
  submissionTransitionAllowed,
  toMicros,
} from "./pipeline.js";

const uuid = z.string().uuid();

export const CreateSubmission = z
  .object({
    candidateId: uuid,
    jobTitle: z.string().min(1).max(160),
    clientId: uuid,
    vendorId: uuid.optional(),
    rate: z.number().positive().max(1000).optional(),
    /** jobs-portal: the client requirement this submission answers (an open job of the same client). */
    jobId: uuid.optional(),
  })
  .strict(); // recruiter, team and location snapshots are set by the database
export type CreateSubmission = z.infer<typeof CreateSubmission>;

export const SubmissionListQuery = z
  .object({
    status: z.enum(SUBMISSION_STATUSES).optional(),
    candidateId: uuid.optional(),
    recruiterId: uuid.optional(),
    from: QueryInstant.optional(),
    to: QueryInstant.optional(),
    /** Job title or client name contains this text. */
    search: z.string().trim().min(1).max(100).optional(),
    /** "true": only submissions that got an interview (see INTERVIEWED). */
    interviewed: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
    /** Only submissions that reached this funnel stage (a live interview of that stage), or `placed`. */
    stage: z.enum([...INTERVIEW_STAGES, "placed"]).optional(),
    cursor: Cursor.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type SubmissionListQuery = z.infer<typeof SubmissionListQuery>;

export const SubmissionSummaryQuery = SubmissionListQuery.omit({ status: true, interviewed: true, stage: true, cursor: true, limit: true }).strict();
export type SubmissionSummaryQuery = z.infer<typeof SubmissionSummaryQuery>;

export const StatusChange = z
  .object({
    to: z.enum(SUBMISSION_STATUSES),
    rejectionReason: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .refine((b) => b.to !== "rejected" || b.rejectionReason !== undefined, {
    message: "rejection_reason_required", path: ["rejectionReason"],
  })
  .refine((b) => b.to === "rejected" || b.rejectionReason === undefined, {
    message: "rejection_reason_not_allowed", path: ["rejectionReason"],
  });
export type StatusChange = z.infer<typeof StatusChange>;

/** Interviews that happened or are booked (cancelled and no-invite calls don't count). */
const LIVE_INTERVIEW = `i.submission_id = s.id AND i.call_status NOT IN ('cancelled','no_invite')`;
/**
 * The submission got an interview: it reached an interview status, or an
 * interview is on record (a later rejection keeps it in this set).
 */
const INTERVIEWED = `(s.status IN ('interview_requested','interview_scheduled','interview_completed','selected')
  OR EXISTS (SELECT 1 FROM eureka.interview i WHERE ${LIVE_INTERVIEW}))`;
/** A live interview of this funnel stage (parameter placeholder). */
const REACHED_STAGE = (ph: string) =>
  `EXISTS (SELECT 1 FROM eureka.interview i WHERE ${LIVE_INTERVIEW} AND ${interviewStageSql("i.round")} = ${ph})`;
/** A placement that has not fallen through (backout, failed BGC, joining issue). */
const PLACED = `EXISTS (SELECT 1 FROM eureka.placement pl WHERE pl.submission_id = s.id
  AND pl.status NOT IN ('backout','bgc_failed','joining_issue'))`;

export interface TrailStep { stage: string; round: string; result: string; callStatus: string; startsAt: string }

interface SubmissionRow {
  id: string;
  candidate_id: string;
  candidate_name: string | null;
  recruiter_id: string;
  recruiter_name: string | null;
  team_id: string | null;
  location_id: string | null;
  job_title: string;
  client_id: string;
  client: string;
  vendor_id: string | null;
  rate: string | null;
  status: string;
  rejection_reason: string | null;
  job_id: string | null;
  submitted_at: Date;
  status_changed_at: Date | null;
  k: string;
  c_recruiter: string | null;
  c_team: string | null;
  c_location: string | null;
  visibility: CandidateRef["visibility"] | null;
  marketing_status: string | null;
  interview_count: number;
  trail: TrailStep[] | null;
  placement_status: string | null;
  last_interview_at: Date | null;
}

const SELECT = `
  SELECT s.id, s.candidate_id, s.recruiter_id, s.team_id, s.location_id, s.job_title, s.client_id, s.vendor_id,
         s.rate, s.status, s.rejection_reason, s.job_id, s.submitted_at, s.status_changed_at, ${toMicros("s.submitted_at")} AS k,
         cl.name AS client, ru.display_name AS recruiter_name,
         CASE WHEN p.id IS NOT NULL THEN p.first_name || ' ' || p.last_name END AS candidate_name,
         c.recruiter_id AS c_recruiter, c.team_id AS c_team, c.location_id AS c_location,
         c.visibility, c.marketing_status,
         iv.n AS interview_count, iv.last_at AS last_interview_at, iv.trail,
         (SELECT pl.status FROM eureka.placement pl WHERE pl.submission_id = s.id
           ORDER BY pl.created_at DESC LIMIT 1) AS placement_status
  FROM eureka.submission s
  JOIN eureka.client cl ON cl.id = s.client_id
  LEFT JOIN eureka.app_user ru ON ru.id = s.recruiter_id
  LEFT JOIN eureka.candidate c ON c.id = s.candidate_id
  LEFT JOIN eureka.person p ON p.id = c.person_id
  CROSS JOIN LATERAL (
    SELECT count(*) FILTER (WHERE i.call_status NOT IN ('cancelled','no_invite'))::int AS n,
           max(i.starts_at) FILTER (WHERE i.call_status NOT IN ('cancelled','no_invite')) AS last_at,
           jsonb_agg(jsonb_build_object('stage', ${interviewStageSql("i.round")}, 'round', i.round, 'result', i.result,
             'callStatus', i.call_status, 'startsAt', i.starts_at) ORDER BY i.starts_at, i.id) AS trail
    FROM eureka.interview i WHERE i.submission_id = s.id) iv`;

const activityRef = (r: SubmissionRow) => ({
  recruiterId: r.recruiter_id,
  teamId: r.team_id,
  locationId: r.location_id,
  candidate: {
    id: r.candidate_id, recruiterId: r.c_recruiter, teamId: r.c_team, locationId: r.c_location,
    visibility: r.visibility ?? "team", marketingStatus: r.marketing_status ?? "",
  },
});

/** The candidate as the caller sees it (the join runs under candidate RLS; null when not readable). */
const visibleCandidate = (r: SubmissionRow): CandidateRef | null =>
  r.c_team === null || r.visibility === null || r.marketing_status === null ? null : {
    id: r.candidate_id, recruiterId: r.c_recruiter, teamId: r.c_team, locationId: r.c_location,
    visibility: r.visibility, marketingStatus: r.marketing_status,
  };

/**
 * Activity visibility predicate (design B4.4): the actor snapshot on `s`, or
 * the candidate owned through the caller's scope (never the all-teams rule).
 */
export function activityPredicate(scope: EffectiveScope, params: unknown[], activity = "s", cand = "c"): string {
  const actor = scopePredicate({ ...scope, allTeams: false, hotlistOpen: false }, params, activity);
  const owner = scopePredicate({ ...scope, allTeams: false, hotlistOpen: false }, params, cand);
  return `(${actor} OR ${owner})`;
}

/** jobs-portal (migration 0060): the submission's job must be a readable, open client requirement of its client. */
function mapSubmissionJobError(err: unknown): never {
  const e = err as { message?: string; code?: string };
  if (e.code === "23514" && (e.message === "job_not_found" || e.message === "job_client_mismatch" || e.message === "job_not_open")) {
    throw new UnprocessableEntityException(e.message);
  }
  throw err;
}

@Injectable()
export class SubmissionsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  /** Field policy (design B4.6): rate only when rate:read covers the row; otherwise the key is omitted. */
  present(access: UserAccess, r: SubmissionRow) {
    const rateScope = resolveScope(access, "rate:read");
    // Rates follow the team that negotiated them (the actor snapshot), not candidate ownership.
    const showRate = ownsActivity(rateScope, activityRef(r));
    return {
      id: r.id,
      candidateId: r.candidate_id,
      candidateName: r.candidate_name,
      recruiterId: r.recruiter_id,
      recruiterName: r.recruiter_name,
      teamId: r.team_id,
      locationId: r.location_id,
      jobTitle: r.job_title,
      clientId: r.client_id,
      client: r.client,
      vendorId: r.vendor_id,
      ...(showRate ? { rate: r.rate === null ? null : Number(r.rate) } : {}),
      status: r.status,
      rejectionReason: r.rejection_reason,
      jobId: r.job_id,
      submittedAt: r.submitted_at,
      statusChangedAt: r.status_changed_at,
      /** Interviews the caller can see (not cancelled / no invite); lastInterviewAt is the latest start. */
      interviewCount: r.interview_count,
      lastInterviewAt: r.last_interview_at,
      /** Every visible interview in time order with its funnel stage and result (cancelled ones included). */
      interviews: r.trail ?? [],
      /** Status of the latest placement made from this submission, or null. */
      placementStatus: r.placement_status,
      /** Hints for the UI (docs/placements-api.md); every write is checked again. */
      actions: submissionActions(access, activityRef(r), r.status, visibleCandidate(r)),
    };
  }

  async create(user: AuthedUser, body: CreateSubmission) {
    const scope = resolveScope(user.access, "submission:create");
    return this.db.withUser(user.id, async (c) => {
      // Read-before-write: the candidate must be visible for submission:create.
      const { rows } = await c.query(
        `SELECT recruiter_id, team_id, location_id, visibility, marketing_status FROM eureka.candidate WHERE id = $1`,
        [body.candidateId]);
      const r = rows[0];
      if (!r || !candidateVisible(scope, { id: body.candidateId,
        recruiterId: r.recruiter_id, teamId: r.team_id, locationId: r.location_id,
        visibility: r.visibility, marketingStatus: r.marketing_status,
      })) throw new NotFoundException();

      const dup = await c.query<{ d: boolean }>(`SELECT authz.recent_submission_exists($1,$2) AS d`, [body.candidateId, body.clientId]);
      const ins = await c.query<{ id: string }>(
        `INSERT INTO eureka.submission (candidate_id, job_title, client_id, vendor_id, rate, job_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [body.candidateId, body.jobTitle, body.clientId, body.vendorId ?? null, body.rate ?? null, body.jobId ?? null])
        .catch(mapSubmissionJobError);
      await this.audit.record(c, {
        actorId: user.id, action: "submission.created", entityType: "submission", entityId: ins.rows[0]!.id,
        // Design B3: duplicate checks are audited (yes/no only, like the answer itself).
        changes: { candidateId: body.candidateId, clientId: body.clientId, duplicateWarning: dup.rows[0]!.d,
          ...(body.jobId ? { jobId: body.jobId } : {}) },
      });
      return { id: ins.rows[0]!.id, duplicateWarning: dup.rows[0]!.d };
    });
  }

  /** WHERE terms shared by the list and its summary. */
  private filters(user: AuthedUser, q: SubmissionSummaryQuery & Partial<Pick<SubmissionListQuery, "status" | "interviewed" | "stage">>) {
    const scope = resolveScope(user.access, "submission:read");
    if (!scope) throw new ForbiddenException();
    const params: unknown[] = [];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const where = [activityPredicate(scope, params)];
    if (q.status) where.push(`s.status = ${p(q.status)}`);
    if (q.candidateId) where.push(`s.candidate_id = ${p(q.candidateId)}`);
    if (q.recruiterId) where.push(`s.recruiter_id = ${p(q.recruiterId)}`);
    if (q.from) where.push(`s.submitted_at >= ${p(q.from)}::timestamptz`);
    if (q.to) where.push(`s.submitted_at < ${p(q.to)}::timestamptz`);
    if (q.search) {
      const pat = p(likeContains(q.search));
      where.push(`(s.job_title ILIKE ${pat} ESCAPE '\\' OR cl.name ILIKE ${pat} ESCAPE '\\')`);
    }
    if (q.interviewed !== undefined) where.push(q.interviewed ? INTERVIEWED : `NOT ${INTERVIEWED}`);
    if (q.stage) where.push(q.stage === "placed" ? PLACED : REACHED_STAGE(p(q.stage)));
    return { params, p, where };
  }

  /**
   * Counts for the filtered set (all statuses): total, per status, how many got
   * an interview, and the funnel: submissions that reached each interview stage
   * (held = a live interview of that stage, cleared = one with a cleared result)
   * and placements. Lets 1000 submissions read as 5 interviews, 2 L1s, 1 placement.
   */
  async summary(user: AuthedUser, q: SubmissionSummaryQuery) {
    const { params, where } = this.filters(user, q);
    const sql = `
      WITH s AS (
        SELECT s.id, s.status, ${INTERVIEWED} AS interviewed, ${PLACED} AS placed
        FROM eureka.submission s
        JOIN eureka.client cl ON cl.id = s.client_id
        LEFT JOIN eureka.candidate c ON c.id = s.candidate_id
        WHERE ${where.join(" AND ")}),
      st AS (
        SELECT DISTINCT i.submission_id, ${interviewStageSql("i.round")} AS stage, i.result = 'cleared' AS cleared
        FROM eureka.interview i JOIN s ON s.id = i.submission_id
        WHERE i.call_status NOT IN ('cancelled','no_invite'))
      SELECT
        (SELECT coalesce(jsonb_object_agg(status, n), '{}') FROM (SELECT status, count(*)::int AS n FROM s GROUP BY status) x) AS by_status,
        (SELECT count(*)::int FROM s) AS total,
        (SELECT count(*) FILTER (WHERE interviewed)::int FROM s) AS interviewed,
        (SELECT count(*) FILTER (WHERE placed)::int FROM s) AS placed,
        (SELECT coalesce(jsonb_object_agg(stage, jsonb_build_object('held', held, 'cleared', cleared)), '{}') FROM (
           SELECT stage, count(DISTINCT submission_id)::int AS held,
                  count(DISTINCT submission_id) FILTER (WHERE cleared)::int AS cleared
           FROM st GROUP BY stage) y) AS stages`;
    const row = await this.db.withUser(user.id, async (c) =>
      (await c.query<{ by_status: Record<string, number>; total: number; interviewed: number; placed: number;
        stages: Record<string, { held: number; cleared: number }> }>(sql, params)).rows[0]!);
    const byStatus = Object.fromEntries(SUBMISSION_STATUSES.map((st) => [st, row.by_status[st] ?? 0])) as Record<string, number>;
    const stages = Object.fromEntries(INTERVIEW_STAGES.map((st) => [st, row.stages[st] ?? { held: 0, cleared: 0 }]));
    return {
      total: row.total, interviewed: row.interviewed, byStatus,
      funnel: { submitted: row.total, interviewed: row.interviewed, stages, selected: byStatus.selected ?? 0, placed: row.placed },
    };
  }

  async list(user: AuthedUser, q: SubmissionListQuery) {
    const { params, p, where } = this.filters(user, q);
    if (q.cursor) {
      const [k, id] = splitCursor(q.cursor);
      where.push(`(s.submitted_at, s.id) < (${fromMicros(p(k))}, ${p(id)}::uuid)`);
    }
    const sql = `${SELECT} WHERE ${where.join(" AND ")} ORDER BY s.submitted_at DESC, s.id DESC LIMIT ${p(q.limit + 1)}`;
    const rows = await this.db.withUser(user.id, async (c) => (await c.query<SubmissionRow>(sql, params)).rows);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => this.present(user.access, r)),
      nextCursor: rows.length > q.limit && last ? `${last.k}.${last.id}` : null,
    };
  }

  private async load(c: pg.PoolClient, user: AuthedUser, id: string): Promise<SubmissionRow> {
    const scope = resolveScope(user.access, "submission:read");
    if (!scope) throw new NotFoundException();
    const params: unknown[] = [id];
    const { rows } = await c.query<SubmissionRow>(
      `${SELECT} WHERE s.id = $1 AND ${activityPredicate(scope, params)}`, params);
    if (!rows[0]) throw new NotFoundException();
    return rows[0];
  }

  async get(user: AuthedUser, id: string) {
    const row = await this.db.withUser(user.id, (c) => this.load(c, user, id));
    return this.present(user.access, row);
  }

  /** Read-before-write (design B3): 404 when not visible, 403 when visible but not updatable. */
  async changeStatus(user: AuthedUser, id: string, body: StatusChange) {
    return this.db.withUser(user.id, async (c) => {
      const row = await this.load(c, user, id);
      if (!ownsActivity(resolveScope(user.access, "submission:update"), activityRef(row))) {
        throw new ForbiddenException("Not permitted");
      }
      if (!submissionTransitionAllowed(row.status, body.to)) throw new UnprocessableEntityException("invalid_transition");
      let status: string;
      try {
        const r = await c.query<{ s: string }>(`SELECT authz.transition_submission($1, $2, $3) AS s`,
          [id, body.to, body.rejectionReason ?? null]);
        status = r.rows[0]!.s;
      } catch (err) {
        mapPipelineError(err);
      }
      await this.audit.record(c, {
        actorId: user.id, action: "submission.status", entityType: "submission", entityId: id,
        changes: { from: row.status, to: status, ...(body.rejectionReason ? { rejectionReasonGiven: true } : {}) },
      });
      return { id, status, rejectionReason: body.rejectionReason ?? null };
    });
  }
}
