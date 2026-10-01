import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import { BulkStatus, BulkVisibility, CreateView, HotlistFilters, UpdateView } from "./hotlist.schemas.js";
import { HotlistService } from "./hotlist.service.js";

@Controller("api/v1/hotlist")
export class HotlistController {
  constructor(private readonly svc: HotlistService) {}

  @Get("views")
  @RequirePermission("hotlist:read")
  listViews(@CurrentUser() user: AuthedUser) {
    return this.svc.listViews(user);
  }

  @Post("views")
  @RequirePermission("hotlist:read")
  createView(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.svc.createView(user, CreateView.parse(body));
  }

  @Patch("views/:id")
  @RequirePermission("hotlist:read")
  updateView(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.updateView(user, id, UpdateView.parse(body));
  }

  @Delete("views/:id")
  @RequirePermission("hotlist:read")
  @HttpCode(204)
  async deleteView(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string): Promise<void> {
    await this.svc.deleteView(user, id);
  }

  @Post("bulk/visibility")
  @HttpCode(200)
  @RequirePermission("candidate.visibility:update")
  bulkVisibility(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.svc.bulkVisibility(user, BulkVisibility.parse(body));
  }

  @Post("bulk/status")
  @HttpCode(200)
  @RequirePermission("candidate:update")
  bulkStatus(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.svc.bulkStatus(user, BulkStatus.parse(body));
  }

  /** POST, not GET: it is audited and needs the CSRF token (a cross-site link cannot start it). */
  @Post("export")
  @HttpCode(200)
  @RequirePermission("report:export")
  async export(@CurrentUser() user: AuthedUser, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const out = await this.svc.exportCsv(user, HotlistFilters.parse(body ?? {}));
    const day = new Date().toISOString().slice(0, 10);
    void reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="hotlist-${day}.csv"`)
      .header("x-export-rows", String(out.rows))
      .header("x-export-truncated", String(out.truncated));
    return out.csv;
  }
}
