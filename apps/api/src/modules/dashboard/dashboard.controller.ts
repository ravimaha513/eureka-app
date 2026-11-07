import { Body, Controller, Get, HttpCode, Post, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import { DashboardQuery, DashboardService } from "./dashboard.service.js";
import { ApiBody, ApiQuery } from "../../platform/http/api-doc.js";

export { DashboardService };

/** Role dashboards (docs/dashboards-api.md): activity counts and "needs attention", in the caller's scope only. */
@Controller("api/v1/dashboard")
export class DashboardController {
  constructor(private readonly svc: DashboardService) {}

  /** Manager and above, plus BU Head (dashboard:read); counts still narrow to report:read. */
  @ApiQuery(DashboardQuery)
  @Get()
  @RequirePermission("dashboard:read")
  get(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.get(user, DashboardQuery.parse(q));
  }

  /** Choices for the Coach and Technology filters (migration 0580). Static path before any :param route. */
  @Get("filters")
  @RequirePermission("dashboard:read")
  filters(@CurrentUser() user: AuthedUser) {
    return this.svc.filterOptions(user);
  }

  /**
   * Sales report CSV (grouped counts; migration 0160). POST, not GET: audited and CSRF-protected, like the Hot List export.
   * Needs report:export here and dashboard:read (checked by the service).
   */
  @ApiBody(DashboardQuery)
  @Post("export")
  @HttpCode(200)
  @RequirePermission("report:export")
  async export(@CurrentUser() user: AuthedUser, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const out = await this.svc.exportCsv(user, DashboardQuery.parse(body ?? {}));
    void reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="sales-report-${new Date().toISOString().slice(0, 10)}.csv"`)
      .header("x-export-rows", String(out.rows))
      .header("x-export-truncated", String(out.truncated));
    return out.csv;
  }
}
