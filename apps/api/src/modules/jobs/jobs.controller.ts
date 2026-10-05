import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import { parseIfMatch } from "../work-authorization/work-authorization.schemas.js";
import { CreateJob, JobListQuery, UpdateJob } from "./jobs.schemas.js";
import { JobsService } from "./jobs.service.js";

export { JobsService };

/** docs/jobs-portal-api.md "Jobs": client requirements and internal openings. */
@Controller("api/v1/jobs")
export class JobsController {
  constructor(private readonly svc: JobsService) {}

  @Get()
  @RequirePermission("job:read")
  list(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.list(user, JobListQuery.parse(q));
  }

  /** Pickers for the job form (kinds, clients, staff for the hiring manager); companies: GET company-options. */
  @Get("options")
  @RequirePermission("job:manage")
  options(@CurrentUser() user: AuthedUser) {
    return this.svc.options(user);
  }

  /** Company picker (id, name) for internal openings: job:manage holders who may create them (HR). */
  @Get("company-options")
  @RequirePermission("job:manage")
  companyOptions(@CurrentUser() user: AuthedUser) {
    return this.svc.companyOptions(user);
  }

  /** Readable with job:read in scope, or by the job's hiring manager (no permission needed; RLS decides). */
  @Get(":id")
  get(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.get(user, id);
  }

  /** Optional Idempotency-Key: a repeat with the same body returns the first response. */
  @Post()
  @RequirePermission("job:manage")
  create(@CurrentUser() user: AuthedUser, @Body() body: unknown, @Headers("idempotency-key") key: string | undefined) {
    return this.svc.create(user, CreateJob.parse(body), key);
  }

  /** If-Match carries the rowVersion the client saw (428 without it, 412 when stale). */
  @Patch(":id")
  @RequirePermission("job:manage")
  update(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown,
    @Headers("if-match") ifMatch: string | undefined) {
    return this.svc.update(user, id, parseIfMatch(ifMatch), () => UpdateJob.parse(body));
  }
}
