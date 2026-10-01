import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import { ResumeUpload } from "./resumes.schemas.js";
import { ResumesService } from "./resumes.service.js";

/** FR-CAN-07: candidate resumes (document:read / document:upload over the candidate). */
@Controller("api/v1/candidates/:id/resumes")
export class ResumesController {
  constructor(private readonly svc: ResumesService) {}

  @Get()
  @RequirePermission("document:read")
  list(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.list(user, id);
  }

  /** Returns a presigned POST into quarantine/ (5 minutes); the file becomes available after a clean scan. */
  @Post()
  @RequirePermission("document:upload")
  upload(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.requestUpload(user, id, () => ResumeUpload.parse(body));
  }

  /** Presigned GET (60 s, attachment) for a clean resume; audited. POST so it carries the CSRF token. */
  @Post(":resumeId/download")
  @HttpCode(200)
  @RequirePermission("document:read")
  download(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Param("resumeId", ParseUUIDPipe) resumeId: string) {
    return this.svc.download(user, id, resumeId);
  }
}
