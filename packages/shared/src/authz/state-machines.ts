/**
 * State machines (design B2.6). The database enforces each one independently
 * (authz.transition_candidate, authz.transition_submission,
 * authz.transition_placement); these copies drive API pre-checks and the
 * per-record action hints, so they must match the SQL exactly.
 */

// ---------- candidate (manual transitions, migration 0015/0022) ----------

export const CANDIDATE_STATUSES = [
  "in_training", "active", "on_hold", "stopped", "full_of_interviews",
  "confirmation", "placed", "bench", "terminated",
] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

/**
 * Transitions a user may request through POST /candidates/:id/transition.
 * `placed` and `bench` are reached only through placements (PL-5).
 */
const CANDIDATE_MANUAL: Partial<Record<string, readonly CandidateStatus[]>> = {
  in_training: ["active", "terminated"],
  active: ["on_hold", "stopped", "full_of_interviews", "confirmation", "terminated"],
  on_hold: ["active", "terminated"],
  full_of_interviews: ["active", "terminated"],
  confirmation: ["active", "terminated"],
  bench: ["active", "terminated"],
  stopped: ["terminated"],
};

export function candidateTransitionAllowed(from: string, to: string): boolean {
  return CANDIDATE_MANUAL[from]?.includes(to as CandidateStatus) ?? false;
}

/** Manual targets; none while a placement is open (the placement drives the candidate). */
export function candidateTransitionTargets(from: string, hasOpenPlacement: boolean): CandidateStatus[] {
  if (hasOpenPlacement) return [];
  return [...(CANDIDATE_MANUAL[from] ?? [])];
}

// ---------- submission (migration 0017) ----------

export const SUBMISSION_STATUSES = [
  "submitted", "under_review", "interview_requested", "interview_scheduled",
  "interview_completed", "selected", "rejected", "withdrawn",
] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

export const TERMINAL_SUBMISSION_STATUSES: ReadonlySet<string> = new Set(["selected", "rejected", "withdrawn"]);

const SUBMISSION_FORWARD: Partial<Record<string, SubmissionStatus>> = {
  submitted: "under_review",
  under_review: "interview_requested",
  interview_requested: "interview_scheduled",
  interview_scheduled: "interview_completed",
  interview_completed: "selected",
};

export function submissionTransitionAllowed(from: string, to: string): boolean {
  if (TERMINAL_SUBMISSION_STATUSES.has(from)) return false;
  if (!(SUBMISSION_STATUSES as readonly string[]).includes(from)) return false;
  if (to === "rejected" || to === "withdrawn") return true;
  return SUBMISSION_FORWARD[from] === to;
}

export function submissionTransitionTargets(from: string): SubmissionStatus[] {
  return SUBMISSION_STATUSES.filter((to) => submissionTransitionAllowed(from, to));
}

// ---------- placement (migration 0022, PL-4) ----------

export const PLACEMENT_STATUSES = ["confirmed", "paperwork", "bgc", "ready", "joined", "backout", "bgc_failed"] as const;
export type PlacementStatus = (typeof PLACEMENT_STATUSES)[number];

/** Pre-join states: the placement is open and drives the candidate. */
export const OPEN_PLACEMENT_STATUSES: ReadonlySet<string> = new Set(["confirmed", "paperwork", "bgc", "ready"]);

const PLACEMENT_FORWARD: Partial<Record<string, PlacementStatus>> = {
  confirmed: "paperwork",
  paperwork: "bgc",
  bgc: "ready",
  ready: "joined",
};

export function placementTransitionAllowed(from: string, to: string): boolean {
  if (PLACEMENT_FORWARD[from] === to) return true;
  if (to === "backout") return OPEN_PLACEMENT_STATUSES.has(from);
  if (to === "bgc_failed") return OPEN_PLACEMENT_STATUSES.has(from) || from === "joined";
  return false;
}

export function placementTransitionTargets(from: string): PlacementStatus[] {
  return PLACEMENT_STATUSES.filter((to) => placementTransitionAllowed(from, to));
}

/** Transitions that need a non-blank reason (reason_required). */
export const PLACEMENT_REASON_REQUIRED: ReadonlySet<string> = new Set(["backout", "bgc_failed"]);

/** Candidate statuses from which a placement may be created (PL-5 moves them to confirmation). */
export const PLACEABLE_CANDIDATE_STATUSES: ReadonlySet<string> = new Set(["active", "full_of_interviews"]);

// ---------- paperwork checklist items (migration 0044, docs/paperwork-api.md PW-2) ----------

export const CHECKLIST_ITEM_STATUSES = ["pending", "received", "verified", "waived"] as const;
export type ChecklistItemStatus = (typeof CHECKLIST_ITEM_STATUSES)[number];

/** Items still needing work (counted as outstanding; overdue when past their due date). */
export const OUTSTANDING_CHECKLIST_STATUSES: ReadonlySet<string> = new Set(["pending", "received"]);

const CHECKLIST_EDGES: Partial<Record<string, readonly ChecklistItemStatus[]>> = {
  pending: ["received", "waived"],
  // back to pending = returned (e.g. illegible or wrong document)
  received: ["verified", "waived", "pending"],
  // back to pending = reopened
  verified: ["pending"],
  waived: ["pending"],
};

export function checklistItemTransitionAllowed(from: string, to: string): boolean {
  return CHECKLIST_EDGES[from]?.includes(to as ChecklistItemStatus) ?? false;
}

export function checklistItemTransitionTargets(from: string): ChecklistItemStatus[] {
  return [...(CHECKLIST_EDGES[from] ?? [])];
}

/** Waiving, returning and reopening need a non-blank reason (reason_required). */
export const CHECKLIST_REASON_REQUIRED: ReadonlySet<string> = new Set(["waived", "pending"]);

// ---------- background checks (migration 0044, PW-7; design B2.4 `bgc`) ----------

export const BGC_STATUSES = ["not_started", "initiated", "in_progress", "cleared", "failed"] as const;
export type BgcStatus = (typeof BGC_STATUSES)[number];

const BGC_EDGES: Partial<Record<string, readonly BgcStatus[]>> = {
  not_started: ["initiated"],
  initiated: ["in_progress", "cleared", "failed"],
  in_progress: ["cleared", "failed"],
  // FR-PLC-06: a cleared check can still fail after the fact; failed is final.
  cleared: ["failed"],
};

export function bgcTransitionAllowed(from: string, to: string): boolean {
  return BGC_EDGES[from]?.includes(to as BgcStatus) ?? false;
}

export function bgcTransitionTargets(from: string): BgcStatus[] {
  return [...(BGC_EDGES[from] ?? [])];
}

/** Recording a failed check needs a non-blank reason. */
export const BGC_REASON_REQUIRED: ReadonlySet<string> = new Set(["failed"]);
