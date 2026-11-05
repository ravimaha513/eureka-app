import {
  ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, UnprocessableEntityException,
} from "@nestjs/common";
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
import { idempotent, parseIdempotencyKey } from "../../platform/idempotency.js";
import { likeContains, nameSearch } from "../../platform/sql.js";
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

/** Idempotency-Key scope for POST /submissions (platform/idempotency.ts). */
const CREATE_ENDPOINT = "POST /api/v1/submissions";

/**
 * Optional If-Match (R-10 phase 1): `undefined` = no header (no check, as before);
 * a number = the rowVersion the client saw; `null` = a header that is not a version (always stale).
 */
export type ExpectedVersion = number | null | undefined;
const stale = () => new HttpException("stale", HttpStatus.PRECONDITION_FAILED);

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

/**
 * Detail corrections (lead and above, submission.details:update); status is a
 * transition. Only the keys sent are changed; null clears an optional field.
 */
export const EditSubmission = z
  .object({
    jobTitle: z.string().trim().min(1).max(160),
    clientId: uuid,
    vendorId: uuid.nullable(),
    rate: z.number().positive().max(1000).multipleOf(0.01).nullable(),
    jobId: uuid.nullable(),
    submittedAt: z.string().datetime({ offset: true }),
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "no_changes" });
export type EditSubmission = z.infer<typeof EditSubmission>;

export const SubmissionListQuery = z
  .object({
    status: z.enum(SUBMISSION_STATUSES).optional(),
    candidateId: uuid.optional(),
    /** Candidate name contains this text. */
    candidate: z.string().trim().min(1).max(100).optional(),
    /** The candidate's training batch (candidate.batch_id). */
    batchId: uuid.optional(),
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

export interface TrailStep { id: string; stage: string; round: string; result: string; callStatus: string; startsAt: string }

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
  details_edited_at: Date | null;
  details_edited_by_name: string | null;
  row_version: number;
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
         s.details_edited_at, eu.display_name AS details_edited_by_name, s.row_version,
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
  LEFT JOIN eureka.app_user eu ON eu.id = s.details_edited_by
  LEFT JOIN eureka.candidate c ON c.id = s.candidate_id
  LEFT JOIN eureka.person p ON p.id = c.person_id
  CROSS JOIN LATERAL (
    SELECT count(*) FILTER (WHERE i.call_status NOT IN ('cancelled','no_invite'))::int AS n,
           max(i.starts_at) FILTER (WHERE i.call_status NOT IN ('cancelled','no_invite')) AS last_at,
           jsonb_agg(jsonb_build_object('id', i.id, 'stage', ${interviewStageSql("i.round")}, 'round', i.round, 'result', i.result,
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

/** Detail-edit refusals from authz.edit_submission (migration 0440). */
const EDIT_CONFLICTS = new Set(["submission_placed", "client_locked"]);
const EDIT_INVALID = new Set(["invalid_job_title", "invalid_rate", "invalid_submitted_at", "client_not_found", "vendor_not_found", "invalid_change",
  "job_not_found", "job_client_mismatch", "job_not_open"]);
function mapEditError(err: unknown): never {
  const e = err as { message?: string; code?: string };
  if (e.code === "23514" && e.message && EDIT_CONFLICTS.has(e.message)) throw new ConflictException(e.message);
  if (e.code === "23514" && e.message && EDIT_INVALID.has(e.message)) throw new UnprocessableEntityException(e.message);
  if (e.code === "42501" && e.message === "field_not_permitted") throw new ForbiddenException(e.message);
  mapPipelineError(err);
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
      /** Latest detail correction (PATCH /submissions/:id), or null when never edited. */
      detailsEdited: r.details_edited_at ? { at: r.details_edited_at, byName: r.details_edited_by_name } : null,
      /** Interviews the caller can see (not cancelled / no invite); lastInterviewAt is the latest start. */
      interviewCount: r.interview_count,
      lastInterviewAt: r.last_interview_at,
      /** Every visible interview in time order with its funnel stage and result (cancelled ones included). */
      interviews: r.trail ?? [],
      /** Status of the latest placement made from this submission, or null. */
      placementStatus: r.placement_status,
      /** Optimistic concurrency: send it back as If-Match on PATCH (optional; 412 when stale). */
      rowVersion: r.row_version,
      /** Hints for the UI (docs/placements-api.md); every write is checked again. */
      actions: submissionActions(access, activityRef(r), r.status, visibleCandidate(r)),
    };
  }

  /**
   * Optional Idempotency-Key (R-14): a retry with the same body returns the first answer,
   * another body 409. The duplicate check runs under a transaction lock on the
   * (candidate, client) pair, so concurrent submissions of the same pair are serialised:
   * the later one sees the earlier and gets duplicateWarning: true.
   */
  async create(user: AuthedUser, body: CreateSubmission, idempotencyKey?: string) {
    parseIdempotencyKey(idempotencyKey, { required: false });
    const scope = resolveScope(user.access, "submission:create");
    return this.db.withUser(user.id, async (c) => {
      // Read-before-write: the candidate must be visible for submission:create (a replay too).
      const { rows } = await c.query(
        `SELECT recruiter_id, team_id, location_id, visibility, marketing_status FROM eureka.candidate WHERE id = $1`,
        [body.candidateId]);
      const r = rows[0];
      if (!r || !candidateVisible(scope, { id: body.candidateId,
        recruiterId: r.recruiter_id, teamId: r.team_id, locationId: r.location_id,
        visibility: r.visibility, marketingStatus: r.marketing_status,
      })) throw new NotFoundException();

      return idempotent(c, user, CREATE_ENDPOINT, idempotencyKey, body, { required: false }, async () => {
        // The duplicate rule is per candidate and client (authz.recent_submission_exists), so that is the lock;
        // it covers every job of the client. Held until commit, so the next check sees this row.
        await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('submission:' || $1::text || ':' || $2::text, 0))`,
          [body.candidateId, body.clientId]);
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
        return { id: ins.rows[0]!.id, duplicateWarning: dup.rows[0]!.d, rowVersion: 1 };
      });
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
    if (q.candidate) where.push(nameSearch("p", p(likeContains(q.candidate))));
    if (q.batchId) where.push(`c.batch_id = ${p(q.batchId)}::uuid`);
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
        LEFT JOIN eureka.person p ON p.id = c.person_id
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

  /**
   * With If-Match, API writes to one submission queue on a transaction lock before reading it,
   * so a request that lost the race reads the winner's version and gets 412 up front (instead of,
   * say, a 422 from re-validating against the winner's state). Other writers are caught by versionAfter.
   */
  private async serialiseVersioned(c: pg.PoolClient, id: string, expected: ExpectedVersion) {
    if (expected === undefined) return;
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('submission-write:' || $1::text, 0))`, [id]);
  }

  /**
   * The row_version after a definer write, read under the row lock that write took. With If-Match,
   * anything but expected + bumps means a concurrent write committed between our read and the lock: 412
   * (the transaction rolls back).
   */
  private async versionAfter(c: pg.PoolClient, id: string, expected: ExpectedVersion, bumps: number): Promise<number> {
    const v = (await c.query<{ v: number }>(`SELECT row_version AS v FROM eureka.submission WHERE id = $1`, [id])).rows[0]?.v;
    if (v === undefined) throw new NotFoundException();
    if (expected !== undefined && v !== (expected ?? 0) + bumps) throw stale();
    return v;
  }

  async get(user: AuthedUser, id: string) {
    const row = await this.db.withUser(user.id, (c) => this.load(c, user, id));
    return this.present(user.access, row);
  }

  /** Read-before-write (design B3): 404 when not visible, 403 when visible but not updatable. */
  async changeStatus(user: AuthedUser, id: string, body: StatusChange, expected?: ExpectedVersion) {
    return this.db.withUser(user.id, async (c) => {
      await this.serialiseVersioned(c, id, expected);
      const row = await this.load(c, user, id);
      if (!ownsActivity(resolveScope(user.access, "submission:update"), activityRef(row))) {
        throw new ForbiddenException("Not permitted");
      }
      if (expected !== undefined && expected !== row.row_version) throw stale();
      if (!submissionTransitionAllowed(row.status, body.to)) throw new UnprocessableEntityException("invalid_transition");
      let status: string;
      try {
        const r = await c.query<{ s: string }>(`SELECT authz.transition_submission($1, $2, $3) AS s`,
          [id, body.to, body.rejectionReason ?? null]);
        status = r.rows[0]!.s;
      } catch (err) {
        mapPipelineError(err);
      }
      // The transition is one UPDATE (+1). Anything else means another write got in between our read and its row lock.
      const rowVersion = await this.versionAfter(c, id, expected, 1);
      await this.audit.record(c, {
        actorId: user.id, action: "submission.status", entityType: "submission", entityId: id,
        changes: { from: row.status, to: status, ...(body.rejectionReason ? { rejectionReasonGiven: true } : {}) },
      });
      return { id, status, rejectionReason: body.rejectionReason ?? null, rowVersion };
    });
  }

  /**
   * Correct a submission's details (lead and above). Read-before-write: 404 when not
   * visible, 403 without submission.details:update (or rate:read for the rate);
   * authz.edit_submission checks everything again. The audit keeps field names only (rule 5).
   */
  async edit(user: AuthedUser, id: string, body: EditSubmission, expected?: ExpectedVersion) {
    return this.db.withUser(user.id, async (c) => {
      await this.serialiseVersioned(c, id, expected);
      const row = await this.load(c, user, id);
      if (!ownsActivity(resolveScope(user.access, "submission.details:update"), activityRef(row))) {
        throw new ForbiddenException("Not permitted");
      }
      if (expected !== undefined && expected !== row.row_version) throw stale();
      if (body.rate !== undefined && !ownsActivity(resolveScope(user.access, "rate:read"), activityRef(row))) {
        throw new ForbiddenException("field_not_permitted");
      }
      const r = await c.query<{ ch: string[] }>(`SELECT authz.edit_submission($1, $2::jsonb) AS ch`, [id, JSON.stringify(body)])
        .catch(mapEditError);
      const changed = r.rows[0]!.ch;
      // authz.edit_submission locks the row and updates it once when something changed (+1), else not at all.
      await this.versionAfter(c, id, expected, changed.length > 0 ? 1 : 0);
      if (changed.length > 0) {
        await this.audit.record(c, {
          actorId: user.id, action: "submission.edited", entityType: "submission", entityId: id,
          changes: { fields: changed },
        });
      }
      return { changed, submission: this.present(user.access, await this.load(c, user, id)) };
    });
  }
}
