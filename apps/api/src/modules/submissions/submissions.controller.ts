import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import { CreateSubmission, StatusChange, SubmissionListQuery, SubmissionsService } from "./submissions.service.js";

export { SubmissionsService };

@Controller("api/v1/submissions")
export class SubmissionsController {
  constructor(private readonly svc: SubmissionsService) {}

  @Post()
  @RequirePermission("submission:create")
  create(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.svc.create(user, CreateSubmission.parse(body));
  }

  @Get()
  @RequirePermission("submission:read")
  list(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.list(user, SubmissionListQuery.parse(q));
  }

  @Get(":id")
  @RequirePermission("submission:read")
  get(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.get(user, id);
  }

  /** State machine transition (design B2.6); enforced again by authz.transition_submission. */
  @Patch(":id/status")
  @RequirePermission("submission:update")
  status(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.changeStatus(user, id, StatusChange.parse(body));
  }
}
