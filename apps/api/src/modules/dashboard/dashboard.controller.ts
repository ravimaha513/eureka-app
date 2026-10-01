import { Controller, Get, Query } from "@nestjs/common";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import { DashboardQuery, DashboardService } from "./dashboard.service.js";

export { DashboardService };

/** Role dashboards (docs/dashboards-api.md): activity counts and "needs attention", in the caller's scope only. */
@Controller("api/v1/dashboard")
export class DashboardController {
  constructor(private readonly svc: DashboardService) {}

  @Get()
  @RequirePermission("report:read")
  get(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.get(user, DashboardQuery.parse(q));
  }
}
