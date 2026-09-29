import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from "@nestjs/common";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import {
  CandidateListQuery,
  CreateCandidate,
  ProfileUpdate,
  RatingUpdate,
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
    return this.svc.list(user, "hotlist:read", CandidateListQuery.parse(q));
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

  @Post("candidates")
  @RequirePermission("candidate:create")
  create(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.svc.create(user, CreateCandidate.parse(body));
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
}
