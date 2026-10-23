import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import { parseIfMatch } from "../training/training.schemas.js";
import {
  CreateAssessment, FlagNonResponse, PipelineQuery, ResolveNonResponse, UpdateAssessment,
} from "./pipeline-report.schemas.js";
import { PipelineReportService } from "./pipeline-report.service.js";

export { PipelineReportService };

/** Candidate pipeline report (docs/pipeline-vendors-api.md PV-1, PV-2). */
@Controller("api/v1/reports/pipeline")
export class PipelineReportController {
  constructor(private readonly svc: PipelineReportService) {}

  @Get()
  @RequirePermission("report:read")
  report(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.report(user, PipelineQuery.parse(q));
  }
}

/** Assessments ("gliders") of a submission (PV-3, PV-4; migration 0170). */
@Controller("api/v1")
export class AssessmentsController {
  constructor(private readonly svc: PipelineReportService) {}

  @Get("submissions/:id/assessments")
  @RequirePermission("submission:read")
  list(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.listAssessments(user, id);
  }

  @Post("submissions/:id/assessments")
  @RequirePermission("submission:update")
  create(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.createAssessment(user, id, CreateAssessment.parse(body));
  }

  /** `If-Match` carries the rowVersion the client saw (428 without it, 412 when stale). */
  @Patch("assessments/:id")
  @RequirePermission("submission:update")
  update(
    @CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown,
    @Headers("if-match") ifMatch: string | undefined,
  ) {
    return this.svc.updateAssessment(user, id, parseIfMatch(ifMatch), () => UpdateAssessment.parse(body));
  }
}

/** "Candidate not responding" flags (PV-5, PV-6; migration 0171). */
@Controller("api/v1/candidates/:id/non-response")
export class NonResponseController {
  constructor(private readonly svc: PipelineReportService) {}

  @Get()
  @RequirePermission("candidate:read")
  get(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.nonResponse(user, id);
  }

  @Post()
  @RequirePermission("candidate:update")
  flag(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.flagNonResponse(user, id, FlagNonResponse.parse(body).reason);
  }

  @Post("resolve")
  @RequirePermission("candidate:update")
  resolve(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.resolveNonResponse(user, id, ResolveNonResponse.parse(body).resolution);
  }
}
