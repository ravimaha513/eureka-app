import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import { parseIfMatch } from "../training/training.schemas.js";
import {
  CreatePreferredVendor, PreferredVendorQuery, PreferredVendorsService, UpdatePreferredVendor,
} from "./preferred-vendors.service.js";

export { PreferredVendorsService };

/**
 * Preferred vendor details (docs/pipeline-vendors-api.md PV-9..PV-12, migration 0172).
 * Reads need vendor.preferred:create (own entries) or vendor.preferred:read (superiors);
 * the service checks either, RLS decides which rows.
 */
@Controller("api/v1/preferred-vendors")
export class PreferredVendorsController {
  constructor(private readonly svc: PreferredVendorsService) {}

  @Get()
  list(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.list(user, PreferredVendorQuery.parse(q));
  }

  @Get(":id")
  get(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.get(user, id);
  }

  @Post()
  @RequirePermission("vendor.preferred:create")
  create(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.svc.create(user, CreatePreferredVendor.parse(body));
  }

  /** `If-Match` carries the rowVersion the client saw (428 without it, 412 when stale). */
  @Patch(":id")
  @RequirePermission("vendor.preferred:create")
  update(
    @CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown,
    @Headers("if-match") ifMatch: string | undefined,
  ) {
    return this.svc.update(user, id, parseIfMatch(ifMatch), () => UpdatePreferredVendor.parse(body));
  }

  /** Archives the entry (it stays readable with ?archived=true). */
  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("vendor.preferred:create")
  async archive(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    await this.svc.archive(user, id);
  }
}
