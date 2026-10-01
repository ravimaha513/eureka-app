import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from "@nestjs/common";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import {
  BatchListQuery,
  CandidateListQuery,
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

  @Put("candidates/:id/visibility")
  @RequirePermission("candidate.visibility:update")
  visibility(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.setVisibility(user, id, VisibilityUpdate.parse(body).visibility);
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
}
