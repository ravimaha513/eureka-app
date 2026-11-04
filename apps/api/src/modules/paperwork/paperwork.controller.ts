import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import {
  CreateBgcEntry, DeleteBgcEntryQuery, PaperworkQueueQuery, PublishTemplate, UpdateBgc, UpdateBgcEntry, UpdateChecklistItem,
} from "./paperwork.schemas.js";
import { PaperworkService } from "./paperwork.service.js";

/** docs/paperwork-api.md (migration 0044). */
@Controller("api/v1/paperwork")
export class PaperworkController {
  constructor(private readonly svc: PaperworkService) {}

  /** PW-1: work queue (document:read scope over the placement). */
  @Get()
  @RequirePermission("document:read")
  queue(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.queue(user, PaperworkQueueQuery.parse(q));
  }

  @Get("templates")
  @RequirePermission("document:read")
  templates(@CurrentUser() user: AuthedUser) {
    return this.svc.templates(user);
  }

  /** PW-10: publish a new template version (document:verify at org scope). */
  @Post("templates")
  @RequirePermission("document:verify")
  publish(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.svc.publishTemplate(user, PublishTemplate.parse(body));
  }

  @Get("placements/:id")
  @RequirePermission("document:read")
  detail(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.detail(user, id);
  }

  /** PW-6..PW-9: the placement's background check. The service checks bgc:update, or placement.bgc_status:update for marking it initiated. */
  @Patch("placements/:id/bgc")
  @RequirePermission("document:read")
  bgc(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.updateBgc(user, id, UpdateBgc.parse(body));
  }

  /** PW-12: employment / address history rows (bgc:update over the placement; the service and the function check it). Each returns the fresh BGC. */
  @Post("placements/:id/bgc/entries")
  @RequirePermission("document:read")
  addEntry(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.addBgcEntry(user, id, CreateBgcEntry.parse(body));
  }

  @Patch("placements/:id/bgc/entries/:entryId")
  @RequirePermission("document:read")
  updateEntry(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string,
    @Param("entryId", ParseUUIDPipe) entryId: string, @Body() body: unknown) {
    return this.svc.updateBgcEntry(user, id, entryId, UpdateBgcEntry.parse(body));
  }

  @Delete("placements/:id/bgc/entries/:entryId")
  @RequirePermission("document:read")
  deleteEntry(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string,
    @Param("entryId", ParseUUIDPipe) entryId: string, @Query() q: unknown) {
    return this.svc.deleteBgcEntry(user, id, entryId, DeleteBgcEntryQuery.parse(q).expectedVersion);
  }

  @Get("items/:id/history")
  @RequirePermission("document:read")
  history(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.itemHistory(user, id);
  }

  /** PW-2..PW-5: status, owner role, assignee, due date, notes, document link. */
  @Patch("items/:id")
  @RequirePermission("document:upload")
  item(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.updateItem(user, id, UpdateChecklistItem.parse(body));
  }
}
