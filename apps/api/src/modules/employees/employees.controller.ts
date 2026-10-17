import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import {
  ActiveEmployeesQuery, AssignTeam, AssignmentEmployment, EmployeeExportQuery, EmployeeListQuery, EndAssignment, ExitEmployee,
  PlannedEndDate, ReportPeriod, ReturnToMarket,
} from "./employees.schemas.js";
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

  /** EM-X1. POST, not GET: audited and CSRF-protected, like the Hot List export. */
  @Post("export")
  @HttpCode(200)
  @RequirePermission("report:export")
  async export(@CurrentUser() user: AuthedUser, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const out = await this.svc.exportCsv(user, EmployeeExportQuery.parse(body ?? {}));
    void reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="employees-${new Date().toISOString().slice(0, 10)}.csv"`)
      .header("x-export-rows", String(out.rows))
      .header("x-export-truncated", String(out.truncated));
    return out.csv;
  }

  /** 0150: payroll company picker and filter (the group's companies: id, name, status). */
  @Get("payroll-companies")
  @RequirePermission("employee:read")
  payrollCompanies(@CurrentUser() user: AuthedUser) {
    return this.svc.payrollCompanies(user);
  }

  /** 0150: Sales teams to choose from when an employee comes off a project (the employment writers only). */
  @Get("teams")
  @RequirePermission("assignment:update")
  teams(@CurrentUser() user: AuthedUser) {
    return this.svc.teams(user);
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

  /** 0150, leaving a project: HR/Accounts assign the benched employee's candidate to a Sales team. */
  @Post(":id/assign-team")
  @HttpCode(200)
  @RequirePermission("assignment:update")
  assignTeam(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.assignTeam(user, id, AssignTeam.parse(body));
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

  /** 0150: payroll company, E-Verify date, onboarded date, pay rate (rate:read as well). */
  @Patch(":id/employment")
  @RequirePermission("assignment:update")
  employment(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.setEmployment(user, id, AssignmentEmployment.parse(body));
  }
}

/** Joinings and exits (design B7) and active employees per month (0150). */
@Controller("api/v1/reports")
export class ReportsController {
  constructor(private readonly svc: ReportsService) {}

  @Get("joinings-exits")
  @RequirePermission("report:read")
  joiningsExits(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.joiningsExits(user, ReportPeriod.parse(q));
  }

  /** 0150: employees on assignment in a calendar month, by client and payroll company. */
  @Get("active-employees")
  @RequirePermission("report:read")
  activeEmployees(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.activeEmployees(user, ActiveEmployeesQuery.parse(q));
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
