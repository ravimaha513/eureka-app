import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import { parseIfMatch } from "../work-authorization/work-authorization.schemas.js";
import { BillsService } from "./bills.service.js";
import { KINDS, type OwnerKind } from "./facilities.common.js";
import {
  BillCreate, BillExportQuery, BillListQuery, BillUpdate, BillVoid, CompanyCreate, CompanyUpdate, EmployeeAdd, EmployeeEnd,
  FacilityCreate, FacilityUpdate, InchargeAdd, InvoiceUpload, OptionsQuery, OwnerExportQuery, OwnerListQuery, StatsQuery, SummaryQuery,
  UtilityCreate, UtilityUpdate,
} from "./facilities.schemas.js";
import { OwnersService } from "./owners.service.js";
import { UtilitiesService } from "./utilities.service.js";

export { BillsService, OwnersService, UtilitiesService };

const csvReply = (reply: FastifyReply, name: string, out: { rows: number; truncated: boolean }) => {
  void reply
    .header("content-type", "text/csv; charset=utf-8")
    .header("content-disposition", `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`)
    .header("x-export-rows", String(out.rows))
    .header("x-export-truncated", String(out.truncated));
};

/**
 * Routes shared by companies and facilities (docs/facilities-api.md): list,
 * detail, create, edit (If-Match), KPI stats, bill summaries, CSV exports,
 * incharges, utilities and bills of one company or facility.
 */
function ownerController(kind: OwnerKind) {
  const k = KINDS[kind];
  const Create = kind === "company" ? CompanyCreate : FacilityCreate;
  const Update = kind === "company" ? CompanyUpdate : FacilityUpdate;

  @Controller(`api/v1/${k.plural}`)
  class OwnerController {
    constructor(readonly owners: OwnersService, readonly utilities: UtilitiesService, readonly bills: BillsService) {}

    @Get()
    @RequirePermission(k.read)
    list(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
      return this.owners.list(user, kind, OwnerListQuery.parse(q));
    }

    @Post()
    @RequirePermission(k.manage)
    create(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
      return this.owners.create(user, kind, Create.parse(body));
    }

    @Get("stats")
    @RequirePermission(k.read)
    stats(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
      return this.owners.stats(user, kind, StatsQuery.parse(q).locationId);
    }

    @Get("bills-summary")
    @RequirePermission("bill:read")
    summary(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
      return this.bills.summary(user, kind, SummaryQuery.parse(q));
    }

    @Get("export.csv")
    @RequirePermission(k.read)
    async export(@CurrentUser() user: AuthedUser, @Query() q: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
      const out = await this.owners.exportCsv(user, kind, OwnerExportQuery.parse(q));
      csvReply(reply, k.plural, out);
      return out.csv;
    }

    @Get(":id")
    @RequirePermission(k.read)
    get(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
      return this.owners.get(user, kind, id);
    }

    /** Optimistic concurrency: `If-Match` carries the rowVersion the client saw (428 without it, 412 when stale). */
    @Patch(":id")
    @RequirePermission(k.manage)
    update(
      @CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown,
      @Headers("if-match") ifMatch: string | undefined,
    ) {
      return this.owners.update(user, kind, id, parseIfMatch(ifMatch), () => Update.parse(body));
    }

    @Get(":id/incharges")
    @RequirePermission(k.read)
    incharges(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
      return this.owners.incharges(user, kind, id);
    }

    @Get(":id/incharge-options")
    @RequirePermission(k.manage)
    inchargeOptions(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Query() q: unknown) {
      return this.owners.inchargeOptions(user, kind, id, OptionsQuery.parse(q).q);
    }

    @Post(":id/incharges")
    @RequirePermission(k.manage)
    addIncharge(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
      return this.owners.addIncharge(user, kind, id, () => InchargeAdd.parse(body));
    }

    @Delete(":id/incharges/:userId")
    @HttpCode(204)
    @RequirePermission(k.manage)
    async removeIncharge(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Param("userId", ParseUUIDPipe) userId: string) {
      await this.owners.removeIncharge(user, kind, id, userId);
    }

    @Get(":id/utilities")
    @RequirePermission("utility:read")
    listUtilities(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
      return this.utilities.list(user, kind, id);
    }

    @Post(":id/utilities")
    @RequirePermission("utility:manage")
    createUtility(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
      return this.utilities.create(user, kind, id, () => UtilityCreate.parse(body));
    }

    @Get(":id/bills")
    @RequirePermission("bill:read")
    listBills(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Query() q: unknown) {
      return this.bills.list(user, kind, id, BillListQuery.parse(q));
    }

    @Post(":id/bills")
    @RequirePermission("bill:manage")
    createBill(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
      return this.bills.create(user, kind, id, () => BillCreate.parse(body));
    }

    @Get(":id/bills/export.csv")
    @RequirePermission("bill:read")
    async exportBills(
      @CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Query() q: unknown,
      @Res({ passthrough: true }) reply: FastifyReply,
    ) {
      const out = await this.bills.exportCsv(user, kind, id, BillExportQuery.parse(q));
      csvReply(reply, `${kind}-bills-${id.slice(0, 8)}`, out);
      return out.csv;
    }
  }
  return OwnerController;
}

/** Own companies (legal entities / offices) of the group; Location Ops Admin of the location. */
export const CompaniesController = ownerController("company");
/** Facilities (guest houses) the group rents; Location Ops Admin of the location. */
export const FacilitiesController = ownerController("facility");

/** Employees working for a company (one company at a time per employee). */
@Controller("api/v1/companies/:id/employees")
export class CompanyEmployeesController {
  constructor(private readonly owners: OwnersService) {}

  @Get()
  @RequirePermission("company:read")
  list(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.owners.employees(user, id);
  }

  @Post()
  @RequirePermission("company:manage")
  add(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.owners.addEmployee(user, id, () => EmployeeAdd.parse(body));
  }

  /** The UI's "Remove": the assignment ends on endDate (kept as history). */
  @Post(":employeeId/end")
  @HttpCode(200)
  @RequirePermission("company:manage")
  end(
    @CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Param("employeeId", ParseUUIDPipe) employeeId: string,
    @Body() body: unknown,
  ) {
    return this.owners.endEmployee(user, id, employeeId, () => EmployeeEnd.parse(body));
  }
}

@Controller("api/v1/companies/:id/employee-options")
export class CompanyEmployeeOptionsController {
  constructor(private readonly owners: OwnersService) {}

  @Get()
  @RequirePermission("company:manage")
  options(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Query() q: unknown) {
    return this.owners.employeeOptions(user, id, OptionsQuery.parse(q).q);
  }
}

@Controller("api/v1/utilities")
export class UtilitiesController {
  constructor(private readonly svc: UtilitiesService) {}

  @Patch(":id")
  @RequirePermission("utility:manage")
  update(
    @CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown,
    @Headers("if-match") ifMatch: string | undefined,
  ) {
    return this.svc.update(user, id, parseIfMatch(ifMatch), () => UtilityUpdate.parse(body));
  }

  /** The password in clear: step-up, rate limit and audit. POST so it carries the CSRF token; never cached. */
  @Post(":id/reveal-password")
  @HttpCode(200)
  @RequirePermission("utility.secret:read")
  reveal(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.reveal(user, id);
  }
}

@Controller("api/v1/bills")
export class BillsController {
  constructor(private readonly svc: BillsService) {}

  @Patch(":id")
  @RequirePermission("bill:manage")
  update(
    @CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown,
    @Headers("if-match") ifMatch: string | undefined,
  ) {
    return this.svc.update(user, id, parseIfMatch(ifMatch), () => BillUpdate.parse(body));
  }

  @Post(":id/void")
  @HttpCode(200)
  @RequirePermission("bill:manage")
  void(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.void(user, id, () => BillVoid.parse(body));
  }

  /** Presigned POST into quarantine (2 minutes); the invoice opens after a clean scan. */
  @Post(":id/invoice")
  @RequirePermission("bill:manage")
  uploadInvoice(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.requestInvoiceUpload(user, id, () => InvoiceUpload.parse(body));
  }

  /** A 60-second download link for a clean invoice; logged in the document access log and audited. */
  @Get(":id/invoice")
  @RequirePermission("bill:read")
  downloadInvoice(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.invoiceDownload(user, id);
  }
}
