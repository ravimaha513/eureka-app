import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import { CreatePlacement, PlacementExportQuery, PlacementListQuery, PlacementStatusChange } from "./placements.schemas.js";
import { PlacementsService } from "./placements.service.js";

/** docs/placements-api.md. */
@Controller("api/v1/placements")
export class PlacementsController {
  constructor(private readonly svc: PlacementsService) {}

  @Get()
  @RequirePermission("placement:read")
  list(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.list(user, PlacementListQuery.parse(q));
  }

  /** Placements report CSV (migration 0160). POST, not GET: audited and CSRF-protected, like the Hot List export. */
  @Post("export")
  @HttpCode(200)
  @RequirePermission("report:export")
  async export(@CurrentUser() user: AuthedUser, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const out = await this.svc.exportCsv(user, PlacementExportQuery.parse(body ?? {}));
    void reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="placements-${new Date().toISOString().slice(0, 10)}.csv"`)
      .header("x-export-rows", String(out.rows))
      .header("x-export-truncated", String(out.truncated));
    return out.csv;
  }

  @Get(":id")
  @RequirePermission("placement:read")
  get(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.get(user, id);
  }

  /** PL-8: Idempotency-Key is required; a repeat with the same body returns the first response. */
  @Post()
  @RequirePermission("placement:create")
  create(@CurrentUser() user: AuthedUser, @Body() body: unknown, @Headers("idempotency-key") key: string | undefined) {
    return this.svc.create(user, CreatePlacement.parse(body), key);
  }

  /** PL-4; bgc_failed additionally needs placement.bgc_status:update. */
  @Patch(":id/status")
  @RequirePermission("placement:update")
  status(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.changeStatus(user, id, PlacementStatusChange.parse(body));
  }
}
