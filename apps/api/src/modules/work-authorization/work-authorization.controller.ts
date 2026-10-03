import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import { WorkAuthCreate, WorkAuthUpdate, parseIfMatch } from "./work-authorization.schemas.js";
import { WorkAuthorizationService } from "./work-authorization.service.js";

/** FR-VIS-01, 02: a candidate's work authorization records (docs/work-authorization-api.md). */
@Controller("api/v1/candidates/:id/work-authorizations")
export class WorkAuthorizationController {
  constructor(private readonly svc: WorkAuthorizationService) {}

  @Get()
  @RequirePermission("visa:read")
  list(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.list(user, id);
  }

  @Post()
  @RequirePermission("visa:update")
  create(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.create(user, id, () => WorkAuthCreate.parse(body));
  }

  /** Optimistic concurrency: `If-Match` carries the rowVersion the client saw (428 without it, 412 when stale). */
  @Patch(":waId")
  @RequirePermission("visa:update")
  update(
    @CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Param("waId", ParseUUIDPipe) waId: string,
    @Body() body: unknown, @Headers("if-match") ifMatch: string | undefined,
  ) {
    return this.svc.update(user, id, waId, parseIfMatch(ifMatch), () => WorkAuthUpdate.parse(body));
  }

  /** The number in clear; step-up, rate limit and audit. POST so it carries the CSRF token and is never cached. */
  @Post(":waId/reveal")
  @HttpCode(200)
  @RequirePermission("visa:read")
  reveal(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Param("waId", ParseUUIDPipe) waId: string) {
    return this.svc.reveal(user, id, waId);
  }
}
