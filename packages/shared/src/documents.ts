import { ownsCandidate, resolveScope, type CandidateRef, type UserAccess } from "./authz/engine.js";

/**
 * Upload rules for candidate resumes (FR-CAN-07; design A6.5 "Uploads").
 * Shared by the API (presigned POST conditions), the worker (checks after the
 * malware scan) and the web app (early feedback). Migration 0036 enforces the
 * same type list and size cap in the database.
 */

/** 15 MB cap (design A6.5: content-length-range 15 MB). */
export const RESUME_MAX_BYTES = 15 * 1024 * 1024;

export const RESUME_CONTENT_TYPES = {
  "application/pdf": { ext: "pdf", label: "PDF" },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { ext: "docx", label: "Word (.docx)" },
} as const;

export type ResumeContentType = keyof typeof RESUME_CONTENT_TYPES;

export const RESUME_CONTENT_TYPE_LIST = Object.keys(RESUME_CONTENT_TYPES) as ResumeContentType[];

export function isResumeContentType(v: string): v is ResumeContentType {
  return Object.prototype.hasOwnProperty.call(RESUME_CONTENT_TYPES, v);
}

/** pending: waiting for the upload or the malware scan; only clean resumes can be downloaded. */
export const RESUME_STATUSES = ["pending", "clean", "infected", "failed", "rejected", "expired"] as const;
export type ResumeStatus = (typeof RESUME_STATUSES)[number];

/**
 * Resume access for a candidate the caller can read (design B4.4 "Documents"):
 * document:read / document:upload covering the candidate through ownership,
 * team, hierarchy, location or org; the Open-to-all-teams rule never applies.
 * Mirrors the resume_read policy and authz.create_resume_upload (migration 0036).
 */
export function resumeAccess(user: UserAccess, c: CandidateRef): { read: boolean; upload: boolean } {
  const read = resolveScope(user, "document:read");
  const upload = resolveScope(user, "document:upload");
  return {
    read: read !== null && ownsCandidate(read, c),
    upload: upload !== null && ownsCandidate(upload, c),
  };
}

// ---------------------------------------------------------------------------
// Paperwork and compliance documents (FR-PPR-01 to 03; design A6.3, A6.5,
// B2.4 `document` / `file_object`, B4.4 "Documents"). Migration 0043 holds the
// same type list in authz.document_type (a test compares the two).

/** Allowlisted upload types (design A6.5): PDF, DOCX, PNG, JPEG. */
export const DOCUMENT_CONTENT_TYPES = {
  "application/pdf": { ext: "pdf", label: "PDF" },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { ext: "docx", label: "Word (.docx)" },
  "image/png": { ext: "png", label: "PNG image" },
  "image/jpeg": { ext: "jpg", label: "JPEG image" },
} as const;
export type DocumentContentType = keyof typeof DOCUMENT_CONTENT_TYPES;
export const DOCUMENT_CONTENT_TYPE_LIST = Object.keys(DOCUMENT_CONTENT_TYPES) as DocumentContentType[];
export function isDocumentContentType(v: string): v is DocumentContentType {
  return Object.prototype.hasOwnProperty.call(DOCUMENT_CONTENT_TYPES, v);
}
/** 15 MB cap (design A6.5). */
export const DOCUMENT_MAX_BYTES = 15 * 1024 * 1024;

export const DOCUMENT_CLASSIFICATIONS = ["internal", "restricted"] as const;
export type DocumentClassification = (typeof DOCUMENT_CLASSIFICATIONS)[number];

/**
 * Document types: stable keys that the paperwork checklist (`doc_type`) and
 * API clients reference. The classification belongs to the type and is copied
 * onto each document when it is created; a client never chooses it.
 * Restricted per design A6.3: I-9, driving license, work-authorization copies.
 * The internal list is a placeholder until the paperwork checklist content is
 * decided (docs/phase2-status.md, open question). Adding a type is a
 * migration (INSERT INTO authz.document_type) plus an entry here.
 */
export const DOCUMENT_TYPES = {
  i9: { label: "Form I-9", classification: "restricted" },
  drivers_license: { label: "Driving license", classification: "restricted" },
  work_authorization: { label: "Work authorization copy", classification: "restricted" },
  offer_letter: { label: "Offer letter", classification: "internal" },
  other: { label: "Other document", classification: "internal" },
} as const satisfies Record<string, { label: string; classification: DocumentClassification }>;
export type DocumentType = keyof typeof DOCUMENT_TYPES;
export const DOCUMENT_TYPE_LIST = Object.keys(DOCUMENT_TYPES) as DocumentType[];
export function isDocumentType(v: string): v is DocumentType {
  return Object.prototype.hasOwnProperty.call(DOCUMENT_TYPES, v);
}

/** Scan states of a document's file: the same pipeline and meaning as resumes. */
export const DOCUMENT_FILE_STATUSES = RESUME_STATUSES;
export type DocumentFileStatus = ResumeStatus;

/**
 * Document access for a candidate the caller can read (design B4.4
 * "Documents"): document:read / document:upload covering the candidate
 * through ownership, team, hierarchy, location or org (never the all-teams
 * rule); restricted documents additionally need document.restricted:read over
 * the candidate, both to see them and to upload them. Opening a restricted
 * file also needs a fresh step-up (A6.1), which is session state, not access.
 * Mirrors the document_read policy and authz.create_document_upload (0043).
 */
export function documentAccess(user: UserAccess, c: CandidateRef): {
  read: boolean; upload: boolean; readRestricted: boolean; uploadRestricted: boolean;
} {
  const covers = (p: "document:read" | "document:upload" | "document.restricted:read") => {
    const s = resolveScope(user, p);
    return s !== null && ownsCandidate(s, c);
  };
  const read = covers("document:read");
  const upload = covers("document:upload");
  const restricted = covers("document.restricted:read");
  return { read, upload, readRestricted: read && restricted, uploadRestricted: upload && restricted };
}
