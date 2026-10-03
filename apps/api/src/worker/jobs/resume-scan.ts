import { RESUME_MAX_BYTES, isResumeContentType } from "@eureka/shared";
import { resumeCleanKey, resumeQuarantineKey } from "../../platform/storage/content.js";
import { inspectResume } from "../../platform/storage/content-inspect.js";
import type { DocumentStore } from "../document-store.js";
import type { JobDefinition } from "../runner.js";
import { DEFAULT_SCAN_OPTIONS, decideScan, scanJob, type ScanDecision, type ScanKind, type ScanOptions, type PendingUpload } from "./scan-pipeline.js";

/**
 * resume-scan (design A6.5 "Uploads", B6): promotes uploaded resumes to
 * clean/resumes/<id> once GuardDuty Malware Protection for S3 has tagged them.
 * The pipeline and its state machine are shared with paperwork documents
 * (scan-pipeline.ts); a clean resume also becomes the candidate's current
 * version (authz.resume_scan_finish, migration 0036). Audited resume.scanned.
 */
export type ResumeScanOptions = ScanOptions;
export const DEFAULT_RESUME_SCAN_OPTIONS: ResumeScanOptions = DEFAULT_SCAN_OPTIONS;
export { decideScan, type ScanDecision };

export const RESUME_SCAN: ScanKind<PendingUpload> = {
  job: "resume-scan",
  idField: "resumeId",
  noun: "resume",
  queueSql: `SELECT * FROM authz.resume_scan_queue($1, $2)`,
  finishSql: `SELECT authz.resume_scan_finish($1, $2, $3, $4, $5) AS s`,
  audit: { action: "resume.scanned", entityType: "resume" },
  maxBytes: RESUME_MAX_BYTES,
  quarantineKey: (row) => resumeQuarantineKey(row.id),
  promotedKey: (row) => resumeCleanKey(row.id),
  // Type, magic bytes and active content (macros, external templates, PDF JavaScript...): content-inspect.ts.
  inspect: (contentType, body) => (isResumeContentType(contentType) ? inspectResume(body, contentType) : "BAD_CONTENT"),
};

export function resumeScanJob(store: DocumentStore, opts: ResumeScanOptions = DEFAULT_RESUME_SCAN_OPTIONS): JobDefinition {
  return scanJob(RESUME_SCAN, store, opts);
}
