import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
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

  /** Panel and lead pickers (IS-4): active staff names. */
  @Get("panel-options")
  @RequirePermission("interview:create")
  panelOptions(@CurrentUser() user: AuthedUser) {
    return this.svc.panelOptions(user);
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

  /** IS-7: calendar file of a scheduled interview. */
  @Get(":id/calendar.ics")
  @RequirePermission("interview:read")
  async calendar(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const body = await this.svc.ics(user, id);
    void reply
      .header("content-type", "text/calendar; charset=utf-8")
      .header("content-disposition", `attachment; filename="interview-${id}.ics"`);
    return body;
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
