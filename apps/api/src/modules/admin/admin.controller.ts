import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import { optionalIfMatch } from "../../platform/http/if-match.js";
import {
  AccessExplainQuery,
  AddMember,
  AddMembers,
  BulkCreateUsers,
  CreateDepartment,
  CreateLocation,
  CreateRole,
  CreateRoleRequest,
  CreateTeam,
  DeleteTeam,
  OrgChartApply,
  OrgChartPreviewQuery,
  RoleListQuery,
  SetRoleGrants,
  UpdateRole,
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
import { AccessExplainService } from "./access-explain.service.js";
import { CoachService } from "./coach.service.js";
import { OrgChartService } from "./org-chart.service.js";
import { OrgUnitsService } from "./org-units.service.js";
import { RoleRequestsService } from "./role-requests.service.js";
import { RolesService } from "./roles.service.js";
import { TeamsService } from "./teams.service.js";
import { UserImportService } from "./user-import.service.js";
import { AdminUsersService } from "./users.service.js";
import { ApiBody, ApiQuery } from "../../platform/http/api-doc.js";

/** Users & Access administration (docs/admin-api.md). AD-1: everything needs access:manage. */
@Controller("api/v1/admin")
@RequirePermission("access:manage")
export class AdminController {
  constructor(
    private readonly users: AdminUsersService,
    private readonly userImport: UserImportService,
    private readonly roles: RolesService,
    private readonly roleRequests: RoleRequestsService,
    private readonly chart: OrgChartService,
    private readonly orgUnits: OrgUnitsService,
    private readonly teams: TeamsService,
    private readonly coach: CoachService,
    private readonly explainer: AccessExplainService,
  ) {}

  /** AD-16: why a user can or cannot see a record, checked against RLS as that user. */
  @ApiQuery(AccessExplainQuery)
  @Get("access-explain")
  explainAccess(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.explainer.explain(user, AccessExplainQuery.parse(q));
  }

  @Get("meta")
  meta(@CurrentUser() user: AuthedUser) {
    return this.users.meta(user);
  }

  // ---------- users ----------

  @ApiQuery(UserListQuery)
  @Get("users")
  listUsers(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.users.listUsers(user, UserListQuery.parse(q));
  }

  @Get("users/summary")
  userSummary(@CurrentUser() user: AuthedUser) {
    return this.users.userSummary(user);
  }

  /** Users holding admin and data roles at once (read-only report; docs/roles-api.md "Admin separation"). */
  @Get("users/violations")
  listUserViolations(@CurrentUser() user: AuthedUser) {
    return this.roles.listUserViolations(user);
  }

  @ApiBody(CreateUser)
  @Post("users")
  createUser(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.users.createUser(user, CreateUser.parse(body));
  }

  @ApiBody(BulkCreateUsers)
  @Post("users/bulk")
  @HttpCode(200)
  bulkCreateUsers(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.userImport.bulkCreateUsers(user, BulkCreateUsers.parse(body));
  }

  @Get("users/bulk/template")
  async bulkTemplate(@CurrentUser() user: AuthedUser, @Res({ passthrough: true }) reply: FastifyReply) {
    const file = await this.userImport.bulkTemplate(user);
    void reply
      .header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("content-disposition", `attachment; filename="users-import-template.xlsx"`)
      .header("cache-control", "no-store");
    return file;
  }

  @ApiBody(SetPassword)
  @Post("users/:id/password")
  @HttpCode(204)
  async setPassword(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown): Promise<void> {
    await this.users.setPassword(user, id, SetPassword.parse(body).password);
  }

  @Post("users/:id/password-invite")
  @HttpCode(204)
  async sendPasswordInvite(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string): Promise<void> {
    await this.users.sendPasswordInvite(user, id);
  }

  @Post("users/:id/deactivate")
  @HttpCode(204)
  async deactivate(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string): Promise<void> {
    await this.users.setStatus(user, id, false);
  }

  @Post("users/:id/reactivate")
  @HttpCode(204)
  async reactivate(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string): Promise<void> {
    await this.users.setStatus(user, id, true);
  }

  /** Deletes (anonymizes) a deactivated user now instead of after the 7-day wait. */
  @Delete("users/:id")
  @HttpCode(204)
  async deleteUser(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string): Promise<void> {
    await this.users.deleteUser(user, id);
  }

  @ApiBody(SetDesignation)
  @Put("users/:id/designation")
  setDesignation(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.users.setDesignation(user, id, SetDesignation.parse(body).designation, "admin");
  }

  @ApiBody(SetDepartment)
  @Put("users/:id/department")
  @HttpCode(204)
  async setDepartment(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown): Promise<void> {
    await this.users.setDepartment(user, id, SetDepartment.parse(body).departmentId);
  }

  @ApiBody(SetManager)
  @Put("users/:id/manager")
  @HttpCode(204)
  async setManager(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown): Promise<void> {
    await this.users.setManager(user, id, SetManager.parse(body).managerId);
  }

  @ApiQuery(RevokeRoleQuery)
  @Delete("users/:id/roles/:role")
  @HttpCode(204)
  async revokeRole(
    @CurrentUser() user: AuthedUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("role") role: string,
    @Query() q: unknown,
  ): Promise<void> {
    await this.roleRequests.revokeRole(user, id, RoleKey.parse(role), RevokeRoleQuery.parse(q).locationId);
  }

  // ---------- role definitions (docs/roles-api.md) ----------

  @ApiQuery(RoleListQuery)
  @Get("roles")
  listRoles(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.roles.listRoles(user, RoleListQuery.parse(q).includeArchived === "true");
  }

  @Get("permissions")
  listPermissions() {
    return this.roles.listPermissions();
  }

  @ApiBody(CreateRole)
  @Post("roles")
  createRole(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.roles.createRole(user, CreateRole.parse(body));
  }

  /** Roles that break admin/data separation (read-only report; docs/roles-api.md "Admin separation"). */
  @Get("roles/violations")
  listRoleViolations(@CurrentUser() user: AuthedUser) {
    return this.roles.listRoleViolations(user);
  }

  /** Optional If-Match: the rowVersion from GET /admin/roles (412 when stale); the new one comes back as ETag. */
  @ApiBody(UpdateRole)
  @Patch("roles/:key")
  @HttpCode(204)
  async updateRole(
    @CurrentUser() user: AuthedUser, @Param("key") key: string, @Body() body: unknown,
    @Headers("if-match") ifMatch: string | undefined, @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<void> {
    const v = await this.roles.updateRole(user, RoleKey.parse(key), UpdateRole.parse(body), optionalIfMatch(ifMatch));
    void res.header("etag", `"${v}"`);
  }

  @ApiBody(SetRoleGrants)
  @Put("roles/:key/grants")
  @HttpCode(204)
  async setRoleGrants(
    @CurrentUser() user: AuthedUser, @Param("key") key: string, @Body() body: unknown,
    @Headers("if-match") ifMatch: string | undefined, @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<void> {
    const v = await this.roles.setRoleGrants(user, RoleKey.parse(key), SetRoleGrants.parse(body), optionalIfMatch(ifMatch));
    void res.header("etag", `"${v}"`);
  }

  @Post("roles/:key/archive")
  @HttpCode(204)
  async archiveRole(@CurrentUser() user: AuthedUser, @Param("key") key: string): Promise<void> {
    await this.roles.archiveRole(user, RoleKey.parse(key), false);
  }

  @Post("roles/:key/restore")
  @HttpCode(204)
  async restoreRole(@CurrentUser() user: AuthedUser, @Param("key") key: string): Promise<void> {
    await this.roles.archiveRole(user, RoleKey.parse(key), true);
  }

  // ---------- org chart (docs/roles-api.md) ----------

  @Get("org-chart")
  orgChart(@CurrentUser() user: AuthedUser) {
    return this.chart.orgChart(user);
  }

  @ApiQuery(OrgChartPreviewQuery)
  @Get("org-chart/preview")
  orgChartPreview(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    const p = OrgChartPreviewQuery.parse(q);
    return this.chart.orgChartPreview(user, p.userId, p.managerId || null);
  }

  @ApiBody(OrgChartApply)
  @Post("org-chart/apply")
  @HttpCode(200)
  orgChartApply(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.chart.orgChartApply(user, OrgChartApply.parse(body));
  }

  // ---------- role requests ----------

  @ApiBody(CreateRoleRequest)
  @Post("role-requests")
  requestRole(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.roleRequests.requestRole(user, CreateRoleRequest.parse(body));
  }

  @ApiQuery(RoleRequestListQuery)
  @Get("role-requests")
  listRoleRequests(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.roleRequests.listRoleRequests(user, RoleRequestListQuery.parse(q));
  }

  @Post("role-requests/:id/approve")
  @HttpCode(200)
  approve(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.roleRequests.decide(user, id, "approve");
  }

  @Post("role-requests/:id/reject")
  @HttpCode(200)
  reject(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.roleRequests.decide(user, id, "reject");
  }

  // ---------- locations ----------

  @Get("locations")
  listLocations(@CurrentUser() user: AuthedUser) {
    return this.orgUnits.listLocations(user);
  }

  @Get("locations/:id")
  locationDetail(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.orgUnits.locationDetail(user, id);
  }

  @ApiBody(CreateLocation)
  @Post("locations")
  createLocation(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.orgUnits.createLocation(user, CreateLocation.parse(body));
  }

  @ApiBody(RenameLocation)
  @Patch("locations/:id")
  @HttpCode(204)
  async renameLocation(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown): Promise<void> {
    await this.orgUnits.renameLocation(user, id, RenameLocation.parse(body).name);
  }

  // ---------- departments ----------

  @Get("departments")
  listDepartments(@CurrentUser() user: AuthedUser) {
    return this.orgUnits.listDepartments(user);
  }

  @ApiBody(CreateDepartment)
  @Post("departments")
  createDepartment(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.orgUnits.createDepartment(user, CreateDepartment.parse(body));
  }

  @ApiBody(RenameDepartment)
  @Patch("departments/:id")
  @HttpCode(204)
  async renameDepartment(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown): Promise<void> {
    await this.orgUnits.renameDepartment(user, id, RenameDepartment.parse(body).name);
  }

  // ---------- teams ----------

  @Get("teams")
  listTeams(@CurrentUser() user: AuthedUser) {
    return this.teams.listTeams(user);
  }

  @ApiBody(CreateTeam)
  @Post("teams")
  createTeam(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.teams.createTeam(user, CreateTeam.parse(body));
  }

  @ApiBody(RenameTeam)
  @Patch("teams/:id")
  @HttpCode(204)
  async renameTeam(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown): Promise<void> {
    await this.teams.renameTeam(user, id, RenameTeam.parse(body).name);
  }

  // AD-15: delete a team (soft), moving its people to ?toTeamId= or leaving them with no team.
  @Get("teams/:id/delete-impact")
  teamDeleteImpact(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.teams.teamDeleteImpact(user, id);
  }

  @ApiQuery(DeleteTeam)
  @Delete("teams/:id")
  @HttpCode(200)
  deleteTeam(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Query() q: unknown) {
    return this.teams.deleteTeam(user, id, DeleteTeam.parse(q));
  }

  @ApiBody(SetLead)
  @Put("teams/:id/lead")
  @HttpCode(204)
  async setLead(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown): Promise<void> {
    await this.teams.setLead(user, id, SetLead.parse(body).leadId);
  }

  @ApiBody(AddMember)
  @Post("teams/:id/members")
  @HttpCode(204)
  async addMember(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown): Promise<void> {
    await this.teams.addMember(user, id, AddMember.parse(body).userId);
  }

  @ApiBody(AddMembers)
  @Post("teams/:id/members/bulk")
  @HttpCode(200)
  addMembers(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.teams.addMembers(user, id, AddMembers.parse(body).userIds);
  }

  @Delete("teams/:id/members/:userId")
  @HttpCode(200)
  removeMember(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string,
    @Param("userId", ParseUUIDPipe) userId: string) {
    return this.teams.removeMember(user, "admin", id, userId);
  }

  // AD-11: interview coaches supporting the team
  @ApiBody(AddMember)
  @Post("teams/:id/coaches")
  @HttpCode(204)
  async assignCoach(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown): Promise<void> {
    await this.coach.changeCoach(user, "admin", "assign", id, AddMember.parse(body).userId);
  }

  @Delete("teams/:id/coaches/:userId")
  @HttpCode(204)
  async unassignCoach(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string,
    @Param("userId", ParseUUIDPipe) userId: string): Promise<void> {
    await this.coach.changeCoach(user, "admin", "unassign", id, userId);
  }
}

/** Team operations outside the admin area (AD-8, AD-10): scoped by team:move_member / team:add_member, not access:manage. */
@Controller("api/v1/teams")
export class TeamsController {
  constructor(private readonly teams: TeamsService, private readonly coach: CoachService) {}

  @Get("mine")
  @RequirePermission("team:add_member")
  myTeams(@CurrentUser() user: AuthedUser) {
    return this.teams.myTeams(user);
  }

  @ApiBody(AddMember)
  @Post(":id/members")
  @HttpCode(204)
  @RequirePermission("team:add_member")
  async addMember(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown): Promise<void> {
    await this.teams.leadAddMember(user, id, AddMember.parse(body).userId);
  }

  @Delete(":id/members/:userId")
  @HttpCode(200)
  @RequirePermission("team:add_member")
  removeMember(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string,
    @Param("userId", ParseUUIDPipe) userId: string) {
    return this.teams.removeMember(user, "team", id, userId);
  }

  // AD-11: an Interview Lead assigns the coaches in their reporting subtree to any team.
  @ApiBody(AddMember)
  @Post(":id/coaches")
  @HttpCode(204)
  @RequirePermission("coach:assign")
  async assignCoach(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown): Promise<void> {
    await this.coach.changeCoach(user, "hierarchy", "assign", id, AddMember.parse(body).userId);
  }

  @Delete(":id/coaches/:userId")
  @HttpCode(204)
  @RequirePermission("coach:assign")
  async unassignCoach(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string,
    @Param("userId", ParseUUIDPipe) userId: string): Promise<void> {
    await this.coach.changeCoach(user, "hierarchy", "unassign", id, userId);
  }

  @ApiBody(MoveMember)
  @Post(":id/move-member")
  @HttpCode(200)
  @RequirePermission("team:move_member")
  moveMember(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.teams.moveMember(user, id, MoveMember.parse(body));
  }
}

/** AD-11: every team with the caller's coaches assigned to it, and the coaches they may assign (coach:assign). */
@Controller("api/v1/coach-assignments")
export class CoachAssignmentsController {
  constructor(private readonly coach: CoachService) {}

  @Get()
  @RequirePermission("coach:assign")
  list(@CurrentUser() user: AuthedUser) {
    return this.coach.coachAssignments(user);
  }
}

/**
 * Designation changes outside the admin area (docs/performance-api.md PF-7):
 * designation:change over the users the grant covers (manager and associate
 * director: their hierarchy), not access:manage.
 */
@Controller("api/v1/users")
export class UserDesignationController {
  constructor(private readonly users: AdminUsersService) {}

  @ApiBody(SetDesignation)
  @Put(":id/designation")
  @RequirePermission("designation:change")
  setDesignation(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.users.setDesignation(user, id, SetDesignation.parse(body).designation, "hierarchy");
  }
}
