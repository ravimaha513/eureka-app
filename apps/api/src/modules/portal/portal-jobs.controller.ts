import {
  ConflictException, Controller, Get, HttpCode, HttpException, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Query,
  UnprocessableEntityException,
} from "@nestjs/common";
import type pg from "pg";
import { applicantMayWithdraw, richExcerpt, type ApplicationStatus, type RichDoc } from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import { CurrentApplicant, PortalRoute, type AuthedApplicant } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { fromMicros, splitCursor, toMicros } from "../submissions/pipeline.js";
import { PortalApplicationsQuery, PortalJobsQuery } from "../applications/applications.schemas.js";

/**
 * Applicant portal: jobs and own applications (docs/jobs-portal-api.md
 * JP-22..JP-26). Everything runs as the eureka_portal role for the signed-in
 * applicant (DbService.withApplicant): RLS shows published open internal
 * openings, the applicant's own applications and those applications'
 * interviews (public columns only: no panel, notes, ratings or comments).
 */

interface PortalJobRow {
  id: string; title: string; category: string; experience_level: string; employment_type: string; work_mode: string; status: string;
  location: string | null; deadline: string | null; work_hours: number | null; pay_amount: string | null; pay_frequency: string | null;
  pay_currency: string | null; skills: string[]; requirements: RichDoc | null; description: RichDoc | null; posted_at: Date | null;
  company_id: string | null; application_id: string | null; k: string;
}

const JOB_SQL = `
  SELECT j.id, j.title, j.category, j.experience_level, j.employment_type, j.work_mode, j.status, j.location, j.deadline::text,
         j.work_hours, j.pay_amount::text, j.pay_frequency, j.pay_currency, j.skills, j.requirements, j.description, j.posted_at,
         j.company_id, a.id AS application_id, ${toMicros("coalesce(j.posted_at, 'epoch'::timestamptz)")} AS k
  FROM eureka.job j LEFT JOIN eureka.job_application a ON a.job_id = j.id`;

const CODES: Record<string, () => HttpException> = {
  job_not_found: () => new NotFoundException(),
  application_not_found: () => new NotFoundException(),
  job_not_open: () => new UnprocessableEntityException("job_not_open"),
  already_applied: () => new ConflictException("already_applied"),
  invalid_transition: () => new UnprocessableEntityException("invalid_transition"),
};
function mapPortalError(err: unknown): never {
  const e = err as { message?: string; code?: string };
  const make = e.message !== undefined && e.code !== undefined ? CODES[e.message] : undefined;
  if (make) throw make();
  throw err;
}

@Injectable()
export class PortalJobsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  private presentJob(r: PortalJobRow, full: boolean) {
    return {
      id: r.id, title: r.title,
      // TODO(jobs-portal): the company's display name from eureka.company at integration.
      employer: null as string | null,
      category: r.category, experienceLevel: r.experience_level, employmentType: r.employment_type, workMode: r.work_mode,
      status: r.status, location: r.location, deadline: r.deadline, workHours: r.work_hours,
      pay: r.pay_amount !== null ? { amount: Number(r.pay_amount), frequency: r.pay_frequency, currency: r.pay_currency } : null,
      skills: r.skills, excerpt: richExcerpt(r.description ?? r.requirements, 180),
      requirements: full ? r.requirements : null, description: full ? r.description : null,
      postedAt: r.posted_at, applied: r.application_id !== null, applicationId: r.application_id,
    };
  }

  async jobs(a: AuthedApplicant, cursor: string | undefined) {
    const params: unknown[] = [];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const where = ["j.kind = 'internal_opening'", "j.published_to_portal", "j.status = 'open'"];
    if (cursor) {
      const [t, id] = splitCursor(cursor);
      where.push(`(coalesce(j.posted_at, 'epoch'::timestamptz), j.id) < (${fromMicros(p(t))}, ${p(id)}::uuid)`);
    }
    const limit = 30;
    const rows = await this.db.withApplicant(a.id, async (c) => (await c.query<PortalJobRow>(
      `${JOB_SQL} WHERE ${where.join(" AND ")} ORDER BY coalesce(j.posted_at, 'epoch'::timestamptz) DESC, j.id DESC LIMIT ${p(limit + 1)}`, params)).rows);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: page.map((r) => this.presentJob(r, false)), nextCursor: rows.length > limit && last ? `${last.k}.${last.id}` : null };
  }

  async job(a: AuthedApplicant, id: string) {
    const r = await this.db.withApplicant(a.id, async (c) => (await c.query<PortalJobRow>(`${JOB_SQL} WHERE j.id = $1`, [id])).rows[0]);
    if (!r) throw new NotFoundException();
    return this.presentJob(r, true);
  }

  async apply(a: AuthedApplicant, jobId: string) {
    return this.db.withApplicant(a.id, async (c) => {
      let id: string;
      try {
        id = (await c.query<{ id: string }>(`SELECT authz.application_apply($1) AS id`, [jobId])).rows[0]!.id;
      } catch (err) { mapPortalError(err); }
      await this.auditAs(c, a, "application.applied", id, { jobId });
      return { id };
    });
  }

  /** Ids and codes only, as the applicant (the portal role may insert its own audit rows, migration 0062). */
  private async auditAs(c: pg.PoolClient, a: AuthedApplicant, action: string, id: string, changes: Record<string, unknown>) {
    await this.audit.record(c, { actorId: a.id, action, entityType: "job_application", entityId: id, changes });
  }

  private async interviews(c: pg.PoolClient, ids: string[]) {
    if (!ids.length) return [];
    return (await c.query<{ id: string; application_id: string; interview_type: string; round: string; starts_at: Date; duration_minutes: number; meeting_link: string | null; status: string }>(
      `SELECT id, application_id, interview_type, round, starts_at, duration_minutes, meeting_link, status
       FROM eureka.application_interview WHERE application_id = ANY($1::uuid[]) ORDER BY starts_at DESC, id`, [ids])).rows;
  }

  private async appRows(c: pg.PoolClient, where: string, params: unknown[]) {
    return (await c.query<{
      id: string; status: ApplicationStatus; applied_at: Date; status_changed_at: Date; job_id: string; title: string; work_mode: string;
      employment_type: string; job_status: string; location: string | null;
    }>(`SELECT a.id, a.status, a.applied_at, a.status_changed_at, j.id AS job_id, j.title, j.work_mode, j.employment_type,
               j.status AS job_status, j.location
        FROM eureka.job_application a JOIN eureka.job j ON j.id = a.job_id WHERE ${where} ORDER BY a.applied_at DESC, a.id DESC LIMIT 200`, params)).rows;
  }

  private presentApp(r: Awaited<ReturnType<PortalJobsService["appRows"]>>[number]) {
    return {
      id: r.id, status: r.status, appliedAt: r.applied_at, statusChangedAt: r.status_changed_at, canWithdraw: applicantMayWithdraw(r.status),
      job: { id: r.job_id, title: r.title, employer: null as string | null, workMode: r.work_mode, employmentType: r.employment_type, status: r.job_status, location: r.location },
    };
  }

  async applications(a: AuthedApplicant, status?: string) {
    return this.db.withApplicant(a.id, async (c) => ({
      items: (await this.appRows(c, status ? "a.status = $1" : "true", status ? [status] : [])).map((r) => this.presentApp(r)),
    }));
  }

  async application(a: AuthedApplicant, id: string) {
    return this.db.withApplicant(a.id, async (c) => {
      const r = (await this.appRows(c, "a.id = $1", [id]))[0];
      if (!r) throw new NotFoundException();
      const ints = await this.interviews(c, [id]);
      return {
        ...this.presentApp(r),
        interviews: ints.map((i) => ({ id: i.id, interviewType: i.interview_type, round: i.round, startsAt: i.starts_at,
          durationMinutes: i.duration_minutes, status: i.status, meetingLink: i.status === "scheduled" ? i.meeting_link : null })),
      };
    });
  }

  async withdraw(a: AuthedApplicant, id: string) {
    return this.db.withApplicant(a.id, async (c) => {
      let from: string;
      try {
        from = (await c.query<{ s: string }>(`SELECT authz.application_withdraw($1) AS s`, [id])).rows[0]!.s;
      } catch (err) { mapPortalError(err); }
      await this.auditAs(c, a, "application.withdrawn", id, { from });
      return { id, status: "withdrawn" };
    });
  }
}

@Controller("api/portal")
export class PortalJobsController {
  constructor(private readonly svc: PortalJobsService) {}

  @PortalRoute()
  @Get("jobs")
  jobs(@CurrentApplicant() a: AuthedApplicant, @Query() q: unknown) {
    return this.svc.jobs(a, PortalJobsQuery.parse(q).cursor);
  }

  @PortalRoute()
  @Get("jobs/:id")
  job(@CurrentApplicant() a: AuthedApplicant, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.job(a, id);
  }

  /** Takes no body: the job is in the URL, the applicant is the session's. */
  @PortalRoute()
  @Post("jobs/:id/apply")
  apply(@CurrentApplicant() a: AuthedApplicant, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.apply(a, id);
  }

  @PortalRoute()
  @Get("applications")
  applications(@CurrentApplicant() a: AuthedApplicant, @Query() q: unknown) {
    return this.svc.applications(a, PortalApplicationsQuery.parse(q).status);
  }

  @PortalRoute()
  @Get("applications/:id")
  application(@CurrentApplicant() a: AuthedApplicant, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.application(a, id);
  }

  @PortalRoute()
  @Post("applications/:id/withdraw")
  @HttpCode(200)
  withdraw(@CurrentApplicant() a: AuthedApplicant, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.withdraw(a, id);
  }
}
