import { candidateVisible, ownsCandidate, resolveScope, type CandidateRef, type UserAccess } from "./authz/engine.js";

/**
 * Work authorization records (FR-VIS-01 to 03; design B2.4, B4.4, B4.6;
 * migration 0042). Shared by the API (validation), the web app (labels) and
 * the tests. The database enforces the same type and status lists.
 */

/** Type labels. The list is a placeholder until Immigration confirms it (docs/HANDOFF.md open questions). */
export const WORK_AUTH_TYPES = {
  h1b: "H-1B",
  h4_ead: "H-4 EAD",
  l1: "L-1",
  l2_ead: "L-2 EAD",
  f1_opt: "F-1 OPT",
  f1_stem_opt: "F-1 STEM OPT",
  f1_cpt: "F-1 CPT",
  gc_ead: "EAD (green card pending)",
  green_card: "Green card",
  tn: "TN",
  o1: "O-1",
  other: "Other",
} as const;
export type WorkAuthType = keyof typeof WORK_AUTH_TYPES;
export const WORK_AUTH_TYPE_LIST = Object.keys(WORK_AUTH_TYPES) as WorkAuthType[];

/** pending: applied for, not yet granted; valid: granted (expiry notices apply); revoked: no longer valid. */
export const WORK_AUTH_STATUSES = ["pending", "valid", "revoked"] as const;
export type WorkAuthStatus = (typeof WORK_AUTH_STATUSES)[number];
export const WORK_AUTH_STATUS_LABELS: Record<WorkAuthStatus, string> = {
  pending: "Pending",
  valid: "Valid",
  revoked: "Revoked",
};

/** Default expiry notice thresholds in days before valid_to (design B6 visa-expiry). */
export const WORK_AUTH_EXPIRY_NOTICE_DAYS = [90, 60, 30] as const;

/** Outbox event the visa-expiry job emits (docs/work-authorization-api.md). */
export const WORK_AUTH_EXPIRING_EVENT = "work_authorization.expiring";

/** Shown instead of the number; the number itself only through the audited reveal. */
export const WORK_AUTH_NUMBER_MASK = "••••••••";

/** Upper-case letters, digits and hyphens, 1-40 characters, after normalizeWorkAuthNumber. */
export const WORK_AUTH_NUMBER_RE = /^[A-Z0-9][A-Z0-9-]{0,39}$/;

/** Trims, removes inner spaces and upper-cases (receipt, EAD card and I-94 numbers). */
export function normalizeWorkAuthNumber(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

/**
 * Access to a candidate's work authorization records. Conservative reading of
 * B4.4/B4.6 (docs/HANDOFF.md open question): the records are visible only with
 * visa:read covering the candidate through ownership, team, hierarchy,
 * location or org (HR and Immigration today), never through the
 * Open-to-all-teams rule; editing needs visa:update the same way. Mirrors the
 * work_authorization_read policy and authz.work_auth_create/update (0042).
 * Revealing the number is allowed to every reader (B4.6: visa:read), audited
 * and only after a recent sign-in (step-up).
 */
export function workAuthAccess(user: UserAccess, c: CandidateRef): { read: boolean; update: boolean } {
  if (!candidateVisible(resolveScope(user, "candidate:read"), c)) return { read: false, update: false };
  const read = resolveScope(user, "visa:read");
  const update = resolveScope(user, "visa:update");
  const canRead = read !== null && ownsCandidate(read, c);
  return { read: canRead, update: canRead && update !== null && ownsCandidate(update, c) };
}
