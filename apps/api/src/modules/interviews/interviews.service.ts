import { ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import type pg from "pg";
import {
  activityVisible,
  ownsActivity,
  resolveScope,
  resolveScopeFor,
  submissionTransitionTargets,
  type ActivityRef,
  type EffectiveScope,
  type Scope,
  type UserAccess,
} from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { inPickerScope, pickerScopePerm } from "../../platform/people-scope.js";
import { likeContains, nameSearch, trigramUsable } from "../../platform/sql.js";
import { activityPredicate } from "../submissions/submissions.service.js";
import { TERMINAL_SUBMISSION_STATUSES, fromMicros, mapPipelineError, splitCursor, toMicros } from "../submissions/pipeline.js";
import { interviewTimesProblem } from "../submissions/pipeline.js";
import { SCORECARD_KINDS } from "@eureka/shared";
import { interviewIcs } from "./interviews.ics.js";
import {
  COLUMN,
  LOCATION_FIELDS,
  SALES_FIELDS,
  endFromDuration,
  type InterviewColumnField,
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
  result: string;
  result_at: Date | null;
  submission_status: string | null;
  placement_id: string | null;
  placement_status: string | null;
  otter_url: string | null;
  recording_url: string | null;
  consent_captured: boolean;
  system_name: string | null;
  interview_type: string | null;
  meeting_url: string | null;
  job_title: string | null;
  cf_rating: number | null;
  cf_notes: string | null;
  cf_at: Date | null;
  updated_at: Date;
  row_version: number;
  k: string;
  c_recruiter: string | null;
  c_team: string | null;
  c_location: string | null;
}

/** The name the board shows: an org-wide reader whose candidate join came back empty (RLS) still gets it (0141). */
const CANDIDATE_NAME = `CASE WHEN p.id IS NOT NULL THEN p.first_name || ' ' || p.last_name
              ELSE authz.interview_candidate_name(i.id) END`;

/**
 * Candidate-name match for the board filters (E-09), the same rows as `(CANDIDATE_NAME) ILIKE pat`
 * without a definer call per row. authz.interview_name_candidate_ids (db/functions/authz) returns,
 * once per statement (InitPlan, rule 3), the candidates whose board name the caller sees and that
 * match: readable candidates (person_read), plus for an org interview reader every interviewed
 * candidate, which is exactly when authz.interview_candidate_name answers. Where the person row is
 * visible its own name decides (the ILIKE, as before); where it is not, the set decides, as
 * interview_candidate_name would have, with a hash probe instead of a definer call.
 * `indexed` (a top-level AND term whose `term` has a full trigram) adds `= ANY (set)`, so the set
 * becomes an index condition on interview_candidate_time and the board starts from the matching
 * candidates; a short term or the OR with the coach name keeps the ordered walk with LIMIT, where
 * the cheap per-row test matters (perf-baseline.md "R-13b").
 */
export const candidateNameMatch = (pat: string, term: string, indexed: boolean) => {
  const set = `(SELECT authz.interview_name_candidate_ids(${pat}::text))`;
  if (indexed && trigramUsable(term)) return `(i.candidate_id = ANY (${set}::uuid[]) AND (p.id IS NULL OR ${nameSearch("p", pat)}))`;
  return `(CASE WHEN p.id IS NOT NULL THEN ${nameSearch("p", pat)} ELSE i.candidate_id IN (SELECT pg_catalog.unnest(${set})) END)`;
};

const SELECT = `
  SELECT i.id, i.submission_id, i.candidate_id, i.recruiter_id, i.team_id, i.location_id, i.client_id,
         i.round, i.starts_at, i.ends_at, i.coach_id, i.invite_received, i.call_status, i.cleared, i.cleared_at,
         i.result, i.result_at, sub.status AS submission_status, pl.id AS placement_id, pl.status AS placement_status,
         i.otter_url, i.recording_url, i.consent_captured, i.system_name, i.interview_type, i.meeting_url,
         i.updated_at, i.row_version, ${toMicros("i.starts_at")} AS k,
         ${CANDIDATE_NAME} AS candidate_name,
         ru.display_name AS recruiter_name, cu.display_name AS coach_name,
         tm.name AS team_name, l.name AS location_name, cl.name AS client_name,
         c.recruiter_id AS c_recruiter, c.team_id AS c_team, c.location_id AS c_location,
         sub.job_title, cf.rating AS cf_rating, cf.notes AS cf_notes, cf.created_at AS cf_at
  FROM eureka.interview i
  LEFT JOIN eureka.submission sub ON sub.id = i.submission_id
  LEFT JOIN eureka.candidate c ON c.id = i.candidate_id
  LEFT JOIN eureka.person p ON p.id = c.person_id
  LEFT JOIN eureka.app_user ru ON ru.id = i.recruiter_id
  LEFT JOIN eureka.app_user cu ON cu.id = i.coach_id
  LEFT JOIN eureka.team tm ON tm.id = i.team_id
  LEFT JOIN eureka.location l ON l.id = i.location_id
  LEFT JOIN eureka.client cl ON cl.id = i.client_id
  LEFT JOIN LATERAL (
    SELECT f.rating, f.notes, f.created_at FROM eureka.interview_feedback f
    WHERE f.interview_id = i.id AND f.kind = 'candidate' ORDER BY f.created_at DESC, f.id DESC LIMIT 1
  ) cf ON true
  LEFT JOIN LATERAL (
    SELECT x.id, x.status FROM eureka.placement x
    WHERE x.submission_id = i.submission_id ORDER BY x.created_at DESC, x.id DESC LIMIT 1
  ) pl ON true`;

/** Call statuses that book nobody (as the candidate overlap constraint, 0017). */
const NOT_LIVE: ReadonlySet<string> = new Set(["cancelled", "rescheduled", "no_invite"]);

const SALES_SCOPES: readonly Scope[] = ["own", "team", "hierarchy", "org"];
const FEEDBACK_SCOPES: Record<FeedbackKind, readonly Scope[]> = {
  coach: ["coached", "coached_hierarchy"],
  location: ["location"],
  client: SALES_SCOPES,
};

const ref = (r: InterviewRow): ActivityRef => ({
  recruiterId: r.recruiter_id,
  teamId: r.team_id,
  locationId: r.location_id,
  candidate: { recruiterId: r.c_recruiter, teamId: r.c_team, locationId: r.c_location, visibility: "team", marketingStatus: "" },
  coachId: r.coach_id,
});

/** Who reads an interview: the activity rule, plus the coach assigned to it (mirrors interview_read, 0570). */
function interviewPredicate(scope: EffectiveScope, params: unknown[]): string {
  const activity = activityPredicate(scope, params, "i", "c");
  if (scope.coachIds.size === 0) return activity;
  params.push([...scope.coachIds]);
  return `(${activity} OR i.coach_id = ANY($${params.length}::uuid[]))`;
}

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
      /** The submission's job title; null when the caller cannot read the submission (e.g. coaches). */
      position: r.job_title,
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
      /** Outcome of the round (0360); `cleared` above is the location's pre-call readiness. */
      result: r.result,
      resultAt: r.result_at,
      /** null when the caller cannot read the submission / placement. */
      submissionStatus: r.submission_status,
      placement: r.placement_id ? { id: r.placement_id, status: r.placement_status } : null,
      consentCaptured: r.consent_captured,
      otterUrl: r.otter_url,
      recordingUrl: r.recording_url,
      systemName: r.system_name,
      interviewType: r.interview_type,
      /** IS-3: only readers of the interview get here (RLS + scope predicate). */
      meetingUrl: r.meeting_url,
      durationMin: Math.round((r.ends_at.getTime() - r.starts_at.getTime()) / 60_000),
      /**
       * Latest feedback the candidate sent through the feedback email (kind
       * 'candidate'); readable wherever the interview is (feedback_read).
       */
      candidateFeedback: r.cf_at === null ? null : { rating: r.cf_rating, notes: r.cf_notes, submittedAt: r.cf_at },
      updatedAt: r.updated_at,
      /** Optimistic concurrency (IS-12): send it back as `If-Match` on PATCH / clear-and-select. */
      rowVersion: r.row_version,
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
    const where = [interviewPredicate(scope, params)];
    if (q.from) where.push(`i.starts_at >= ${p(q.from)}::timestamptz`);
    if (q.to) where.push(`i.starts_at < ${p(q.to)}::timestamptz`);
    if (q.status) where.push(`i.call_status = ${p(q.status)}`);
    if (q.teamId) where.push(`i.team_id = ${p(q.teamId)}`);
    if (q.locationId) where.push(`i.location_id = ${p(q.locationId)}`);
    if (q.candidateId) where.push(`i.candidate_id = ${p(q.candidateId)}`);
    if (q.candidate) where.push(candidateNameMatch(p(likeContains(q.candidate)), q.candidate, true));
    if (q.batchId) where.push(`c.batch_id = ${p(q.batchId)}::uuid`);
    if (q.clientId) where.push(`i.client_id = ${p(q.clientId)}`);
    if (q.submissionId) where.push(`i.submission_id = ${p(q.submissionId)}`);
    if (q.cleared !== undefined) where.push(`i.cleared = ${p(q.cleared)}`);
    if (q.result) where.push(`i.result = ${p(q.result)}`);
    if (q.search) {
      const pat = p(likeContains(q.search));
      where.push(`(${candidateNameMatch(pat, q.search, false)} OR cu.display_name ILIKE ${pat} ESCAPE '\\')`);
    }
    const desc = q.sort === "desc";
    if (q.cursor) {
      const [k, id] = splitCursor(q.cursor);
      where.push(`(i.starts_at, i.id) ${desc ? "<" : ">"} (${fromMicros(p(k))}, ${p(id)}::uuid)`);
    }
    const order = desc ? "i.starts_at DESC, i.id DESC" : "i.starts_at, i.id";
    const sql = `${SELECT} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ${p(q.limit + 1)}`;
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
    const { rows } = await c.query<InterviewRow>(`${SELECT} WHERE i.id = $1 AND ${interviewPredicate(scope, params)}`, params);
    if (!rows[0]) throw new NotFoundException();
    return rows[0];
  }

  async get(user: AuthedUser, id: string) {
    return this.db.withUser(user.id, async (c) => {
      const row = await this.load(c, user, id);
      return { ...this.present(user.access, row), ...(await this.panel(c, id)) };
    });
  }

  /** Panel members (IS-4), readable wherever the interview is (panelist_read). Names only, no emails. */
  private async panel(c: pg.PoolClient, id: string) {
    const { rows } = await c.query<{ id: string; name: string; is_lead: boolean }>(
      `SELECT u.id, u.display_name AS name, p.is_lead FROM eureka.interview_panelist p
       JOIN eureka.app_user u ON u.id = p.user_id WHERE p.interview_id = $1 ORDER BY p.is_lead DESC, u.display_name, u.id`, [id]);
    const lead = rows.find((r) => r.is_lead);
    return {
      panel: rows.map((r) => ({ id: r.id, name: r.name, lead: r.is_lead })),
      lead: lead ? { id: lead.id, name: lead.name } : null,
    };
  }

  /**
   * Active staff for the panel and lead pickers (IS-4): names only, like the coach picker.
   * Sales callers with a team/hierarchy grant see the sales people in their scope plus all
   * non-sales staff (coaches, trainers, support); org and location grants see everyone.
   */
  async panelOptions(user: AuthedUser) {
    const perm = pickerScopePerm(user.access, "interview:create");
    const params: unknown[] = [];
    const where = perm
      ? `AND (${inPickerScope("u.id", perm, params)} OR NOT EXISTS (SELECT 1 FROM eureka.user_role ur
           JOIN eureka.role r ON r.key = ur.role_key WHERE ur.user_id = u.id AND r.is_sales AND ur.valid @> now()))`
      : "";
    return this.db.withUser(user.id, async (c) => ({
      items: (await c.query<{ id: string; name: string }>(
        `SELECT u.id, u.display_name AS name FROM eureka.app_user u WHERE u.status = 'active' ${where}
         ORDER BY name, u.id LIMIT 500`, params,
      )).rows,
    }));
  }

  private async setPanel(c: pg.PoolClient, id: string, members: string[], lead: string | null) {
    try {
      await c.query("SELECT authz.set_interview_panel($1, $2::uuid[], $3)", [id, members, lead]);
    } catch (err) {
      mapPipelineError(err);
    }
  }

  /**
   * IS-13: the coach and panel members in `users` must not be booked (as coach or
   * panel member) into another live interview overlapping this one. Checked in the
   * database under per-person advisory locks, after this interview's row and panel
   * are written; 409 interviewer_conflict (the other interview is not named).
   */
  private async assertStaffFree(c: pg.PoolClient, id: string, users: (string | null | undefined)[]) {
    const ids = [...new Set(users.filter((u): u is string => typeof u === "string"))];
    if (!ids.length) return;
    try {
      await c.query("SELECT authz.assert_interview_staff_free($1, $2::uuid[])", [id, ids]);
    } catch (err) {
      if ((err as { message?: string }).message === "interviewer_conflict") throw new ConflictException("interviewer_conflict");
      mapPipelineError(err);
    }
  }

  /**
   * E-04: serialises writes that decide on the round results of one submission
   * (a result change here, clear-and-select) so the "no rejected round" check
   * and the write cannot interleave. Taken before the interview row lock, in
   * this order everywhere.
   */
  private async lockSubmissionResults(c: pg.PoolClient, id: string) {
    await c.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('interview_result:' || i.submission_id::text, 0))
         FROM eureka.interview i WHERE i.id = $1`, [id]);
  }

  /** Row lock for the update (empty when RLS lets the caller read but not update the row). */
  private async lockRow(c: pg.PoolClient, id: string): Promise<boolean> {
    return ((await c.query(`SELECT 1 FROM eureka.interview WHERE id = $1 FOR NO KEY UPDATE`, [id])).rowCount ?? 0) > 0;
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
      const endsAt = body.endsAt ?? endFromDuration(body.startsAt, body.durationMin!);
      let id: string;
      try {
        const ins = await c.query<{ id: string }>(
          `INSERT INTO eureka.interview (submission_id, round, starts_at, ends_at, coach_id, invite_received, interview_type, meeting_url)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [body.submissionId, body.round, body.startsAt, endsAt, body.coachId ?? null, body.inviteReceived ?? false,
            body.interviewType ?? null, body.meetingUrl ?? null]);
        id = ins.rows[0]!.id;
      } catch (err) {
        mapPipelineError(err);
      }
      if (body.panelIds?.length) await this.setPanel(c, id, body.panelIds, body.leadId ?? null);
      await this.assertStaffFree(c, id, [body.coachId, ...(body.panelIds ?? [])]);
      // IS-8: the meeting link is a shareable secret: audited as present, never its value.
      // Rule 5: the round name is free text; the audit records that it was set, not what it says.
      await this.audit.record(c, {
        actorId: user.id, action: "interview.created", entityType: "interview", entityId: id,
        changes: {
          submissionId: body.submissionId, round: "set", startsAt: body.startsAt, endsAt,
          interviewType: body.interviewType ?? null, meetingUrl: body.meetingUrl ? "set" : null,
          panelSize: body.panelIds?.length ?? 0, leadId: body.leadId ?? null,
        },
      });
      return { id };
    });
  }

  /**
   * PATCH. `expected` is the optional If-Match rowVersion (IS-12): when sent and
   * stale, 412 and nothing changes. The row is locked before it is read, so the
   * consent, duration and panel decisions use the values the write replaces.
   */
  async update(user: AuthedUser, id: string, body: UpdateInterview, expected: number | null = null) {
    return this.db.withUser(user.id, async (c) => {
      if (body.result !== undefined) await this.lockSubmissionResults(c, id);
      const locked = await this.lockRow(c, id);
      const row = await this.load(c, user, id);
      const allowed = editableFields(user.access, ref(row));
      if (allowed.size === 0 || !locked) throw new ForbiddenException("Not permitted");
      const fields = Object.keys(body) as InterviewField[];
      const denied = fields.filter((f) => !allowed.has(f));
      if (denied.length) throw new UnprocessableEntityException(`field_not_permitted: ${denied.sort().join(", ")}`);
      if (expected !== null && expected !== row.row_version) throw new HttpException("stale", HttpStatus.PRECONDITION_FAILED);

      const { durationMin, panelIds, leadId, ...columns } = body;
      if (durationMin !== undefined) {
        columns.endsAt = endFromDuration(columns.startsAt ?? row.starts_at.toISOString(), durationMin);
      }

      // AS-12: recording links need consent (the database checks this too).
      const consent = columns.consentCaptured ?? row.consent_captured;
      const otter = columns.otterUrl !== undefined ? columns.otterUrl : row.otter_url;
      const recording = columns.recordingUrl !== undefined ? columns.recordingUrl : row.recording_url;
      if (!consent && (otter !== null || recording !== null)) throw new UnprocessableEntityException("consent_required");
      const timeProblem = interviewTimesProblem(columns.startsAt ?? row.starts_at.toISOString(), columns.endsAt ?? row.ends_at.toISOString());
      if (timeProblem) throw new UnprocessableEntityException(timeProblem);
      if (columns.coachId) await this.assertCoach(c, columns.coachId);

      const before = await this.panel(c, id);
      const currentPanel = before.panel.map((m) => m.id);
      const colFields = Object.keys(columns) as InterviewColumnField[];
      const params: unknown[] = [id];
      const sets = colFields.map((f) => { params.push(columns[f]); return `${COLUMN[f]} = $${params.length}`; });
      // A panel-only change still bumps the version (the guard does that on every update).
      if (!sets.length && panelIds !== undefined) sets.push("round = round");
      if (sets.length) {
        let where = "id = $1";
        if (expected !== null) { params.push(expected); where += ` AND row_version = $${params.length}`; }
        let updated = 0;
        try {
          updated = (await c.query(`UPDATE eureka.interview SET ${sets.join(", ")} WHERE ${where}`, params)).rowCount ?? 0;
        } catch (err) {
          mapPipelineError(err);
        }
        if (updated !== 1) throw new ForbiddenException("Not permitted"); // RLS refused the row (the version was checked under the lock)
      }
      let lead: string | null | undefined = leadId;
      if (panelIds !== undefined) {
        if (lead === undefined) {
          // Keep the current lead while they stay on the panel.
          const cur = before.lead?.id ?? null;
          lead = cur !== null && panelIds.includes(cur) ? cur : null;
        }
        await this.setPanel(c, id, panelIds, lead);
      }
      // IS-13: whose booking changed. A new slot (or a call brought back from
      // cancelled) books the coach and the whole panel again; otherwise only a
      // new coach and newly added panel members are checked.
      const revived = columns.callStatus !== undefined && NOT_LIVE.has(row.call_status) && !NOT_LIVE.has(columns.callStatus);
      const moved = columns.startsAt !== undefined || columns.endsAt !== undefined;
      const coach = columns.coachId !== undefined ? columns.coachId : row.coach_id;
      await this.assertStaffFree(c, id, moved || revived
        ? [coach, ...(panelIds ?? currentPanel)]
        : [columns.coachId !== undefined && columns.coachId !== row.coach_id ? columns.coachId : null,
          ...(panelIds ?? []).filter((m) => !currentPanel.includes(m))]);

      // Recording, Otter and meeting links are shareable secrets: audit that they changed, not their value.
      // Rule 5: the round and the location's system name are free text: audited as changed, never their value.
      const changes: Record<string, unknown> = { ...columns };
      for (const k of ["otterUrl", "recordingUrl", "meetingUrl", "systemName"] as const) {
        if (k in columns) changes[k] = columns[k] === null ? "cleared" : "set";
      }
      if ("round" in columns) changes.round = "changed";
      if (durationMin !== undefined) changes.durationMin = durationMin;
      if (panelIds !== undefined) { changes.panelSize = panelIds.length; changes.leadId = lead ?? null; }
      await this.audit.record(c, { actorId: user.id, action: "interview.updated", entityType: "interview", entityId: id, changes });
      return { ...this.present(user.access, await this.load(c, user, id)), ...(await this.panel(c, id)) };
    });
  }

  /**
   * IS-11 "Clear and place": marks this round cleared and moves its submission
   * forward, one step at a time through authz.transition_submission, to
   * selected, in one transaction. The placement itself is created next with
   * POST /placements. Refused when another visible round was rejected. The
   * submission's round results are locked first (E-04), so a sibling round
   * rejected concurrently is seen. Optional If-Match as on PATCH (IS-12).
   */
  async clearAndSelect(user: AuthedUser, id: string, expected: number | null = null) {
    return this.db.withUser(user.id, async (c) => {
      await this.lockSubmissionResults(c, id);
      const locked = await this.lockRow(c, id);
      const row = await this.load(c, user, id);
      if (!locked || !editableFields(user.access, ref(row)).has("result")
          || !ownsActivity(resolveScope(user.access, "submission:update"), ref(row))) {
        throw new ForbiddenException("Not permitted");
      }
      if (expected !== null && expected !== row.row_version) throw new HttpException("stale", HttpStatus.PRECONDITION_FAILED);
      if (row.call_status === "cancelled" || row.call_status === "no_invite") throw new UnprocessableEntityException("interview_not_held");
      const sub = await c.query<{ status: string }>(`SELECT status FROM eureka.submission WHERE id = $1`, [row.submission_id]);
      const from = sub.rows[0]?.status;
      if (from === undefined) throw new NotFoundException();
      if (from !== "selected" && !submissionTransitionTargets(from).length) throw new UnprocessableEntityException("submission_closed");
      const rejected = await c.query(
        `SELECT 1 FROM eureka.interview WHERE submission_id = $1 AND id <> $2 AND result = 'rejected' LIMIT 1`, [row.submission_id, id]);
      if (rejected.rowCount) throw new UnprocessableEntityException("round_rejected");

      const sets = ["result = 'cleared'"];
      if (row.call_status !== "completed") sets.push("call_status = 'completed'");
      let updated = 0;
      let rowVersion = row.row_version;
      try {
        if (row.result !== "cleared" || row.call_status !== "completed") {
          const u = await c.query<{ row_version: number }>(
            `UPDATE eureka.interview SET ${sets.join(", ")} WHERE id = $1 RETURNING row_version`, [id]);
          updated = u.rowCount ?? 0;
          if (updated !== 1) throw new ForbiddenException("Not permitted");
          rowVersion = u.rows[0]!.row_version;
        }
        let status = from;
        while (status !== "selected") {
          const next = submissionTransitionTargets(status).find((t) => t !== "rejected" && t !== "withdrawn")!;
          status = (await c.query<{ s: string }>(`SELECT authz.transition_submission($1, $2, NULL) AS s`, [row.submission_id, next])).rows[0]!.s;
        }
      } catch (err) {
        mapPipelineError(err);
      }
      if (updated) {
        await this.audit.record(c, { actorId: user.id, action: "interview.updated", entityType: "interview", entityId: id,
          changes: { result: "cleared", ...(sets.length > 1 ? { callStatus: "completed" } : {}) } });
      }
      if (from !== "selected") {
        await this.audit.record(c, { actorId: user.id, action: "submission.status", entityType: "submission", entityId: row.submission_id,
          changes: { from, to: "selected", viaInterview: id } });
      }
      return { interviewId: id, result: "cleared", submissionId: row.submission_id, submissionStatus: "selected", rowVersion };
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
      // IS-6: scorecards go with coach and client feedback only (the database checks too).
      if (body.scorecard && !(SCORECARD_KINDS as readonly string[]).includes(kind)) {
        throw new UnprocessableEntityException("scorecard_not_allowed");
      }
      const s = body.scorecard;
      const ins = await c.query<{ id: string; created_at: Date }>(
        `INSERT INTO eureka.interview_feedback (interview_id, author_id, kind, rating, notes,
           technical_skills, communication, problem_solving, attitude)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, created_at`,
        [id, user.id, kind, body.rating ?? null, body.notes ?? null,
          s?.technicalSkills ?? null, s?.communication ?? null, s?.problemSolving ?? null, s?.attitude ?? null]);
      // Notes are free text about a person; the audit keeps only the facts (scores are numbers).
      await this.audit.record(c, {
        actorId: user.id, action: "interview.feedback.created", entityType: "interview_feedback", entityId: ins.rows[0]!.id,
        changes: { interviewId: id, kind, rating: body.rating ?? null, ...(s ? { scorecard: s } : {}) },
      });
      return {
        id: ins.rows[0]!.id, interviewId: id, kind, rating: body.rating ?? null, notes: body.notes ?? null,
        scorecard: s ?? null, createdAt: ins.rows[0]!.created_at,
      };
    });
  }

  async listFeedback(user: AuthedUser, id: string) {
    return this.db.withUser(user.id, async (c) => {
      const row = await this.load(c, user, id);
      const { rows } = await c.query<{ id: string; kind: string; rating: number | null; notes: string | null;
        created_at: Date; author_id: string | null; author_name: string | null; format: string | null; topics: string[] | null;
        difficult_questions: string | null; duration_min: number | null; next_step: string | null;
        technical_skills: number | null; communication: number | null; problem_solving: number | null; attitude: number | null }>(
        `SELECT f.id, f.kind, f.rating, f.notes, f.created_at, f.author_id, u.display_name AS author_name, f.format, f.topics,
                f.difficult_questions, f.duration_min, f.next_step, f.technical_skills, f.communication, f.problem_solving, f.attitude
         FROM eureka.interview_feedback f LEFT JOIN eureka.app_user u ON u.id = f.author_id
         WHERE f.interview_id = $1 ORDER BY f.created_at, f.id`, [id]);
      return {
        items: rows.map((r) => ({
          id: r.id, kind: r.kind, rating: r.rating, notes: r.notes, createdAt: r.created_at, round: row.round,
          format: r.format, topics: r.topics, difficultQuestions: r.difficult_questions, durationMin: r.duration_min, nextStep: r.next_step,
          scorecard: r.technical_skills === null ? null : {
            technicalSkills: r.technical_skills, communication: r.communication!, problemSolving: r.problem_solving!, attitude: r.attitude!,
          },
          author: r.author_id ? { id: r.author_id, name: r.author_name } : null,
        })),
      };
    });
  }

  /**
   * Calendar file for a scheduled interview (IS-7). Attendees: the panel's
   * work emails only (no candidate, client or recruiter address). Readers of
   * the interview only; the download is audited (ids only).
   */
  async ics(user: AuthedUser, id: string): Promise<string> {
    return this.db.withUser(user.id, async (c) => {
      const row = await this.load(c, user, id);
      if (row.call_status !== "scheduled") throw new UnprocessableEntityException("interview_not_scheduled");
      const panel = (await c.query<{ name: string; email: string; is_lead: boolean }>(
        `SELECT u.display_name AS name, u.email::text AS email, p.is_lead FROM eureka.interview_panelist p
         JOIN eureka.app_user u ON u.id = p.user_id WHERE p.interview_id = $1 AND u.status = 'active'
         ORDER BY p.is_lead DESC, u.display_name, u.id`, [id])).rows;
      await this.audit.record(c, {
        actorId: user.id, action: "interview.calendar_downloaded", entityType: "interview", entityId: id,
        changes: { attendees: panel.length },
      });
      return interviewIcs({
        id: row.id, round: row.round, candidateName: row.candidate_name, startsAt: row.starts_at, endsAt: row.ends_at,
        interviewType: row.interview_type, meetingUrl: row.meeting_url, updatedAt: row.updated_at,
        attendees: panel.map((p) => ({ name: p.name, email: p.email, lead: p.is_lead })),
      });
    });
  }
}
