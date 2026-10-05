import {
  ConflictException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type pg from "pg";
import {
  APPLICATION_STATUS_LABELS, APP_INTERVIEW_LABELS, can, maskPhone, nextApplicationStatuses, resolveScope,
  type ApplicationStatus, type UserAccess,
} from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { CONFIG, type AppConfig } from "../../platform/config.js";
import { DbService } from "../../platform/db.service.js";
import { MAIL_PORT, type MailPort } from "../../platform/mail.js";
import { RateLimiter } from "../../platform/rate-limit.js";
import { CandidatesService } from "../candidates/candidates.service.js";
import { toCsv } from "../hotlist/csv.js";
import { JobsService, JOB_SELECT, type JobRow } from "../jobs/jobs.service.js";
import { fromMicros, splitCursor, toMicros } from "../submissions/pipeline.js";
import type {
  ApplicantListQuery, ApplicationExport, ApplicationListQuery, CreateCandidateFromApplication, ScheduleInterview, Scorecard, StatusChange,
} from "./applications.schemas.js";

/**
 * Applications, applicants and application interviews for staff
 * (docs/jobs-portal-api.md JP-17..JP-30, migration 0062). Reads run under the
 * caller's RLS (HR org-wide; a job's hiring manager; an interview's lead and
 * panel); writes go through the definer functions, which check read (404) and
 * manage (403) again. Applicants get an email on status changes and scheduled
 * interviews (no internal comments), sent after the transaction commits.
 */

export const EXPORT_ROW_CAP = 5000;

interface AppRow {
  id: string; job_id: string; applicant_id: string; status: ApplicationStatus; applied_at: Date; status_changed_at: Date;
  candidate_id: string | null; row_version: number; job_title: string | null; job_kind: string | null; company_id: string | null;
  hiring_manager_id: string | null; first_name: string | null; last_name: string | null; email: string | null; phone_e164: string | null;
  email_verified_at: Date | null; rating: string | null; k: string;
}

const APP_SELECT = `
  SELECT a.id, a.job_id, a.applicant_id, a.status, a.applied_at, a.status_changed_at, a.candidate_id, a.row_version,
         j.title AS job_title, j.kind AS job_kind, j.company_id, j.hiring_manager_id,
         ap.first_name, ap.last_name, ap.email, ap.phone_e164, ap.email_verified_at,
         (SELECT round(avg((s.technical + s.communication + s.problem_solving + s.attitude) / 4.0), 1)::text
            FROM eureka.application_scorecard s JOIN eureka.application_interview i ON i.id = s.interview_id
           WHERE i.application_id = a.id) AS rating,
         ${toMicros("a.applied_at")} AS k
  FROM eureka.job_application a
  LEFT JOIN eureka.job j ON j.id = a.job_id
  LEFT JOIN eureka.applicant ap ON ap.id = a.applicant_id`;

const CODES: Record<string, () => HttpException> = {
  application_not_found: () => new NotFoundException(),
  interview_not_found: () => new NotFoundException(),
  not_permitted: () => new ForbiddenException("Not permitted"),
  stale: () => new HttpException("stale", HttpStatus.PRECONDITION_FAILED),
  invalid_transition: () => new UnprocessableEntityException("invalid_transition"),
  application_closed: () => new UnprocessableEntityException("application_closed"),
  invalid_panel: () => new UnprocessableEntityException("invalid_panel"),
  invalid_interviewer: () => new UnprocessableEntityException("invalid_interviewer"),
  invalid_slot: () => new UnprocessableEntityException("invalid_slot"),
  interview_closed: () => new UnprocessableEntityException("interview_closed"),
  application_not_hired: () => new UnprocessableEntityException("application_not_hired"),
  candidate_exists: () => new ConflictException("candidate_exists"),
  candidate_not_found: () => new UnprocessableEntityException("candidate_not_found"),
};

/** Maps the application functions' coded errors (migration 0062) to problem details with the code in `detail`. */
export function mapApplicationError(err: unknown): never {
  const e = err as { message?: string; code?: string };
  const make = e.message !== undefined && e.code !== undefined ? CODES[e.message] : undefined;
  if (make) throw make();
  throw err;
}

const fullName = (r: { first_name: string | null; last_name: string | null }) =>
  r.first_name !== null ? `${r.first_name} ${r.last_name ?? ""}`.trim() : null;

@Injectable()
export class ApplicationsService {
  private readonly log = new Logger("Applications");
  private readonly exportLimiter = new RateLimiter(10, 10 * 60_000);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly jobs: JobsService,
    private readonly candidates: CandidatesService,
    @Inject(MAIL_PORT) private readonly mail: MailPort,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private manageable(access: UserAccess, r: Pick<AppRow, "hiring_manager_id">) {
    return resolveScope(access, "application:manage")?.all === true || (r.hiring_manager_id !== null && r.hiring_manager_id === access.userId);
  }

  private phone(access: UserAccess, v: string | null) {
    if (v === null) return { phone: null, phoneMasked: false };
    const ok = resolveScope(access, "applicant.phone:read")?.all === true;
    return { phone: ok ? v : maskPhone(v), phoneMasked: !ok };
  }

  present(access: UserAccess, r: AppRow) {
    const manage = this.manageable(access, r);
    const open = !["hired", "rejected", "withdrawn"].includes(r.status);
    return {
      id: r.id,
      status: r.status,
      appliedAt: r.applied_at,
      statusChangedAt: r.status_changed_at,
      rowVersion: r.row_version,
      overallRating: r.rating === null ? null : Number(r.rating),
      job: { id: r.job_id, title: r.job_title, kind: r.job_kind },
      // TODO(jobs-portal): company name from eureka.company at integration.
      company: r.company_id ? { id: r.company_id, name: null } : null,
      applicant: {
        id: r.applicant_id, name: fullName(r), email: r.email, emailVerified: r.email_verified_at !== null, ...this.phone(access, r.phone_e164),
      },
      candidateId: r.candidate_id,
      /** Hints for the UI; the database checks every action again. */
      actions: {
        transition: manage ? nextApplicationStatuses(r.status) : [],
        scheduleInterview: manage && open,
        createCandidate: manage && r.status === "hired" && r.candidate_id === null && can(access, "candidate:create"),
      },
    };
  }

  /** Callers without application:read see what RLS gives them (their jobs, their interviews). */
  async list(user: AuthedUser, q: ApplicationListQuery) {
    const rows = await this.rows(user, q, q.limit + 1, q.cursor);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return { items: page.map((r) => this.present(user.access, r)), nextCursor: rows.length > q.limit && last ? `${last.k}.${last.id}` : null };
  }

  private async rows(user: AuthedUser, q: ApplicationExport, limit: number, cursor?: string, c?: pg.PoolClient): Promise<AppRow[]> {
    const params: unknown[] = [];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const where = ["true"];
    if (q.status) where.push(`a.status = ${p(q.status)}`);
    if (q.jobId) where.push(`a.job_id = ${p(q.jobId)}::uuid`);
    if (q.search) where.push(`(ap.first_name || ' ' || ap.last_name) ILIKE ${p(`%${q.search.replace(/[%_\\]/g, "\\$&")}%`)} ESCAPE '\\'`);
    if (cursor) {
      const [t, id] = splitCursor(cursor);
      where.push(`(a.applied_at, a.id) < (${fromMicros(p(t))}, ${p(id)}::uuid)`);
    }
    const sql = `${APP_SELECT} WHERE ${where.join(" AND ")} ORDER BY a.applied_at DESC, a.id DESC LIMIT ${p(limit)}`;
    if (c) return (await c.query<AppRow>(sql, params)).rows;
    return this.db.withUser(user.id, async (cc) => (await cc.query<AppRow>(sql, params)).rows);
  }

  async exportCsv(user: AuthedUser, q: ApplicationExport) {
    if (!can(user.access, "application:read")) throw new ForbiddenException();
    if (!this.exportLimiter.take(user.id)) throw new HttpException("Too many exports; try again in a few minutes", HttpStatus.TOO_MANY_REQUESTS);
    return this.db.withUser(user.id, async (c) => {
      const rows = await this.rows(user, q, EXPORT_ROW_CAP + 1, undefined, c);
      const page = rows.slice(0, EXPORT_ROW_CAP);
      await this.audit.record(c, { actorId: user.id, action: "application.export", entityType: "job_application",
        changes: { rows: page.length, truncated: rows.length > EXPORT_ROW_CAP, cap: EXPORT_ROW_CAP, status: q.status ?? null, jobId: q.jobId ?? null, search: q.search !== undefined } });
      const csv = toCsv(["Job title", "Applicant", "Email", "Company", "Applied", "Overall rating", "Status"],
        page.map((r) => [r.job_title ?? "", fullName(r) ?? "", r.email ?? "", r.company_id ?? "", r.applied_at.toISOString().slice(0, 10),
          r.rating ?? "", APPLICATION_STATUS_LABELS[r.status]]));
      return { csv, rows: page.length, truncated: rows.length > EXPORT_ROW_CAP };
    });
  }

  private async load(c: pg.PoolClient, id: string): Promise<AppRow> {
    const r = (await c.query<AppRow>(`${APP_SELECT} WHERE a.id = $1`, [id])).rows[0];
    if (!r) throw new NotFoundException();
    return r;
  }

  async get(user: AuthedUser, id: string) {
    return this.db.withUser(user.id, async (c) => {
      const r = await this.load(c, id);
      const job = (await c.query<JobRow>(`${JOB_SELECT} WHERE j.id = $1`, [r.job_id])).rows[0];
      const interviews = (await c.query<{
        id: string; interview_type: string; round: string; lead_user_id: string; lead_name: string | null; starts_at: Date; duration_minutes: number;
        meeting_link: string | null; status: string; panel: { id: string; name: string }[] | null;
      }>(`SELECT i.id, i.interview_type, i.round, i.lead_user_id, lu.display_name AS lead_name, i.starts_at, i.duration_minutes,
                 i.meeting_link, i.status,
                 (SELECT json_agg(json_build_object('id', u.id, 'name', u.display_name) ORDER BY u.display_name)
                    FROM eureka.application_interview_panel p JOIN eureka.app_user u ON u.id = p.user_id WHERE p.interview_id = i.id) AS panel
          FROM eureka.application_interview i LEFT JOIN eureka.app_user lu ON lu.id = i.lead_user_id
          WHERE i.application_id = $1 ORDER BY i.starts_at DESC, i.id`, [id])).rows;
      const cards = (await c.query<{
        id: string; interview_id: string; reviewer_id: string; reviewer_name: string | null; technical: number; communication: number;
        problem_solving: number; attitude: number; notes: string | null; updated_at: Date;
      }>(`SELECT s.id, s.interview_id, s.reviewer_id, u.display_name AS reviewer_name, s.technical, s.communication, s.problem_solving,
                 s.attitude, s.notes, s.updated_at
          FROM eureka.application_scorecard s JOIN eureka.application_interview i ON i.id = s.interview_id
          LEFT JOIN eureka.app_user u ON u.id = s.reviewer_id WHERE i.application_id = $1 ORDER BY s.updated_at`, [id])).rows;
      const history = (await c.query<{ id: string; kind: string; at: Date; actor: string | null; from_status: string | null; to_status: string | null; comment: string | null }>(
        `SELECT e.id::text, e.kind, e.at, u.display_name AS actor, e.from_status, e.to_status, e.comment
         FROM eureka.application_event e LEFT JOIN eureka.app_user u ON u.id = e.actor_id
         WHERE e.application_id = $1 ORDER BY e.id DESC LIMIT 200`, [id])).rows;
      const manage = this.manageable(user.access, r);
      const base = this.present(user.access, r);
      return {
        ...base,
        job: job ? this.jobs.present(user.access, job) : base.job,
        interviews: interviews.map((i) => {
          const reviewer = i.lead_user_id === user.id || (i.panel ?? []).some((x) => x.id === user.id) || manage;
          return {
            id: i.id, interviewType: i.interview_type, round: i.round, lead: { id: i.lead_user_id, name: i.lead_name },
            panel: i.panel ?? [], startsAt: i.starts_at, durationMinutes: i.duration_minutes, meetingLink: i.meeting_link, status: i.status,
            scorecards: cards.filter((s) => s.interview_id === i.id).map((s) => ({
              id: s.id, reviewer: { id: s.reviewer_id, name: s.reviewer_name }, technical: s.technical, communication: s.communication,
              problemSolving: s.problem_solving, attitude: s.attitude, notes: s.notes, updatedAt: s.updated_at,
            })),
            actions: {
              setStatus: manage && i.status === "scheduled",
              scorecard: reviewer && (i.status === "scheduled" || i.status === "completed"),
            },
          };
        }),
        history: history.map((h) => ({ id: h.id, kind: h.kind, at: h.at, actor: h.actor, fromStatus: h.from_status, toStatus: h.to_status, comment: h.comment })),
      };
    });
  }

  /**
   * Fire and forget after commit; the applicant's email never carries staff comments, and greets without
   * the name (typed at sign-up by whoever created the account). Failures log the error class only: provider
   * messages can contain the recipient address.
   */
  private notifyApplicant(to: string | null, _first: string | null, subject: string, lines: string[], kind: string) {
    if (!to) return;
    const text = `Hello,\n\n${lines.join("\n")}\n\nSign in to Eureka Careers for the details: ${new URL("/portal/applications", this.config.PUBLIC_BASE_URL).toString()}\n\n— Eureka Careers\n`;
    void this.mail.send({ to, subject, text }).catch((err: unknown) => this.log.warn(`applicant ${kind} email failed (${(err as { name?: string })?.name ?? "error"})`));
  }

  async transition(user: AuthedUser, id: string, expected: number | null, body: StatusChange) {
    if (expected === null) throw new HttpException("if_match_required", HttpStatus.PRECONDITION_REQUIRED);
    const out = await this.db.withUser(user.id, async (c) => {
      const r = await this.load(c, id);
      if (!this.manageable(user.access, r)) throw new ForbiddenException("Not permitted");
      let res: { from_status: string; to_status: string; row_version: number };
      try {
        res = (await c.query<typeof res>(`SELECT * FROM authz.application_transition($1, $2, $3, $4)`,
          [id, body.to, body.comment ?? null, expected])).rows[0]!;
      } catch (err) { mapApplicationError(err); }
      // No comment text in the audit (rule 5): only whether there was one.
      await this.audit.record(c, { actorId: user.id, action: "application.status_changed", entityType: "job_application", entityId: id,
        changes: { from: res.from_status, to: res.to_status, comment: body.comment !== undefined && body.comment !== "" } });
      return { r, res };
    });
    this.notifyApplicant(out.r.email, out.r.first_name, `Your application for ${out.r.job_title}: ${APPLICATION_STATUS_LABELS[body.to]}`,
      [`The status of your application for ${out.r.job_title} is now: ${APPLICATION_STATUS_LABELS[body.to]}.`], "status");
    return { id, status: out.res.to_status, rowVersion: out.res.row_version };
  }

  async scheduleInterview(user: AuthedUser, id: string, b: ScheduleInterview) {
    const out = await this.db.withUser(user.id, async (c) => {
      const r = await this.load(c, id);
      if (!this.manageable(user.access, r)) throw new ForbiddenException("Not permitted");
      let res: { interview_id: string; from_status: string; to_status: string };
      try {
        res = (await c.query<typeof res>(`SELECT * FROM authz.application_schedule_interview($1, $2, $3, $4, $5::uuid[], $6::timestamptz, $7, $8)`,
          [id, b.interviewType, b.round, b.leadUserId, b.panelUserIds, b.startsAt, b.durationMinutes, b.meetingLink ?? null])).rows[0]!;
      } catch (err) { mapApplicationError(err); }
      await this.audit.record(c, { actorId: user.id, action: "application.interview_scheduled", entityType: "application_interview", entityId: res.interview_id,
        changes: { applicationId: id, interviewType: b.interviewType, round: b.round, panel: b.panelUserIds.length, statusTo: res.to_status } });
      return { r, res };
    });
    const when = new Date(b.startsAt).toISOString().replace("T", " ").slice(0, 16);
    this.notifyApplicant(out.r.email, out.r.first_name, `Interview scheduled: ${out.r.job_title}`, [
      `An interview for your application for ${out.r.job_title} has been scheduled.`,
      `Type: ${APP_INTERVIEW_LABELS[b.interviewType]}`, `Round: ${APP_INTERVIEW_LABELS[b.round]}`,
      `When: ${when} UTC (${b.durationMinutes} minutes)`, ...(b.meetingLink ? [`Meeting link: ${b.meetingLink}`] : []),
    ], "interview");
    return { id: out.res.interview_id, applicationStatus: out.res.to_status };
  }

  async setInterviewStatus(user: AuthedUser, interviewId: string, status: string) {
    return this.db.withUser(user.id, async (c) => {
      const app = (await c.query<{ application_id: string }>(`SELECT application_id FROM eureka.application_interview WHERE id = $1`, [interviewId])).rows[0];
      if (!app) throw new NotFoundException();
      const r = await this.load(c, app.application_id);
      if (!this.manageable(user.access, r)) throw new ForbiddenException("Not permitted");
      try {
        await c.query(`SELECT authz.application_interview_set_status($1, $2)`, [interviewId, status]);
      } catch (err) { mapApplicationError(err); }
      await this.audit.record(c, { actorId: user.id, action: "application.interview_status", entityType: "application_interview", entityId: interviewId,
        changes: { from: "scheduled", to: status } });
      return { id: interviewId, status };
    });
  }

  async scorecard(user: AuthedUser, interviewId: string, b: Scorecard) {
    return this.db.withUser(user.id, async (c) => {
      const i = (await c.query<{ application_id: string }>(`SELECT application_id FROM eureka.application_interview WHERE id = $1`, [interviewId])).rows[0];
      if (!i) throw new NotFoundException();
      let sid: string;
      try {
        sid = (await c.query<{ id: string }>(`SELECT authz.application_scorecard_submit($1, $2, $3, $4, $5, $6) AS id`,
          [interviewId, b.technical, b.communication, b.problemSolving, b.attitude, b.notes ?? null])).rows[0]!.id;
      } catch (err) { mapApplicationError(err); }
      // Scores are not personal data of the applicant beyond the ids; notes never reach the audit.
      await this.audit.record(c, { actorId: user.id, action: "application.scorecard", entityType: "application_scorecard", entityId: sid,
        changes: { interviewId, notes: b.notes !== undefined && b.notes !== "" } });
      return { id: sid };
    });
  }

  /**
   * JP-30: a hired applicant becomes a Eureka candidate through the candidate
   * service (team rules, duplicate check with 409 possible_duplicate) and the
   * application is linked in the same transaction.
   */
  async createCandidate(user: AuthedUser, id: string, b: CreateCandidateFromApplication) {
    const r = await this.db.withUser(user.id, (c) => this.load(c, id));
    if (!this.manageable(user.access, r)) throw new ForbiddenException("Not permitted");
    if (r.status !== "hired") throw new UnprocessableEntityException("application_not_hired");
    if (r.candidate_id !== null) throw new ConflictException("candidate_exists");
    if (r.first_name === null || r.last_name === null) throw new NotFoundException();
    const created = await this.candidates.create(user, {
      firstName: r.first_name, lastName: r.last_name, technologyId: b.technologyId, locationId: b.locationId,
      ...(b.teamId ? { teamId: b.teamId } : {}), ...(r.email ? { email: r.email } : {}), ...(r.phone_e164 ? { phone: r.phone_e164 } : {}),
      ...(b.confirmDuplicate !== undefined ? { confirmDuplicate: b.confirmDuplicate } : {}),
    }, async (c, candidateId) => {
      try {
        await c.query(`SELECT authz.application_link_candidate($1, $2)`, [id, candidateId]);
      } catch (err) { mapApplicationError(err); }
      await this.audit.record(c, { actorId: user.id, action: "application.candidate_created", entityType: "job_application", entityId: id,
        changes: { candidateId } });
    });
    return { candidateId: created.id };
  }

  // ---------- applicants ----------

  async applicants(user: AuthedUser, q: ApplicantListQuery, limit = q.limit + 1, c?: pg.PoolClient) {
    const params: unknown[] = [];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const where = ["true"];
    if (q.search) {
      const s = p(`%${q.search.replace(/[%_\\]/g, "\\$&")}%`);
      where.push(`((ap.first_name || ' ' || ap.last_name) ILIKE ${s} ESCAPE '\\' OR ap.email ILIKE ${s} ESCAPE '\\')`);
    }
    if (q.cursor) {
      const [t, id] = splitCursor(q.cursor);
      where.push(`(ap.created_at, ap.id) < (${fromMicros(p(t))}, ${p(id)}::uuid)`);
    }
    const sql = `SELECT ap.id, ap.first_name, ap.last_name, ap.email, ap.phone_e164, ap.email_verified_at, ap.created_at,
        (SELECT count(*) FROM eureka.job_application a WHERE a.applicant_id = ap.id)::int AS applications, ${toMicros("ap.created_at")} AS k
      FROM eureka.applicant ap WHERE ${where.join(" AND ")} ORDER BY ap.created_at DESC, ap.id DESC LIMIT ${p(limit)}`;
    type Row = { id: string; first_name: string; last_name: string; email: string; phone_e164: string | null; email_verified_at: Date | null; created_at: Date; applications: number; k: string };
    const rows = c ? (await c.query<Row>(sql, params)).rows : await this.db.withUser(user.id, async (cc) => (await cc.query<Row>(sql, params)).rows);
    return rows.map((r) => ({
      id: r.id, name: `${r.first_name} ${r.last_name}`, email: r.email, ...this.phone(user.access, r.phone_e164),
      emailVerified: r.email_verified_at !== null, createdAt: r.created_at, applications: r.applications, k: r.k,
    }));
  }

  async listApplicants(user: AuthedUser, q: ApplicantListQuery) {
    const rows = await this.applicants(user, q);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return { items: page.map(({ k: _k, ...x }) => x), nextCursor: rows.length > q.limit && last ? `${last.k}.${last.id}` : null };
  }

  async exportApplicants(user: AuthedUser, q: { search?: string }) {
    if (!this.exportLimiter.take(user.id)) throw new HttpException("Too many exports; try again in a few minutes", HttpStatus.TOO_MANY_REQUESTS);
    return this.db.withUser(user.id, async (c) => {
      const rows = await this.applicants(user, { ...q, limit: EXPORT_ROW_CAP }, EXPORT_ROW_CAP + 1, c);
      const page = rows.slice(0, EXPORT_ROW_CAP);
      await this.audit.record(c, { actorId: user.id, action: "applicant.export", entityType: "applicant",
        changes: { rows: page.length, truncated: rows.length > EXPORT_ROW_CAP, cap: EXPORT_ROW_CAP, phones: !page.some((r) => r.phoneMasked) && page.some((r) => r.phone !== null) } });
      const csv = toCsv(["Name", "Email", "Phone", "Email verified", "Applications", "Signed up"],
        page.map((r) => [r.name, r.email, r.phone ?? "", r.emailVerified ? "Yes" : "No", r.applications, r.createdAt.toISOString().slice(0, 10)]));
      return { csv, rows: page.length, truncated: rows.length > EXPORT_ROW_CAP };
    });
  }
}
