import { ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import type pg from "pg";
import { z } from "zod";
import {
  activityVisible,
  candidateVisible,
  ownsActivity,
  resolveScope,
  type EffectiveScope,
  type UserAccess,
} from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { scopePredicate } from "../candidates/candidates.service.js";
import {
  Cursor,
  QueryInstant,
  SUBMISSION_STATUSES,
  fromMicros,
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
    cursor: Cursor.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type SubmissionListQuery = z.infer<typeof SubmissionListQuery>;

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
  submitted_at: Date;
  status_changed_at: Date | null;
  k: string;
  c_recruiter: string | null;
  c_team: string | null;
  c_location: string | null;
  visibility: "team" | "all_teams" | null;
  marketing_status: string | null;
}

const SELECT = `
  SELECT s.id, s.candidate_id, s.recruiter_id, s.team_id, s.location_id, s.job_title, s.client_id, s.vendor_id,
         s.rate, s.status, s.rejection_reason, s.submitted_at, s.status_changed_at, ${toMicros("s.submitted_at")} AS k,
         cl.name AS client, ru.display_name AS recruiter_name,
         CASE WHEN p.id IS NOT NULL THEN p.first_name || ' ' || p.last_name END AS candidate_name,
         c.recruiter_id AS c_recruiter, c.team_id AS c_team, c.location_id AS c_location,
         c.visibility, c.marketing_status
  FROM eureka.submission s
  JOIN eureka.client cl ON cl.id = s.client_id
  LEFT JOIN eureka.app_user ru ON ru.id = s.recruiter_id
  LEFT JOIN eureka.candidate c ON c.id = s.candidate_id
  LEFT JOIN eureka.person p ON p.id = c.person_id`;

const activityRef = (r: SubmissionRow) => ({
  recruiterId: r.recruiter_id,
  teamId: r.team_id,
  locationId: r.location_id,
  candidate: {
    recruiterId: r.c_recruiter, teamId: r.c_team, locationId: r.c_location,
    visibility: r.visibility ?? "team", marketingStatus: r.marketing_status ?? "",
  },
});

/**
 * Activity visibility predicate (design B4.4): the actor snapshot on `s`, or
 * the candidate owned through the caller's scope (never the all-teams rule).
 */
export function activityPredicate(scope: EffectiveScope, params: unknown[], activity = "s", cand = "c"): string {
  const actor = scopePredicate({ ...scope, allTeams: false, hotlistOpen: false }, params, activity);
  const owner = scopePredicate({ ...scope, allTeams: false, hotlistOpen: false }, params, cand);
  return `(${actor} OR ${owner})`;
}

@Injectable()
export class SubmissionsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  /** Field policy (design B4.6): rate only when rate:read covers the row; otherwise the key is omitted. */
  present(access: UserAccess, r: SubmissionRow) {
    const rateScope = resolveScope(access, "rate:read");
    const showRate = activityVisible(rateScope, activityRef(r));
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
      submittedAt: r.submitted_at,
      statusChangedAt: r.status_changed_at,
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
      if (!r || !candidateVisible(scope, {
        recruiterId: r.recruiter_id, teamId: r.team_id, locationId: r.location_id,
        visibility: r.visibility, marketingStatus: r.marketing_status,
      })) throw new NotFoundException();

      const dup = await c.query<{ d: boolean }>(`SELECT authz.recent_submission_exists($1,$2) AS d`, [body.candidateId, body.clientId]);
      const ins = await c.query<{ id: string }>(
        `INSERT INTO eureka.submission (candidate_id, job_title, client_id, vendor_id, rate)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [body.candidateId, body.jobTitle, body.clientId, body.vendorId ?? null, body.rate ?? null]);
      await this.audit.record(c, {
        actorId: user.id, action: "submission.created", entityType: "submission", entityId: ins.rows[0]!.id,
        changes: { candidateId: body.candidateId, clientId: body.clientId },
      });
      return { id: ins.rows[0]!.id, duplicateWarning: dup.rows[0]!.d };
    });
  }

  async list(user: AuthedUser, q: SubmissionListQuery) {
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
        changes: { from: row.status, to: status, ...(body.rejectionReason ? { rejectionReason: body.rejectionReason } : {}) },
      });
      return { id, status, rejectionReason: body.rejectionReason ?? null };
    });
  }
}
