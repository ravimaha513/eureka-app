import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import { AccessLogQuery, DocumentUpload } from "./documents.schemas.js";
import { DocumentsService } from "./documents.service.js";

/**
 * FR-PPR-01 to 03: paperwork and compliance documents on a candidate or one of
 * the candidate's placements; restricted documents (I-9, driving license,
 * work authorization) open only for HR, Accounts and Immigration after
 * step-up (api/auth/step-up), and every opening is in the access log.
 */
@Controller("api/v1")
export class DocumentsController {
  constructor(private readonly svc: DocumentsService) {}

  /** Document types (stable keys) and their classification. */
  @Get("document-types")
  @RequirePermission("document:read")
  types() {
    return this.svc.types();
  }

  @Get("candidates/:id/documents")
  @RequirePermission("document:read")
  listForCandidate(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.list(user, { kind: "candidate", id });
  }

  /** Returns a presigned POST into quarantine/ (2 minutes); the file opens after a clean scan. */
  @Post("candidates/:id/documents")
  @RequirePermission("document:upload")
  uploadForCandidate(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.requestUpload(user, { kind: "candidate", id }, () => DocumentUpload.parse(body));
  }

  @Get("placements/:id/documents")
  @RequirePermission("document:read")
  listForPlacement(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.list(user, { kind: "placement", id });
  }

  @Post("placements/:id/documents")
  @RequirePermission("document:upload")
  uploadForPlacement(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.requestUpload(user, { kind: "placement", id }, () => DocumentUpload.parse(body));
  }

  /** Presigned GET (attachment; 60 s, restricted 5 min) for a clean file; logged. POST so it carries the CSRF token. */
  @Post("documents/:documentId/download")
  @HttpCode(200)
  @RequirePermission("document:read")
  download(@CurrentUser() user: AuthedUser, @Param("documentId", ParseUUIDPipe) documentId: string) {
    return this.svc.download(user, documentId);
  }

  /** The access log (audit:read: all; document.restricted:read: one restricted document). Checked in the service. */
  @Get("document-access")
  accessLog(@CurrentUser() user: AuthedUser, @Query() query: unknown) {
    return this.svc.accessLog(user, AccessLogQuery.parse(query));
  }
}
