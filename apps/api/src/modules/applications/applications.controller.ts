import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import { parseIfMatch } from "../work-authorization/work-authorization.schemas.js";
import {
  ApplicantExport, ApplicantListQuery, ApplicationExport, ApplicationListQuery, CreateCandidateFromApplication, InterviewStatus,
  ScheduleInterview, Scorecard, SetPeople, StatusChange,
} from "./applications.schemas.js";
import { ApplicationsService } from "./applications.service.js";

export { ApplicationsService };

const csvReply = (reply: FastifyReply, name: string, out: { rows: number; truncated: boolean }) => void reply
  .header("content-type", "text/csv; charset=utf-8")
  .header("content-disposition", `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`)
  .header("x-export-rows", String(out.rows))
  .header("x-export-truncated", String(out.truncated));

/**
 * docs/jobs-portal-api.md "Applications". Reads need no single permission:
 * HR (application:read) sees every application, a hiring manager those of
 * their jobs and an interviewer those they interview for (RLS decides).
 */
@Controller("api/v1/applications")
export class ApplicationsController {
  constructor(private readonly svc: ApplicationsService) {}

  @Get()
  list(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.list(user, ApplicationListQuery.parse(q));
  }

  /** POST: audited and CSRF-protected, like the other exports. application:read (HR). */
  @Post("export")
  @HttpCode(200)
  @RequirePermission("application:read")
  async export(@CurrentUser() user: AuthedUser, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const out = await this.svc.exportCsv(user, ApplicationExport.parse(body ?? {}));
    csvReply(reply, "applications", out);
    return out.csv;
  }

  @Get(":id")
  get(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.get(user, id);
  }

  /** If-Match: the application's rowVersion (428 without it, 412 when stale). */
  @Post(":id/status")
  @HttpCode(200)
  status(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown,
    @Headers("if-match") ifMatch: string | undefined) {
    return this.svc.transition(user, id, parseIfMatch(ifMatch), StatusChange.parse(body));
  }

  @Post(":id/interviews")
  schedule(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.scheduleInterview(user, id, ScheduleInterview.parse(body));
  }

  /** Hired applicant -> Eureka candidate (candidate:create; the candidate service's team rules and duplicate check). */
  @Post(":id/candidate")
  @RequirePermission("candidate:create")
  createCandidate(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.createCandidate(user, id, CreateCandidateFromApplication.parse(body));
  }
}

@Controller("api/v1/application-interviews")
export class ApplicationInterviewsController {
  constructor(private readonly svc: ApplicationsService) {}

  @Post(":id/status")
  @HttpCode(200)
  status(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.setInterviewStatus(user, id, InterviewStatus.parse(body).status);
  }

  /** Change the lead / remove panelists of a scheduled interview (the application's managers). */
  @Put(":id/people")
  people(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.setPeople(user, id, SetPeople.parse(body));
  }

  /** The caller's own scorecard (insert or replace). */
  @Put(":id/scorecard")
  scorecard(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.scorecard(user, id, Scorecard.parse(body));
  }
}

@Controller("api/v1/applicants")
export class ApplicantsController {
  constructor(private readonly svc: ApplicationsService) {}

  @Get()
  @RequirePermission("applicant:read")
  list(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.listApplicants(user, ApplicantListQuery.parse(q));
  }

  @Post("export")
  @HttpCode(200)
  @RequirePermission("applicant:read")
  async export(@CurrentUser() user: AuthedUser, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const out = await this.svc.exportApplicants(user, ApplicantExport.parse(body ?? {}));
    csvReply(reply, "applicants", out);
    return out.csv;
  }
}
