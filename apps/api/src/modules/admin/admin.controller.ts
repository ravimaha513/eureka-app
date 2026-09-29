import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from "@nestjs/common";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import {
  AddMember,
  CreateRoleRequest,
  CreateTeam,
  CreateUser,
  MoveMember,
  RevokeRoleQuery,
  RoleKey,
  RoleRequestListQuery,
  SetLead,
  SetManager,
  UserListQuery,
} from "./admin.schemas.js";
import { AdminService } from "./admin.service.js";

/** Users & Access administration (docs/admin-api.md). AD-1: everything needs access:manage. */
@Controller("api/v1/admin")
@RequirePermission("access:manage")
export class AdminController {
  constructor(private readonly svc: AdminService) {}

  @Get("meta")
  meta(@CurrentUser() user: AuthedUser) {
    return this.svc.meta(user);
  }

  // ---------- users ----------

  @Get("users")
  listUsers(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.listUsers(user, UserListQuery.parse(q));
  }

  @Post("users")
  createUser(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.svc.createUser(user, CreateUser.parse(body));
  }

  @Post("users/:id/deactivate")
  @HttpCode(204)
  async deactivate(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string): Promise<void> {
    await this.svc.setStatus(user, id, false);
  }

  @Post("users/:id/reactivate")
  @HttpCode(204)
  async reactivate(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string): Promise<void> {
    await this.svc.setStatus(user, id, true);
  }

  @Put("users/:id/manager")
  @HttpCode(204)
  async setManager(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown): Promise<void> {
    await this.svc.setManager(user, id, SetManager.parse(body).managerId);
  }

  @Delete("users/:id/roles/:role")
  @HttpCode(204)
  async revokeRole(
    @CurrentUser() user: AuthedUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("role") role: string,
    @Query() q: unknown,
  ): Promise<void> {
    await this.svc.revokeRole(user, id, RoleKey.parse(role), RevokeRoleQuery.parse(q).locationId);
  }

  // ---------- role requests ----------

  @Post("role-requests")
  requestRole(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.svc.requestRole(user, CreateRoleRequest.parse(body));
  }

  @Get("role-requests")
  listRoleRequests(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.listRoleRequests(user, RoleRequestListQuery.parse(q).status);
  }

  @Post("role-requests/:id/approve")
  @HttpCode(200)
  approve(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.decide(user, id, "approve");
  }

  @Post("role-requests/:id/reject")
  @HttpCode(200)
  reject(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.decide(user, id, "reject");
  }

  // ---------- teams ----------

  @Get("teams")
  listTeams(@CurrentUser() user: AuthedUser) {
    return this.svc.listTeams(user);
  }

  @Post("teams")
  createTeam(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.svc.createTeam(user, CreateTeam.parse(body));
  }

  @Put("teams/:id/lead")
  @HttpCode(204)
  async setLead(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown): Promise<void> {
    await this.svc.setLead(user, id, SetLead.parse(body).leadId);
  }

  @Post("teams/:id/members")
  @HttpCode(204)
  async addMember(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown): Promise<void> {
    await this.svc.addMember(user, id, AddMember.parse(body).userId);
  }
}

/** Team operations outside the admin area (AD-8): scoped by team:move_member, not access:manage. */
@Controller("api/v1/teams")
export class TeamsController {
  constructor(private readonly svc: AdminService) {}

  @Post(":id/move-member")
  @HttpCode(200)
  @RequirePermission("team:move_member")
  moveMember(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.moveMember(user, id, MoveMember.parse(body));
  }
}
