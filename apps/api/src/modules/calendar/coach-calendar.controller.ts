import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { CurrentUser, RequirePermission, SelfService, type AuthedUser } from "../../platform/auth.guard.js";
import { ApiQuery } from "../../platform/http/api-doc.js";
import { CoachCalendarPeopleQuery, CoachCalendarQuery, SetCoachCalendarGrant } from "./coach-calendar.schemas.js";
import { CoachCalendarService } from "./coach-calendar.service.js";

/** The coach calendar grid and who may see it (docs/coach-calendar-api.md CC-1..CC-5). */
@Controller("api/v1/coach-calendar")
export class CoachCalendarController {
  constructor(private readonly svc: CoachCalendarService) {}

  /** CC-1. A CEO grant is data rather than a permission, so the service does the check (403). */
  @ApiQuery(CoachCalendarQuery)
  @SelfService()
  @Get()
  calendar(@CurrentUser() user: AuthedUser, @Query() query: unknown) {
    return this.svc.calendar(user, query);
  }

  /** CC-2 */
  @Get("grants")
  @RequirePermission("coach_calendar:manage")
  grants(@CurrentUser() user: AuthedUser) {
    return this.svc.grants(user);
  }

  /** CC-3 */
  @ApiQuery(CoachCalendarPeopleQuery)
  @Get("people")
  @RequirePermission("coach_calendar:manage")
  people(@CurrentUser() user: AuthedUser, @Query() query: unknown) {
    return this.svc.people(user, CoachCalendarPeopleQuery.parse(query).q);
  }

  /** CC-4 */
  @Post("grants")
  @RequirePermission("coach_calendar:manage")
  setGrant(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.svc.setGrant(user, SetCoachCalendarGrant.parse(body));
  }

  /** CC-5 */
  @Delete("grants/:id")
  @HttpCode(204)
  @RequirePermission("coach_calendar:manage")
  async removeGrant(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    await this.svc.removeGrant(user, id);
  }
}
