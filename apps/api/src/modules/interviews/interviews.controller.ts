import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import { CreateFeedback, CreateInterview, InterviewListQuery, UpdateInterview } from "./interviews.schemas.js";
import { InterviewsService } from "./interviews.service.js";

@Controller("api/v1/interviews")
export class InterviewsController {
  constructor(private readonly svc: InterviewsService) {}

  @Get("coaches")
  @RequirePermission("interview:create")
  coaches(@CurrentUser() user: AuthedUser) {
    return this.svc.coaches(user);
  }

  /** Interview board: date range, call status, team, location, candidate filters. */
  @Get()
  @RequirePermission("interview:read")
  list(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.list(user, InterviewListQuery.parse(q));
  }

  @Get(":id")
  @RequirePermission("interview:read")
  get(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.get(user, id);
  }

  @Post()
  @RequirePermission("interview:create")
  create(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.svc.create(user, CreateInterview.parse(body));
  }

  @Patch(":id")
  @RequirePermission("interview:update")
  update(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.update(user, id, UpdateInterview.parse(body));
  }

  @Get(":id/feedback")
  @RequirePermission("interview:read")
  feedback(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.listFeedback(user, id);
  }

  @Post(":id/feedback")
  @RequirePermission("interview.feedback:create")
  addFeedback(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.addFeedback(user, id, CreateFeedback.parse(body));
  }
}
