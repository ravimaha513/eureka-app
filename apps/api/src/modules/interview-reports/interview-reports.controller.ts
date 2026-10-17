import { Body, Controller, Get, HttpCode, Post, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import { DailyInterviewsQuery, InterviewReportQuery } from "./interview-reports.schemas.js";
import { InterviewReportsService } from "./interview-reports.service.js";

export { InterviewReportsService };

const day = (iso: string) => iso.slice(0, 10);

/** Interview reports (gap L4): by coach, technology, candidate or duration; daily report with candidate feedback. */
@Controller("api/v1/reports/interviews")
export class InterviewReportsController {
  constructor(private readonly svc: InterviewReportsService) {}

  @Get()
  @RequirePermission("report:read")
  report(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.report(user, InterviewReportQuery.parse(q));
  }

  /** POST, not GET: audited and CSRF-protected, like the Hot List export. */
  @Post("export")
  @HttpCode(200)
  @RequirePermission("report:export")
  async export(@CurrentUser() user: AuthedUser, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const q = InterviewReportQuery.parse(body);
    const out = await this.svc.exportReport(user, q);
    void reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="interviews-by-${q.groupBy}-${day(q.from)}.csv"`)
      .header("x-export-rows", String(out.rows))
      .header("x-export-truncated", String(out.truncated));
    return out.csv;
  }

  @Get("daily")
  @RequirePermission("report:read")
  daily(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.daily(user, DailyInterviewsQuery.parse(q));
  }

  @Post("daily/export")
  @HttpCode(200)
  @RequirePermission("report:export")
  async exportDaily(@CurrentUser() user: AuthedUser, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const q = DailyInterviewsQuery.parse(body);
    const out = await this.svc.exportDaily(user, q);
    void reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="interviews-daily-${day(q.from)}.csv"`)
      .header("x-export-rows", String(out.rows))
      .header("x-export-truncated", String(out.truncated));
    return out.csv;
  }
}
