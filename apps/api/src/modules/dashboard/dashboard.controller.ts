import { Body, Controller, Get, HttpCode, Post, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
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

  /** Sales report CSV (grouped counts; migration 0160). POST, not GET: audited and CSRF-protected, like the Hot List export. */
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
