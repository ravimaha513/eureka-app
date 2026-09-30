import { ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import type pg from "pg";
import {
  activityVisible,
  ownsActivity,
  resolveScope,
  resolveScopeFor,
  type ActivityRef,
  type Scope,
  type UserAccess,
} from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { activityPredicate } from "../submissions/submissions.service.js";
import { TERMINAL_SUBMISSION_STATUSES, fromMicros, mapPipelineError, splitCursor, toMicros } from "../submissions/pipeline.js";
import { interviewTimesProblem } from "../submissions/pipeline.js";
import {
  COLUMN,
  LOCATION_FIELDS,
  SALES_FIELDS,
  type CreateFeedback,
  type CreateInterview,
  type FeedbackKind,
  type InterviewField,
  type InterviewListQuery,
  type UpdateInterview,
} from "./interviews.schemas.js";

interface InterviewRow {
  id: string;
  submission_id: string;
  candidate_id: string;
  candidate_name: string | null;
  recruiter_id: string;
  recruiter_name: string | null;
  team_id: string | null;
  team_name: string | null;
  location_id: string | null;
  location_name: string | null;
  client_id: string | null;
  client_name: string | null;
  round: string;
  starts_at: Date;
  ends_at: Date;
  coach_id: string | null;
  coach_name: string | null;
  invite_received: boolean;
  call_status: string;
  cleared: boolean;
  cleared_at: Date | null;
  otter_url: string | null;
  recording_url: string | null;
  consent_captured: boolean;
  system_name: string | null;
  updated_at: Date;
  k: string;
  c_recruiter: string | null;
  c_team: string | null;
  c_location: string | null;
}

const SELECT = `
  SELECT i.id, i.submission_id, i.candidate_id, i.recruiter_id, i.team_id, i.location_id, i.client_id,
         i.round, i.starts_at, i.ends_at, i.coach_id, i.invite_received, i.call_status, i.cleared, i.cleared_at,
         i.otter_url, i.recording_url, i.consent_captured, i.system_name, i.updated_at, ${toMicros("i.starts_at")} AS k,
         CASE WHEN p.id IS NOT NULL THEN p.first_name || ' ' || p.last_name END AS candidate_name,
         ru.display_name AS recruiter_name, cu.display_name AS coach_name,
         tm.name AS team_name, l.name AS location_name, cl.name AS client_name,
         c.recruiter_id AS c_recruiter, c.team_id AS c_team, c.location_id AS c_location
  FROM eureka.interview i
  LEFT JOIN eureka.candidate c ON c.id = i.candidate_id
  LEFT JOIN eureka.person p ON p.id = c.person_id
  LEFT JOIN eureka.app_user ru ON ru.id = i.recruiter_id
  LEFT JOIN eureka.app_user cu ON cu.id = i.coach_id
  LEFT JOIN eureka.team tm ON tm.id = i.team_id
  LEFT JOIN eureka.location l ON l.id = i.location_id
  LEFT JOIN eureka.client cl ON cl.id = i.client_id`;

const SALES_SCOPES: readonly Scope[] = ["own", "team", "hierarchy", "org"];
const FEEDBACK_SCOPES: Record<FeedbackKind, readonly Scope[]> = {
  coach: ["coached"],
  location: ["location"],
  client: SALES_SCOPES,
};

const ref = (r: InterviewRow): ActivityRef => ({
  recruiterId: r.recruiter_id,
  teamId: r.team_id,
  locationId: r.location_id,
  candidate: { recruiterId: r.c_recruiter, teamId: r.c_team, locationId: r.c_location, visibility: "team", marketingStatus: "" },
});

/** Which interview fields the caller may change on this row (mirrors eureka.interview_guard). */
export function editableFields(access: UserAccess, r: Pick<ActivityRef, "recruiterId" | "teamId" | "locationId">): Set<InterviewField> {
  const out = new Set<InterviewField>();
  if (ownsActivity(resolveScopeFor(access, "interview:update", SALES_SCOPES), r)) SALES_FIELDS.forEach((f) => out.add(f));
  const loc = resolveScopeFor(access, "interview:update", ["location"]);
  if (loc && r.locationId !== null && loc.locationIds.has(r.locationId)) LOCATION_FIELDS.forEach((f) => out.add(f));
  return out;
}

/** Feedback kinds the caller may add (mirrors authz.feedback_kind_allowed). */
export function feedbackKinds(access: UserAccess, a: ActivityRef): FeedbackKind[] {
  return (Object.keys(FEEDBACK_SCOPES) as FeedbackKind[]).filter((k) =>
    activityVisible(resolveScopeFor(access, "interview.feedback:create", FEEDBACK_SCOPES[k]), a));
}

@Injectable()
export class InterviewsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  /** Minimal staff directory for the scheduling picker; no email or role metadata. */
  async coaches(user: AuthedUser) {
    return this.db.withUser(user.id, async (c) => ({
      items: (await c.query<{ id: string; name: string }>(
        `SELECT DISTINCT u.id, u.display_name AS name
         FROM eureka.app_user u JOIN eureka.user_role ur ON ur.user_id = u.id
         WHERE u.status = 'active' AND ur.role_key = 'interview_coach' AND ur.valid @> now()
         ORDER BY name, u.id`,
      )).rows,
    }));
  }

  /** A coach must be an active user holding the interview_coach role. */
  private async assertCoach(c: pg.PoolClient, coachId: string) {
    const { rowCount } = await c.query(
      `SELECT 1 FROM eureka.user_role ur JOIN eureka.app_user u ON u.id = ur.user_id
       WHERE ur.user_id = $1 AND ur.role_key = 'interview_coach' AND ur.valid @> now() AND u.status = 'active'`, [coachId]);
    if (!rowCount) throw new UnprocessableEntityException("invalid_coach");
  }

  present(access: UserAccess, r: InterviewRow) {
    return {
      id: r.id,
      submissionId: r.submission_id,
      candidate: { id: r.candidate_id, name: r.candidate_name },
      recruiter: { id: r.recruiter_id, name: r.recruiter_name },
      team: r.team_id ? { id: r.team_id, name: r.team_name } : null,
      location: r.location_id ? { id: r.location_id, name: r.location_name } : null,
      client: r.client_id ? { id: r.client_id, name: r.client_name } : null,
      round: r.round,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      coach: r.coach_id ? { id: r.coach_id, name: r.coach_name } : null,
      inviteReceived: r.invite_received,
      callStatus: r.call_status,
      cleared: r.cleared,
      clearedAt: r.cleared_at,
      consentCaptured: r.consent_captured,
      otterUrl: r.otter_url,
      recordingUrl: r.recording_url,
      systemName: r.system_name,
      updatedAt: r.updated_at,
      /** Presentation hint for the board; the server re-checks on write. */
      editableFields: [...editableFields(access, ref(r))].sort(),
      feedbackKinds: feedbackKinds(access, ref(r)),
    };
  }

  async list(user: AuthedUser, q: InterviewListQuery) {
    const scope = resolveScope(user.access, "interview:read");
    if (!scope) throw new ForbiddenException();
    const params: unknown[] = [];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const where = [activityPredicate(scope, params, "i", "c")];
    if (q.from) where.push(`i.starts_at >= ${p(q.from)}::timestamptz`);
    if (q.to) where.push(`i.starts_at < ${p(q.to)}::timestamptz`);
    if (q.status) where.push(`i.call_status = ${p(q.status)}`);
    if (q.teamId) where.push(`i.team_id = ${p(q.teamId)}`);
    if (q.locationId) where.push(`i.location_id = ${p(q.locationId)}`);
    if (q.candidateId) where.push(`i.candidate_id = ${p(q.candidateId)}`);
    if (q.clientId) where.push(`i.client_id = ${p(q.clientId)}`);
    if (q.submissionId) where.push(`i.submission_id = ${p(q.submissionId)}`);
    if (q.cleared !== undefined) where.push(`i.cleared = ${p(q.cleared)}`);
    if (q.cursor) {
      const [k, id] = splitCursor(q.cursor);
      where.push(`(i.starts_at, i.id) > (${fromMicros(p(k))}, ${p(id)}::uuid)`);
    }
    const sql = `${SELECT} WHERE ${where.join(" AND ")} ORDER BY i.starts_at, i.id LIMIT ${p(q.limit + 1)}`;
    const rows = await this.db.withUser(user.id, async (c) => (await c.query<InterviewRow>(sql, params)).rows);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => this.present(user.access, r)),
      nextCursor: rows.length > q.limit && last ? `${last.k}.${last.id}` : null,
    };
  }

  private async load(c: pg.PoolClient, user: AuthedUser, id: string): Promise<InterviewRow> {
    const scope = resolveScope(user.access, "interview:read");
    if (!scope) throw new NotFoundException();
    const params: unknown[] = [id];
    const { rows } = await c.query<InterviewRow>(`${SELECT} WHERE i.id = $1 AND ${activityPredicate(scope, params, "i", "c")}`, params);
    if (!rows[0]) throw new NotFoundException();
    return rows[0];
  }

  async get(user: AuthedUser, id: string) {
    return this.present(user.access, await this.db.withUser(user.id, (c) => this.load(c, user, id)));
  }

  /** Authorized against the parent submission (design B4.8): the caller must be able to update it. */
  async create(user: AuthedUser, body: CreateInterview) {
    return this.db.withUser(user.id, async (c) => {
      const readScope = resolveScope(user.access, "submission:read");
      if (!readScope) throw new NotFoundException();
      const params: unknown[] = [body.submissionId];
      const { rows } = await c.query<{ recruiter_id: string; team_id: string | null; location_id: string | null; status: string }>(
        `SELECT s.recruiter_id, s.team_id, s.location_id, s.status FROM eureka.submission s
         LEFT JOIN eureka.candidate c ON c.id = s.candidate_id
         WHERE s.id = $1 AND ${activityPredicate(readScope, params)}`, params);
      const sub = rows[0];
      if (!sub) throw new NotFoundException();
      if (!ownsActivity(resolveScope(user.access, "submission:update"),
        { recruiterId: sub.recruiter_id, teamId: sub.team_id, locationId: sub.location_id })) {
        throw new ForbiddenException("Not permitted");
      }
      if (TERMINAL_SUBMISSION_STATUSES.has(sub.status as never)) throw new UnprocessableEntityException("submission_closed");
      if (body.coachId) await this.assertCoach(c, body.coachId);
      let id: string;
      try {
        const ins = await c.query<{ id: string }>(
          `INSERT INTO eureka.interview (submission_id, round, starts_at, ends_at, coach_id, invite_received)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [body.submissionId, body.round, body.startsAt, body.endsAt, body.coachId ?? null, body.inviteReceived ?? false]);
        id = ins.rows[0]!.id;
      } catch (err) {
        mapPipelineError(err);
      }
      await this.audit.record(c, {
        actorId: user.id, action: "interview.created", entityType: "interview", entityId: id,
        changes: { submissionId: body.submissionId, round: body.round, startsAt: body.startsAt, endsAt: body.endsAt },
      });
      return { id };
    });
  }

  async update(user: AuthedUser, id: string, body: UpdateInterview) {
    return this.db.withUser(user.id, async (c) => {
      const row = await this.load(c, user, id);
      const allowed = editableFields(user.access, ref(row));
      if (allowed.size === 0) throw new ForbiddenException("Not permitted");
      const fields = Object.keys(body) as InterviewField[];
      const denied = fields.filter((f) => !allowed.has(f));
      if (denied.length) throw new UnprocessableEntityException(`field_not_permitted: ${denied.sort().join(", ")}`);

      // AS-12: recording links need consent (the database checks this too).
      const consent = body.consentCaptured ?? row.consent_captured;
      const otter = body.otterUrl !== undefined ? body.otterUrl : row.otter_url;
      const recording = body.recordingUrl !== undefined ? body.recordingUrl : row.recording_url;
      if (!consent && (otter !== null || recording !== null)) throw new UnprocessableEntityException("consent_required");
      const timeProblem = interviewTimesProblem(body.startsAt ?? row.starts_at.toISOString(), body.endsAt ?? row.ends_at.toISOString());
      if (timeProblem) throw new UnprocessableEntityException(timeProblem);
      if (body.coachId) await this.assertCoach(c, body.coachId);

      const params: unknown[] = [id];
      const sets = fields.map((f) => { params.push(body[f]); return `${COLUMN[f]} = $${params.length}`; });
      let updated = 0;
      try {
        updated = (await c.query(`UPDATE eureka.interview SET ${sets.join(", ")} WHERE id = $1`, params)).rowCount ?? 0;
      } catch (err) {
        mapPipelineError(err);
      }
      if (updated !== 1) throw new ForbiddenException("Not permitted"); // RLS refused the row
      // Recording/Otter links are shareable secrets: audit that they changed, not their value.
      const changes: Record<string, unknown> = { ...body };
      for (const k of ["otterUrl", "recordingUrl"] as const) {
        if (k in body) changes[k] = body[k] === null ? "cleared" : "set";
      }
      await this.audit.record(c, { actorId: user.id, action: "interview.updated", entityType: "interview", entityId: id, changes });
      return this.present(user.access, await this.load(c, user, id));
    });
  }

  async addFeedback(user: AuthedUser, id: string, body: CreateFeedback) {
    return this.db.withUser(user.id, async (c) => {
      const row = await this.load(c, user, id);
      const kinds = feedbackKinds(user.access, ref(row));
      if (kinds.length === 0) throw new ForbiddenException("Not permitted");
      let kind: FeedbackKind;
      if (body.kind) {
        if (!kinds.includes(body.kind)) throw new UnprocessableEntityException("kind_not_permitted");
        kind = body.kind;
      } else if (kinds.length === 1) {
        kind = kinds[0]!;
      } else {
        throw new UnprocessableEntityException("kind_required");
      }
      const ins = await c.query<{ id: string; created_at: Date }>(
        `INSERT INTO eureka.interview_feedback (interview_id, author_id, kind, rating, notes)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
        [id, user.id, kind, body.rating ?? null, body.notes ?? null]);
      // Notes are free text about a person; the audit keeps only the facts.
      await this.audit.record(c, {
        actorId: user.id, action: "interview.feedback.created", entityType: "interview_feedback", entityId: ins.rows[0]!.id,
        changes: { interviewId: id, kind, rating: body.rating ?? null },
      });
      return { id: ins.rows[0]!.id, interviewId: id, kind, rating: body.rating ?? null, notes: body.notes ?? null, createdAt: ins.rows[0]!.created_at };
    });
  }

  async listFeedback(user: AuthedUser, id: string) {
    return this.db.withUser(user.id, async (c) => {
      await this.load(c, user, id);
      const { rows } = await c.query<{ id: string; kind: string; rating: number | null; notes: string | null;
        created_at: Date; author_id: string | null; author_name: string | null; format: string | null; topics: string[] | null; difficult_questions: string | null; duration_min: number | null; next_step: string | null }>(
        `SELECT f.id, f.kind, f.rating, f.notes, f.created_at, f.author_id, u.display_name AS author_name, f.format, f.topics, f.difficult_questions, f.duration_min, f.next_step
         FROM eureka.interview_feedback f LEFT JOIN eureka.app_user u ON u.id = f.author_id
         WHERE f.interview_id = $1 ORDER BY f.created_at, f.id`, [id]);
      return {
        items: rows.map((r) => ({
          id: r.id, kind: r.kind, rating: r.rating, notes: r.notes, createdAt: r.created_at,
          format: r.format, topics: r.topics, difficultQuestions: r.difficult_questions, durationMin: r.duration_min, nextStep: r.next_step,
          author: r.author_id ? { id: r.author_id, name: r.author_name } : null,
        })),
      };
    });
  }
}
