import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Put, Query } from "@nestjs/common";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import { ActiveCandidatesQuery, ActivityQuery, PeriodQuery, SetTarget, TargetListQuery } from "./performance.schemas.js";
import { PerformanceService } from "./performance.service.js";

export { PerformanceService };

/** Recruiter performance (docs/performance-api.md): counts, drill-down, active candidates and targets, in the caller's scope only. */
@Controller("api/v1/performance")
export class PerformanceController {
  constructor(private readonly svc: PerformanceService) {}

  @Get("summary")
  @RequirePermission("performance:read")
  summary(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.summary(user, PeriodQuery.parse(q));
  }

  @Get("activity")
  @RequirePermission("performance:read")
  activity(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.activity(user, ActivityQuery.parse(q));
  }

  @Get("active-candidates")
  @RequirePermission("performance:read")
  activeCandidates(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.activeCandidates(user, ActiveCandidatesQuery.parse(q));
  }

  @Get("people")
  @RequirePermission("performance:read")
  people(@CurrentUser() user: AuthedUser) {
    return this.svc.peopleList(user);
  }

  @Get("targets")
  @RequirePermission("performance:read")
  targets(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.listTargets(user, TargetListQuery.parse(q));
  }

  @Put("targets")
  @RequirePermission("performance.target:manage")
  setTarget(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.svc.setTarget(user, SetTarget.parse(body));
  }

  @Delete("targets/:id")
  @HttpCode(204)
  @RequirePermission("performance.target:manage")
  async deleteTarget(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string): Promise<void> {
    await this.svc.deleteTarget(user, id);
  }
}
