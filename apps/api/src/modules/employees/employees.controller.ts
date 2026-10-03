import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import { EmployeeListQuery, EndAssignment, ExitEmployee, PlannedEndDate, ReportPeriod, ReturnToMarket } from "./employees.schemas.js";
import { EmployeesService } from "./employees.service.js";
import { ReportsService } from "./reports.service.js";

export { EmployeesService, ReportsService };

/** docs/employees-api.md: employees (employee:read at org scope) and their lifecycle actions. */
@Controller("api/v1/employees")
export class EmployeesController {
  constructor(private readonly svc: EmployeesService) {}

  @Get()
  @RequirePermission("employee:read")
  list(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.list(user, EmployeeListQuery.parse(q));
  }

  @Get(":id")
  @RequirePermission("employee:read")
  get(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.get(user, id);
  }

  /** Bench -> exited. */
  @Post(":id/exit")
  @HttpCode(200)
  @RequirePermission("assignment:update")
  exit(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.exit(user, id, ExitEmployee.parse(body));
  }

  /** Reassignment, first step: back to marketing (candidate bench -> active). */
  @Post(":id/return-to-market")
  @HttpCode(200)
  @RequirePermission("assignment:update")
  returnToMarket(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    ReturnToMarket.parse(body ?? {});
    return this.svc.returnToMarket(user, id);
  }
}

/** Assignment lifecycle: project exit and planned end date (assignment:update). */
@Controller("api/v1/assignments")
export class AssignmentsController {
  constructor(private readonly svc: EmployeesService) {}

  @Post(":id/end")
  @HttpCode(200)
  @RequirePermission("assignment:update")
  end(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.endAssignment(user, id, EndAssignment.parse(body));
  }

  @Put(":id/planned-end-date")
  @RequirePermission("assignment:update")
  plannedEnd(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.setPlannedEndDate(user, id, PlannedEndDate.parse(body));
  }
}

/** Joinings and exits (design B7). */
@Controller("api/v1/reports")
export class ReportsController {
  constructor(private readonly svc: ReportsService) {}

  @Get("joinings-exits")
  @RequirePermission("report:read")
  joiningsExits(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.joiningsExits(user, ReportPeriod.parse(q));
  }

  /** POST, not GET: audited and CSRF-protected, like the Hot List export. */
  @Post("joinings-exits/export")
  @HttpCode(200)
  @RequirePermission("report:export")
  async export(@CurrentUser() user: AuthedUser, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const period = ReportPeriod.parse(body);
    const out = await this.svc.exportCsv(user, period);
    void reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="joinings-exits-${period.from}-to-${period.to}.csv"`)
      .header("x-export-rows", String(out.rows))
      .header("x-export-truncated", String(out.truncated));
    return out.csv;
  }
}
