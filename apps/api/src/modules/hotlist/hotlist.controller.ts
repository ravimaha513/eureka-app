import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import { BulkPriority, BulkStatus, BulkVisibility, CreateView, HotlistFilters, UpdateView } from "./hotlist.schemas.js";
import { HotlistService } from "./hotlist.service.js";
import { CandidateViewFilters } from "../candidates/candidates.schemas.js";
import type { ZodType } from "zod";

/** The body with its filters parsed by the list's own filter schema (422 on an unknown filter). */
function viewBody<B extends { filters?: Record<string, unknown> }>(b: B, filters: ZodType): B {
  return b.filters === undefined ? b : { ...b, filters: filters.parse(b.filters) as Record<string, unknown> };
}

@Controller("api/v1")
export class HotlistController {
  constructor(private readonly svc: HotlistService) {}

  // ---- saved views: one set per list; the filters are checked against that list's filters ----

  @Get("hotlist/views")
  @RequirePermission("hotlist:read")
  listViews(@CurrentUser() user: AuthedUser) {
    return this.svc.listViews(user, "hotlist");
  }

  @Post("hotlist/views")
  @RequirePermission("hotlist:read")
  createView(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.svc.createView(user, "hotlist", viewBody(CreateView.parse(body), HotlistFilters));
  }

  @Patch("hotlist/views/:id")
  @RequirePermission("hotlist:read")
  updateView(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.updateView(user, "hotlist", id, viewBody(UpdateView.parse(body), HotlistFilters));
  }

  @Delete("hotlist/views/:id")
  @RequirePermission("hotlist:read")
  @HttpCode(204)
  async deleteView(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string): Promise<void> {
    await this.svc.deleteView(user, "hotlist", id);
  }

  @Get("candidates/views")
  @RequirePermission("candidate:read")
  listCandidateViews(@CurrentUser() user: AuthedUser) {
    return this.svc.listViews(user, "candidates");
  }

  @Post("candidates/views")
  @RequirePermission("candidate:read")
  createCandidateView(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.svc.createView(user, "candidates", viewBody(CreateView.parse(body), CandidateViewFilters));
  }

  @Patch("candidates/views/:id")
  @RequirePermission("candidate:read")
  updateCandidateView(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.updateView(user, "candidates", id, viewBody(UpdateView.parse(body), CandidateViewFilters));
  }

  @Delete("candidates/views/:id")
  @RequirePermission("candidate:read")
  @HttpCode(204)
  async deleteCandidateView(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string): Promise<void> {
    await this.svc.deleteView(user, "candidates", id);
  }

  @Post("hotlist/bulk/visibility")
  @HttpCode(200)
  @RequirePermission("candidate.visibility:update")
  bulkVisibility(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.svc.bulkVisibility(user, BulkVisibility.parse(body));
  }

  @Post("hotlist/bulk/status")
  @HttpCode(200)
  @RequirePermission("candidate:update")
  bulkStatus(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.svc.bulkStatus(user, BulkStatus.parse(body));
  }

  @Post("hotlist/bulk/priority")
  @HttpCode(200)
  @RequirePermission("candidate:update")
  bulkPriority(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.svc.bulkPriority(user, BulkPriority.parse(body));
  }

  /** Choices for the team, recruiter and guest-house filters (names only). */
  @Get("hotlist/filter-options")
  @RequirePermission("hotlist:read")
  filterOptions(@CurrentUser() user: AuthedUser) {
    return this.svc.filterOptions(user);
  }

  /** POST, not GET: it is audited and needs the CSRF token (a cross-site link cannot start it). */
  @Post("hotlist/export")
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
