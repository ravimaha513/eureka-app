import { Body, Controller, Get, HttpCode, Post, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import { MarketReportQuery } from "./market-report.schemas.js";
import { MarketReportService } from "./market-report.service.js";

export { MarketReportService };

/** CEO market reports (gap L3, docs/market-reports-api.md). */
@Controller("api/v1/reports/market")
export class MarketReportController {
  constructor(private readonly svc: MarketReportService) {}

  /** MR-1: point-in-time counts per group. */
  @Get()
  @RequirePermission("report.market:read")
  get(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.get(user, MarketReportQuery.parse(q));
  }

  /** MR-2. POST, not GET: audited and CSRF-protected, like the Hot List export. */
  @Post("export")
  @HttpCode(200)
  @RequirePermission("report:export")
  async export(@CurrentUser() user: AuthedUser, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const q = MarketReportQuery.parse(body ?? {});
    const out = await this.svc.exportCsv(user, q);
    void reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="market-by-${q.groupBy}-${new Date().toISOString().slice(0, 10)}.csv"`)
      .header("x-export-rows", String(out.rows))
      .header("x-export-truncated", String(out.truncated));
    return out.csv;
  }
}
