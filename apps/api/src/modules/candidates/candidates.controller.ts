import { Body, Controller, Delete, Get, Headers, HttpCode, HttpException, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import { optionalIfMatch } from "../../platform/http/if-match.js";
import { BatchStatusChange } from "../training/training.schemas.js";
import {
  BatchListQuery,
  BulkBatchCandidates,
  CandidateListQuery,
  ComplianceUpdate,
  CreateBatch,
  AssignCandidateTeam,
  CreateCandidate,
  DuplicateCheck,
  HotlistQuery,
  ProfileUpdate,
  RatingUpdate,
  RecruiterUpdate,
  TimelineQuery,
  Transition,
  VisibilityUpdate,
} from "./candidates.schemas.js";
import { CandidateMetricsService } from "./candidate-metrics.service.js";
import { CandidateBatchesService } from "./candidate-batches.service.js";
import { CandidateCreateService } from "./candidate-create.service.js";
import { CandidateListService } from "./candidate-list.service.js";
import { CandidateProfileService } from "./candidate-profile.service.js";
import { CandidateTimelineService } from "./candidate-timeline.service.js";
import { ApiBody, ApiQuery } from "../../platform/http/api-doc.js";

/**
 * Optional If-Match on single-candidate writes (docs/candidates-api.md "Optimistic
 * concurrency"): no header (or `*`) -> null, no check; a version -> 412 when stale;
 * anything else can never match -> 412.
 */
const expectedVersion = optionalIfMatch;

@Controller("api/v1")
export class CandidatesController {
  constructor(
    private readonly lists: CandidateListService,
    private readonly profiles: CandidateProfileService,
    private readonly creator: CandidateCreateService,
    private readonly batchSvc: CandidateBatchesService,
    private readonly timelines: CandidateTimelineService,
    private readonly metricsSvc: CandidateMetricsService,
  ) {}

  @ApiQuery(HotlistQuery)
  @Get("hotlist")
  @RequirePermission("hotlist:read")
  hotlist(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.lists.list(user, "hotlist:read", HotlistQuery.parse(q));
  }

  @ApiQuery(CandidateListQuery)
  @Get("candidates")
  @RequirePermission("candidate:read")
  list(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.lists.list(user, "candidate:read", CandidateListQuery.parse(q));
  }

  @Get("candidates/:id")
  @RequirePermission("candidate:read")
  get(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.profiles.get(user, id);
  }

  /** FR-CAN-10: events readable under candidate:read (activity events also need the activity readable). */
  @ApiQuery(TimelineQuery)
  @Get("candidates/:id/timeline")
  @RequirePermission("candidate:read")
  timeline(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Query() q: unknown) {
    return this.timelines.timeline(user, id, TimelineQuery.parse(q));
  }

  /** Submission, interview and placement counts, each under its own read scope (docs/candidates-api.md "Metrics"). */
  @Get("candidates/:id/metrics")
  @RequirePermission("candidate:read")
  metrics(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.metricsSvc.metrics(user, id);
  }

  @ApiBody(CreateCandidate)
  @Post("candidates")
  @RequirePermission("candidate:create")
  create(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.creator.create(user, CreateCandidate.parse(body));
  }

  /** FR-CAN-09: minimal answer (team, contact, id only if readable); rate-limited and audited. */
  @ApiBody(DuplicateCheck)
  @Post("candidates/duplicate-check")
  @HttpCode(200)
  @RequirePermission("candidate:create")
  async duplicateCheck(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return { duplicates: await this.creator.duplicates(user, DuplicateCheck.parse(body)) };
  }

  @ApiBody(ProfileUpdate)
  @Patch("candidates/:id")
  @RequirePermission("candidate:update")
  update(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown,
    @Headers("if-match") ifMatch: string | undefined) {
    return this.profiles.updateProfile(user, id, ProfileUpdate.parse(body), expectedVersion(ifMatch));
  }

  /** Hard delete with everything recorded about the candidate; 409 candidate_placed once placed (docs/candidates-api.md). */
  @Delete("candidates/:id")
  @HttpCode(204)
  @RequirePermission("candidate:delete")
  async remove(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    await this.profiles.remove(user, id);
  }

  /** E-Verify, offer letter and 1099 company links and the documents status (HR, Accounts, Immigration, Documents team). */
  @ApiBody(ComplianceUpdate)
  @Put("candidates/:id/compliance")
  @RequirePermission("candidate.compliance:update")
  compliance(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown,
    @Headers("if-match") ifMatch: string | undefined) {
    return this.profiles.setCompliance(user, id, ComplianceUpdate.parse(body), expectedVersion(ifMatch));
  }

  /** Active companies for the compliance picker. */
  @Get("candidate-companies")
  @RequirePermission("candidate.compliance:update")
  complianceCompanies(@CurrentUser() user: AuthedUser) {
    return this.profiles.complianceCompanies(user);
  }

  /** Teams for the New candidate dialog's team picker (candidate:create scope). */
  @Get("candidate-create-teams")
  @RequirePermission("candidate:create")
  createTeams(@CurrentUser() user: AuthedUser) {
    return this.profiles.createTeams(user);
  }

  /** A candidate created with no team gets one (0410); same right and teams as choosing it at creation. */
  @ApiBody(AssignCandidateTeam)
  @Put("candidates/:id/team")
  @RequirePermission("candidate:create")
  assignTeam(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.profiles.assignTeam(user, id, AssignCandidateTeam.parse(body).teamId);
  }

  /** Teams for the "Selected teams" picker (0240). */
  @Get("candidate-share-teams")
  @RequirePermission("candidate.visibility:update")
  shareTeams(@CurrentUser() user: AuthedUser) {
    return this.profiles.shareTeams(user);
  }

  @ApiBody(VisibilityUpdate)
  @Put("candidates/:id/visibility")
  @RequirePermission("candidate.visibility:update")
  visibility(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown,
    @Headers("if-match") ifMatch: string | undefined) {
    const b = VisibilityUpdate.parse(body);
    return this.profiles.setVisibility(user, id, b.visibility, b.teamIds, expectedVersion(ifMatch));
  }

  /** Who can be the recruiter: the candidate's team's active members and lead. */
  @Get("candidates/:id/recruiter-options")
  @RequirePermission("candidate:assign")
  recruiterOptions(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.profiles.recruiterOptions(user, id);
  }

  /** A lead or above; 422 invalid_recruiter when the user isn't on the candidate's team. */
  @ApiBody(RecruiterUpdate)
  @Put("candidates/:id/recruiter")
  @RequirePermission("candidate:assign")
  setRecruiter(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown,
    @Headers("if-match") ifMatch: string | undefined) {
    return this.profiles.setRecruiter(user, id, RecruiterUpdate.parse(body).recruiterId, expectedVersion(ifMatch));
  }

  @ApiBody(RatingUpdate)
  @Put("candidates/:id/technical-rating")
  @RequirePermission("candidate.rating:update")
  rating(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown,
    @Headers("if-match") ifMatch: string | undefined) {
    return this.profiles.setRating(user, id, RatingUpdate.parse(body).rating, expectedVersion(ifMatch));
  }

  @ApiBody(Transition)
  @Post("candidates/:id/transition")
  @RequirePermission("candidate:update")
  transition(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown,
    @Headers("if-match") ifMatch: string | undefined) {
    return this.profiles.transition(user, id, Transition.parse(body).to, expectedVersion(ifMatch));
  }

  /** FR-CAN-02: batches are listed for every candidate:read holder. */
  @ApiQuery(BatchListQuery)
  @Get("batches")
  @RequirePermission("candidate:read")
  batches(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.batchSvc.batches(user, BatchListQuery.parse(q));
  }

  /** Sales leadership only (candidate:create at team, hierarchy or org scope; canCreateBatch). */
  @ApiBody(CreateBatch)
  @Post("batches")
  @RequirePermission("candidate:create")
  createBatch(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.batchSvc.createBatch(user, () => CreateBatch.parse(body));
  }

  /** The .xlsx for the bulk add below: only the fields a new candidate must have. */
  @Get("batches/candidate-template")
  @RequirePermission("candidate:create")
  async candidateTemplate(@Res({ passthrough: true }) reply: FastifyReply) {
    const file = await this.batchSvc.candidateTemplate();
    void reply
      .header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("content-disposition", `attachment; filename="batch-candidates-template.xlsx"`)
      .header("cache-control", "no-store");
    return file;
  }

  /** New candidates for a batch; preview with dryRun, all or nothing otherwise. */
  @ApiBody(BulkBatchCandidates)
  @Post("batches/:id/candidates/bulk")
  @HttpCode(200)
  @RequirePermission("candidate:create")
  bulkAddToBatch(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.batchSvc.bulkAddToBatch(user, id, BulkBatchCandidates.parse(body));
  }

  /** planned -> in_training -> completed, or cancelled before completion; same permission as create. */
  @ApiBody(BatchStatusChange)
  @Put("batches/:id/status")
  @RequirePermission("candidate:create")
  batchStatus(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.batchSvc.setBatchStatus(user, id, BatchStatusChange.parse(body).to);
  }
}
