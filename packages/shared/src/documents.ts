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
