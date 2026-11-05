import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { CurrentUser, RequirePermission, SelfService, type AuthedUser } from "../../platform/auth.guard.js";
import { AccessLogQuery, DocumentListQuery, DocumentUpload, ReplaceDocumentFile, UpdateDocument } from "./documents.schemas.js";
import { DocumentsService } from "./documents.service.js";
import { ApiBody, ApiQuery } from "../../platform/http/api-doc.js";

/**
 * FR-PPR-01 to 03: paperwork and compliance documents on a candidate or one of
 * the candidate's placements; restricted documents (I-9, driving license,
 * work authorization) open only for HR, Accounts and Immigration. No step-up
 * is required (owner decision on security review B-01); compensating controls:
 * a per-user cap on restricted opens per 24 hours (429), 60 s links, warning
 * logs, and every opening is in the access log.
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
  listForCandidate(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Query() q: unknown) {
    return this.svc.list(user, { kind: "candidate", id }, DocumentListQuery.parse(q ?? {}));
  }

  /** Returns a presigned POST into quarantine/ (2 minutes); the file opens after a clean scan. */
  @ApiBody(DocumentUpload)
  @Post("candidates/:id/documents")
  @RequirePermission("document:upload")
  uploadForCandidate(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.requestUpload(user, { kind: "candidate", id }, () => DocumentUpload.parse(body));
  }

  @Get("placements/:id/documents")
  @RequirePermission("document:read")
  listForPlacement(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Query() q: unknown) {
    return this.svc.list(user, { kind: "placement", id }, DocumentListQuery.parse(q ?? {}));
  }

  @ApiBody(DocumentUpload)
  @Post("placements/:id/documents")
  @RequirePermission("document:upload")
  uploadForPlacement(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.requestUpload(user, { kind: "placement", id }, () => DocumentUpload.parse(body));
  }

  /** Presigned GET (attachment; 60 s) for a clean file; logged; restricted opens are capped per user per 24 h (429). POST so it carries the CSRF token. */
  @Post("documents/:documentId/download")
  @HttpCode(200)
  @RequirePermission("document:read")
  download(@CurrentUser() user: AuthedUser, @Param("documentId", ParseUUIDPipe) documentId: string) {
    return this.svc.download(user, documentId);
  }

  /** DOC-4: title and/or a type of the same classification (document:upload over the candidate; checked in the service and the function). */
  @ApiBody(UpdateDocument)
  @Patch("documents/:documentId")
  @RequirePermission("document:upload")
  update(@CurrentUser() user: AuthedUser, @Param("documentId", ParseUUIDPipe) documentId: string, @Body() body: unknown) {
    return this.svc.update(user, documentId, () => UpdateDocument.parse(body));
  }

  /** DOC-5: a presigned POST for a new file of the same document; it replaces the current one once its scan is clean. */
  @ApiBody(ReplaceDocumentFile)
  @Post("documents/:documentId/replace")
  @RequirePermission("document:upload")
  replace(@CurrentUser() user: AuthedUser, @Param("documentId", ParseUUIDPipe) documentId: string, @Body() body: unknown) {
    return this.svc.requestReplace(user, documentId, () => ReplaceDocumentFile.parse(body));
  }

  /** The access log (audit:read: all; document.restricted:read: one restricted document). Checked in the service. */
  @ApiQuery(AccessLogQuery)
  @Get("document-access")
  @SelfService()
  accessLog(@CurrentUser() user: AuthedUser, @Query() query: unknown) {
    return this.svc.accessLog(user, AccessLogQuery.parse(query));
  }
}
