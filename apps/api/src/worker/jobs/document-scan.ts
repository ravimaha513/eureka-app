import { DOCUMENT_MAX_BYTES, isDocumentContentType, type DocumentClassification } from "@eureka/shared";
import { documentQuarantineKey, documentStoredKey } from "../../platform/storage/content.js";
import { inspectDocument } from "../../platform/storage/content-inspect.js";
import type { DocumentStore } from "../document-store.js";
import type { JobDefinition } from "../runner.js";
import { DEFAULT_SCAN_OPTIONS, scanJob, type PendingUpload, type ScanKind, type ScanOptions } from "./scan-pipeline.js";

/**
 * document-scan (FR-PPR-01; design A6.5 "Uploads", B6): the resume pipeline
 * (scan-pipeline.ts) for paperwork and compliance files (eureka.file_object,
 * migration 0043). quarantine/documents/<file id> -> clean/documents/<file id>
 * for internal files, restricted/documents/<file id> under the restricted KMS
 * key (RESTRICTED_KMS_KEY_ARN in AWS) for restricted ones. Audited
 * document.scanned (file id, status, result code).
 */
interface PendingFile extends PendingUpload { classification: DocumentClassification }

export function documentScanKind(restrictedKmsKeyId: string | undefined): ScanKind<PendingFile> {
  return {
    job: "document-scan",
    idField: "fileId",
    noun: "document",
    queueSql: `SELECT * FROM authz.document_scan_queue($1, $2)`,
    finishSql: `SELECT authz.document_scan_finish($1, $2, $3, $4, $5) AS s`,
    audit: { action: "document.scanned", entityType: "file_object" },
    maxBytes: DOCUMENT_MAX_BYTES,
    quarantineKey: (row) => documentQuarantineKey(row.id),
    promotedKey: (row) => documentStoredKey(row.id, row.classification),
    kmsKeyId: (row) => (row.classification === "restricted" ? restrictedKmsKeyId : undefined),
    inspect: (contentType, body) => (isDocumentContentType(contentType) ? inspectDocument(body, contentType) : "BAD_CONTENT"),
  };
}

/**
 * `restrictedKmsKeyId` is required with the S3 store (a restricted file is
 * never written under the data key); the local store ignores it.
 */
export function documentScanJob(store: DocumentStore, opts: ScanOptions = DEFAULT_SCAN_OPTIONS, restrictedKmsKeyId?: string): JobDefinition {
  if (store.kind === "s3" && !restrictedKmsKeyId) throw new Error("document-scan needs the restricted KMS key with S3");
  return scanJob(documentScanKind(store.kind === "s3" ? restrictedKmsKeyId : "local"), store, opts);
}
