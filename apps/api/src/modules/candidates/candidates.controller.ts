import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from "@nestjs/common";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import { BatchStatusChange } from "../training/training.schemas.js";
import {
  BatchListQuery,
  CandidateListQuery,
  ComplianceUpdate,
  CreateBatch,
  CreateCandidate,
  DuplicateCheck,
  HotlistQuery,
  ProfileUpdate,
  RatingUpdate,
  TimelineQuery,
  Transition,
  VisibilityUpdate,
} from "./candidates.schemas.js";
import { CandidatesService } from "./candidates.service.js";

@Controller("api/v1")
export class CandidatesController {
  constructor(private readonly svc: CandidatesService) {}

  @Get("hotlist")
  @RequirePermission("hotlist:read")
  hotlist(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.list(user, "hotlist:read", HotlistQuery.parse(q));
  }

  @Get("candidates")
  @RequirePermission("candidate:read")
  list(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.list(user, "candidate:read", CandidateListQuery.parse(q));
  }

  @Get("candidates/:id")
  @RequirePermission("candidate:read")
  get(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.get(user, id);
  }

  /** FR-CAN-10: events readable under candidate:read (activity events also need the activity readable). */
  @Get("candidates/:id/timeline")
  @RequirePermission("candidate:read")
  timeline(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Query() q: unknown) {
    return this.svc.timeline(user, id, TimelineQuery.parse(q));
  }

  @Post("candidates")
  @RequirePermission("candidate:create")
  create(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.svc.create(user, CreateCandidate.parse(body));
  }

  /** FR-CAN-09: minimal answer (team, contact, id only if readable); rate-limited and audited. */
  @Post("candidates/duplicate-check")
  @HttpCode(200)
  @RequirePermission("candidate:create")
  async duplicateCheck(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return { duplicates: await this.svc.duplicates(user, DuplicateCheck.parse(body)) };
  }

  @Patch("candidates/:id")
  @RequirePermission("candidate:update")
  update(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.updateProfile(user, id, ProfileUpdate.parse(body));
  }

  /** Hard delete with everything recorded about the candidate; 409 candidate_placed once placed (docs/candidates-api.md). */
  @Delete("candidates/:id")
  @HttpCode(204)
  @RequirePermission("candidate:delete")
  async remove(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    await this.svc.remove(user, id);
  }

  /** E-Verify, offer letter and 1099 company links and the documents status (HR, Accounts, Immigration, Documents team). */
  @Put("candidates/:id/compliance")
  @RequirePermission("candidate.compliance:update")
  compliance(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.setCompliance(user, id, ComplianceUpdate.parse(body));
  }

  /** Active companies for the compliance picker. */
  @Get("candidate-companies")
  @RequirePermission("candidate.compliance:update")
  complianceCompanies(@CurrentUser() user: AuthedUser) {
    return this.svc.complianceCompanies(user);
  }

  /** Teams for the New candidate dialog's team picker (candidate:create scope). */
  @Get("candidate-create-teams")
  @RequirePermission("candidate:create")
  createTeams(@CurrentUser() user: AuthedUser) {
    return this.svc.createTeams(user);
  }

  /** Teams for the "Selected teams" picker (0240). */
  @Get("candidate-share-teams")
  @RequirePermission("candidate.visibility:update")
  shareTeams(@CurrentUser() user: AuthedUser) {
    return this.svc.shareTeams(user);
  }

  @Put("candidates/:id/visibility")
  @RequirePermission("candidate.visibility:update")
  visibility(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = VisibilityUpdate.parse(body);
    return this.svc.setVisibility(user, id, b.visibility, b.teamIds);
  }

  @Put("candidates/:id/technical-rating")
  @RequirePermission("candidate.rating:update")
  rating(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.setRating(user, id, RatingUpdate.parse(body).rating);
  }

  @Post("candidates/:id/transition")
  @RequirePermission("candidate:update")
  transition(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.transition(user, id, Transition.parse(body).to);
  }

  /** FR-CAN-02: batches are listed for every candidate:read holder. */
  @Get("batches")
  @RequirePermission("candidate:read")
  batches(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.batches(user, BatchListQuery.parse(q));
  }

  /** Sales leadership only (candidate:create at team, hierarchy or org scope; canCreateBatch). */
  @Post("batches")
  @RequirePermission("candidate:create")
  createBatch(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.svc.createBatch(user, () => CreateBatch.parse(body));
  }

  /** planned -> in_training -> completed, or cancelled before completion; same permission as create. */
  @Put("batches/:id/status")
  @RequirePermission("candidate:create")
  batchStatus(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.setBatchStatus(user, id, BatchStatusChange.parse(body).to);
  }
}
