import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import {
  AddMember,
  AddMembers,
  BulkCreateUsers,
  CreateDepartment,
  CreateLocation,
  CreateRoleRequest,
  CreateTeam,
  RenameDepartment,
  RenameLocation,
  RenameTeam,
  CreateUser,
  MoveMember,
  RevokeRoleQuery,
  RoleKey,
  RoleRequestListQuery,
  SetLead,
  SetManager,
  UserListQuery,
  SetPassword,
  SetDesignation,
  SetDepartment,
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

  @Get("users/summary")
  userSummary(@CurrentUser() user: AuthedUser) {
    return this.svc.userSummary(user);
  }

  @Post("users")
  createUser(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.svc.createUser(user, CreateUser.parse(body));
  }

  @Post("users/bulk")
  @HttpCode(200)
  bulkCreateUsers(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.svc.bulkCreateUsers(user, BulkCreateUsers.parse(body));
  }

  @Get("users/bulk/template")
  async bulkTemplate(@CurrentUser() user: AuthedUser, @Res({ passthrough: true }) reply: FastifyReply) {
    const file = await this.svc.bulkTemplate(user);
    void reply
      .header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("content-disposition", `attachment; filename="users-import-template.xlsx"`)
      .header("cache-control", "no-store");
    return file;
  }

  @Post("users/:id/password")
  @HttpCode(204)
  async setPassword(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown): Promise<void> {
    await this.svc.setPassword(user, id, SetPassword.parse(body).password);
  }

  @Post("users/:id/password-invite")
  @HttpCode(204)
  async sendPasswordInvite(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string): Promise<void> {
    await this.svc.sendPasswordInvite(user, id);
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

  @Put("users/:id/designation")
  setDesignation(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.setDesignation(user, id, SetDesignation.parse(body).designation, "admin");
  }

  @Put("users/:id/department")
  @HttpCode(204)
  async setDepartment(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown): Promise<void> {
    await this.svc.setDepartment(user, id, SetDepartment.parse(body).departmentId);
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

  // ---------- locations ----------

  @Get("locations")
  listLocations(@CurrentUser() user: AuthedUser) {
    return this.svc.listLocations(user);
  }

  @Get("locations/:id")
  locationDetail(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.locationDetail(user, id);
  }

  @Post("locations")
  createLocation(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.svc.createLocation(user, CreateLocation.parse(body));
  }

  @Patch("locations/:id")
  @HttpCode(204)
  async renameLocation(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown): Promise<void> {
    await this.svc.renameLocation(user, id, RenameLocation.parse(body).name);
  }

  // ---------- departments ----------

  @Get("departments")
  listDepartments(@CurrentUser() user: AuthedUser) {
    return this.svc.listDepartments(user);
  }

  @Post("departments")
  createDepartment(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.svc.createDepartment(user, CreateDepartment.parse(body));
  }

  @Patch("departments/:id")
  @HttpCode(204)
  async renameDepartment(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown): Promise<void> {
    await this.svc.renameDepartment(user, id, RenameDepartment.parse(body).name);
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

  @Patch("teams/:id")
  @HttpCode(204)
  async renameTeam(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown): Promise<void> {
    await this.svc.renameTeam(user, id, RenameTeam.parse(body).name);
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

  @Post("teams/:id/members/bulk")
  @HttpCode(200)
  addMembers(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.addMembers(user, id, AddMembers.parse(body).userIds);
  }

  // AD-11: interview coaches supporting the team
  @Post("teams/:id/coaches")
  @HttpCode(204)
  async assignCoach(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown): Promise<void> {
    await this.svc.changeCoach(user, "admin", "assign", id, AddMember.parse(body).userId);
  }

  @Delete("teams/:id/coaches/:userId")
  @HttpCode(204)
  async unassignCoach(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string,
    @Param("userId", ParseUUIDPipe) userId: string): Promise<void> {
    await this.svc.changeCoach(user, "admin", "unassign", id, userId);
  }
}

/** Team operations outside the admin area (AD-8, AD-10): scoped by team:move_member / team:add_member, not access:manage. */
@Controller("api/v1/teams")
export class TeamsController {
  constructor(private readonly svc: AdminService) {}

  @Get("mine")
  @RequirePermission("team:add_member")
  myTeams(@CurrentUser() user: AuthedUser) {
    return this.svc.myTeams(user);
  }

  @Post(":id/members")
  @HttpCode(204)
  @RequirePermission("team:add_member")
  async addMember(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown): Promise<void> {
    await this.svc.leadAddMember(user, id, AddMember.parse(body).userId);
  }

  // AD-11: an Interview Lead assigns the coaches in their reporting subtree to any team.
  @Post(":id/coaches")
  @HttpCode(204)
  @RequirePermission("coach:assign")
  async assignCoach(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown): Promise<void> {
    await this.svc.changeCoach(user, "hierarchy", "assign", id, AddMember.parse(body).userId);
  }

  @Delete(":id/coaches/:userId")
  @HttpCode(204)
  @RequirePermission("coach:assign")
  async unassignCoach(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string,
    @Param("userId", ParseUUIDPipe) userId: string): Promise<void> {
    await this.svc.changeCoach(user, "hierarchy", "unassign", id, userId);
  }

  @Post(":id/move-member")
  @HttpCode(200)
  @RequirePermission("team:move_member")
  moveMember(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.moveMember(user, id, MoveMember.parse(body));
  }
}

/** AD-11: every team with the caller's coaches assigned to it, and the coaches they may assign (coach:assign). */
@Controller("api/v1/coach-assignments")
export class CoachAssignmentsController {
  constructor(private readonly svc: AdminService) {}

  @Get()
  @RequirePermission("coach:assign")
  list(@CurrentUser() user: AuthedUser) {
    return this.svc.coachAssignments(user);
  }
}

/**
 * Designation changes outside the admin area (docs/performance-api.md PF-7):
 * designation:change over the users the grant covers (manager and associate
 * director: their hierarchy), not access:manage.
 */
@Controller("api/v1/users")
export class UserDesignationController {
  constructor(private readonly svc: AdminService) {}

  @Put(":id/designation")
  @RequirePermission("designation:change")
  setDesignation(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.setDesignation(user, id, SetDesignation.parse(body).designation, "hierarchy");
  }
}
