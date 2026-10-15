import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import { CreateContract } from "./contracts.schemas.js";
import { ContractsService } from "./contracts.service.js";

/** Contracts of a placement (docs/alerts-calendar-birthdays.md CT-1..CT-6). The database decides who may add one. */
@Controller("api/v1/placements/:id/contracts")
export class ContractsController {
  constructor(private readonly svc: ContractsService) {}

  @Get()
  @RequirePermission("placement:read")
  list(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.list(user, id);
  }

  @Post()
  @RequirePermission("placement:read")
  create(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.create(user, id, CreateContract.parse(body));
  }
}
