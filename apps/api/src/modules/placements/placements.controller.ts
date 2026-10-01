import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import { CreatePlacement, PlacementListQuery, PlacementStatusChange } from "./placements.schemas.js";
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
