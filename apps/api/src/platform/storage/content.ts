import {
  DOCUMENT_CONTENT_TYPES, RESUME_CONTENT_TYPES, isDocumentType,
  type DocumentClassification, type DocumentContentType, type ResumeContentType,
} from "@eureka/shared";

/**
 * Object keys of the documents bucket (infra/modules/stack/storage.tf). The
 * client never chooses a key: it is derived from the server-generated row id.
 *   quarantine/resumes/<id>  presigned POST target; scanned by GuardDuty
 *   clean/resumes/<id>       written by the worker after a clean scan
 *   quarantine/documents/<file id>   paperwork and compliance uploads
 *   clean/documents/<file id>        internal documents after a clean scan
 *   restricted/documents/<file id>   restricted documents (I-9, driving
 *                            license, work authorization) after a clean scan,
 *                            under the restricted KMS key; signed for HR,
 *                            Accounts and Immigration after step-up only
 * Downloads are signed for clean/ and restricted/ only.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function checkId(id: string): string {
  if (!UUID.test(id)) throw new Error("invalid document id");
  return id;
}

export const resumeQuarantineKey = (id: string) => `quarantine/resumes/${checkId(id)}`;
export const resumeCleanKey = (id: string) => `clean/resumes/${checkId(id)}`;

export const documentQuarantineKey = (fileId: string) => `quarantine/documents/${checkId(fileId)}`;
/** Where a clean file lives: the classification decides the prefix (and, in S3, the KMS key). */
export const documentStoredKey = (fileId: string, classification: DocumentClassification) =>
  `${classification === "restricted" ? "restricted" : "clean"}/documents/${checkId(fileId)}`;

/** Download name: the document type and a short id, never the uploaded file name. */
export function documentDownloadName(docType: string, documentId: string, contentType: DocumentContentType): string {
  if (!isDocumentType(docType)) throw new Error("unknown document type");
  return `${docType.replace(/_/g, "-")}-${checkId(documentId).slice(0, 8)}.${DOCUMENT_CONTENT_TYPES[contentType].ext}`;
}

/** Download name: ids and version only, never the uploaded file name. */
export const resumeDownloadName = (version: number, contentType: ResumeContentType) =>
  `resume-v${version}.${RESUME_CONTENT_TYPES[contentType].ext}`;

// Content checks after the scan (type, magic bytes, active content): content-inspect.ts.
