import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import { parseIfMatch } from "../../platform/http/if-match.js";
import { CreateSubmission, EditSubmission, StatusChange, SubmissionListQuery, SubmissionSummaryQuery, SubmissionsService } from "./submissions.service.js";

export { SubmissionsService };

/** Optional If-Match: absent -> no check; present -> the version, or null (unparseable, always stale). */
const optionalIfMatch = (v: string | undefined) => (v === undefined ? undefined : parseIfMatch(v));

@Controller("api/v1/submissions")
export class SubmissionsController {
  constructor(private readonly svc: SubmissionsService) {}

  /** Optional Idempotency-Key: a retry with the same body returns the first response. */
  @Post()
  @RequirePermission("submission:create")
  create(@CurrentUser() user: AuthedUser, @Body() body: unknown, @Headers("idempotency-key") key: string | undefined) {
    return this.svc.create(user, CreateSubmission.parse(body), key);
  }

  @Get()
  @RequirePermission("submission:read")
  list(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.list(user, SubmissionListQuery.parse(q));
  }

  /** Counts per status and with an interview, for the same filters as the list (minus status/paging). */
  @Get("summary")
  @RequirePermission("submission:read")
  summary(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.summary(user, SubmissionSummaryQuery.parse(q));
  }

  @Get(":id")
  @RequirePermission("submission:read")
  get(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.get(user, id);
  }

  /** Detail corrections, lead and above (submission.details:update); enforced again by authz.edit_submission. Optional If-Match (412 when stale). */
  @Patch(":id")
  @RequirePermission("submission.details:update")
  edit(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown,
    @Headers("if-match") ifMatch: string | undefined) {
    return this.svc.edit(user, id, EditSubmission.parse(body), optionalIfMatch(ifMatch));
  }

  /** State machine transition (design B2.6); enforced again by authz.transition_submission. Optional If-Match (412 when stale). */
  @Patch(":id/status")
  @RequirePermission("submission:update")
  status(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown,
    @Headers("if-match") ifMatch: string | undefined) {
    return this.svc.changeStatus(user, id, StatusChange.parse(body), optionalIfMatch(ifMatch));
  }
}
