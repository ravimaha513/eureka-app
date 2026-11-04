import { z } from "zod";
import {
  DOCUMENT_CONTENT_TYPE_LIST, DOCUMENT_MAX_BYTES, DOCUMENT_TYPE_LIST, type DocumentContentType, type DocumentType,
} from "@eureka/shared";

/**
 * Upload request (FR-PPR-01): the document type, the declared content type
 * and the exact size. No file name, key, classification, owner or status: the
 * server derives them (the classification from the type, the owner from the
 * URL, the key from the server-generated file id; design A6.5).
 */
export const DocumentUpload = z
  .object({
    docType: z.enum(DOCUMENT_TYPE_LIST as [DocumentType, ...DocumentType[]]),
    contentType: z.enum(DOCUMENT_CONTENT_TYPE_LIST as [DocumentContentType, ...DocumentContentType[]]),
    size: z.number().int().min(1).max(DOCUMENT_MAX_BYTES),
  })
  .strict();
export type DocumentUpload = z.infer<typeof DocumentUpload>;

/** Access-log query: one document (restricted readers) or all (org admins, audit:read). */
export const AccessLogQuery = z
  .object({
    documentId: z.string().uuid().optional(),
    before: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

const noControl = /^[^\p{Cc}]+$/u;

/**
 * PATCH /documents/:documentId (DOC-4): a display title and/or another type of
 * the same classification. Owner, classification, file and status are the server's.
 */
export const UpdateDocument = z
  .object({
    title: z.string().trim().min(1).max(120).regex(noControl, "no control characters").nullable().optional(),
    docType: z.enum(DOCUMENT_TYPE_LIST as [DocumentType, ...DocumentType[]]).optional(),
    /** Optimistic concurrency: the document `version` the caller last read. */
    expectedVersion: z.number().int().min(1).optional(),
  })
  .strict()
  .refine((b) => b.title !== undefined || b.docType !== undefined, "nothing to change");
export type UpdateDocument = z.infer<typeof UpdateDocument>;

/** POST /documents/:documentId/replace (DOC-5): the new file's declared content type and exact size. */
export const ReplaceDocumentFile = z
  .object({
    contentType: z.enum(DOCUMENT_CONTENT_TYPE_LIST as [DocumentContentType, ...DocumentContentType[]]),
    size: z.number().int().min(1).max(DOCUMENT_MAX_BYTES),
    expectedVersion: z.number().int().min(1).optional(),
  })
  .strict();
export type ReplaceDocumentFile = z.infer<typeof ReplaceDocumentFile>;
