import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from "@nestjs/common";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import {
  AccessLogQuery, FileListQuery, FolderCreate, FolderUpdate, PeopleQuery, SearchQuery, UploadRequest, parseIfMatch,
} from "./datahub.schemas.js";
import { DatahubService } from "./datahub.service.js";

/**
 * DataHub (docs/datahub-api.md): organisation folders with security levels
 * (internal, confidential, restricted) and versioned files on the document
 * storage and malware scan. Every route needs datahub:read (staff); managing
 * needs datahub:manage covering the folder, checked in the service and the
 * database.
 */
@Controller("api/v1/datahub")
export class DatahubController {
  constructor(private readonly svc: DatahubService) {}

  @Get("folders")
  @RequirePermission("datahub:read")
  folders(@CurrentUser() user: AuthedUser) {
    return this.svc.folders(user);
  }

  /** Optional Idempotency-Key: a retried create returns the first answer. */
  @Post("folders")
  @RequirePermission("datahub:read")
  createFolder(@CurrentUser() user: AuthedUser, @Body() body: unknown, @Headers("idempotency-key") key: string | undefined) {
    return this.svc.createFolder(user, () => FolderCreate.parse(body), key);
  }

  @Get("folders/:id")
  @RequirePermission("datahub:read")
  folder(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.folder(user, id);
  }

  /** Optimistic concurrency: `If-Match` carries the rowVersion the client saw (428 without it, 412 when stale). */
  @Patch("folders/:id")
  @RequirePermission("datahub:read")
  updateFolder(
    @CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown,
    @Headers("if-match") ifMatch: string | undefined,
  ) {
    return this.svc.updateFolder(user, id, parseIfMatch(ifMatch), () => FolderUpdate.parse(body));
  }

  @Delete("folders/:id")
  @HttpCode(204)
  @RequirePermission("datahub:read")
  async deleteFolder(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Headers("if-match") ifMatch: string | undefined) {
    await this.svc.deleteFolder(user, id, parseIfMatch(ifMatch));
  }

  @Get("folders/:id/members")
  @RequirePermission("datahub:read")
  members(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.members(user, id);
  }

  @Put("folders/:id/members/:userId")
  @HttpCode(204)
  @RequirePermission("datahub:read")
  async addMember(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Param("userId", ParseUUIDPipe) userId: string) {
    await this.svc.setMember(user, id, userId, true);
  }

  @Delete("folders/:id/members/:userId")
  @HttpCode(204)
  @RequirePermission("datahub:read")
  async removeMember(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Param("userId", ParseUUIDPipe) userId: string) {
    await this.svc.setMember(user, id, userId, false);
  }

  @Get("folders/:id/access-log")
  @RequirePermission("datahub:read")
  accessLog(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Query() query: unknown) {
    return this.svc.accessLog(user, id, AccessLogQuery.parse(query));
  }

  @Get("folders/:id/files")
  @RequirePermission("datahub:read")
  files(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Query() query: unknown) {
    return this.svc.files(user, id, FileListQuery.parse(query));
  }

  /** Returns a presigned POST into quarantine/ (2 minutes); the version opens after a clean scan. */
  @Post("folders/:id/files")
  @RequirePermission("datahub:read")
  upload(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.requestUpload(user, id, () => UploadRequest.parse(body));
  }

  @Get("files/:id/versions")
  @RequirePermission("datahub:read")
  versions(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.versions(user, id);
  }

  @Delete("files/:id")
  @HttpCode(204)
  @RequirePermission("datahub:read")
  async deleteFile(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    await this.svc.deleteFile(user, id);
  }

  /** Presigned GET (attachment; 60 s, restricted 5 min) for a clean version; logged. POST so it carries the CSRF token. */
  @Post("versions/:id/download")
  @HttpCode(200)
  @RequirePermission("datahub:read")
  download(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.download(user, id);
  }

  @Get("search")
  @RequirePermission("datahub:read")
  search(@CurrentUser() user: AuthedUser, @Query() query: unknown) {
    return this.svc.search(user, SearchQuery.parse(query));
  }

  /** People picker for restricted folders (datahub:manage). */
  @Get("people")
  @RequirePermission("datahub:manage")
  people(@CurrentUser() user: AuthedUser, @Query() query: unknown) {
    return this.svc.people(user, PeopleQuery.parse(query));
  }
}
