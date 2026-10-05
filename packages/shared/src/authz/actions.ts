import {
  candidateVisible,
  ownsActivity,
  ownsCandidate,
  resolveScope,
  resolveScopeFor,
  type ActivityRef,
  type CandidateRef,
  type UserAccess,
} from "./engine.js";
import {
  PLACEABLE_CANDIDATE_STATUSES,
  TERMINAL_SUBMISSION_STATUSES,
  bgcTransitionTargets,
  candidateTransitionTargets,
  checklistItemTransitionTargets,
  type BgcStatus,
  type ChecklistItemStatus,
  placementTransitionTargets,
  submissionTransitionTargets,
  type CandidateStatus,
  type PlacementStatus,
  type SubmissionStatus,
} from "./state-machines.js";

/**
 * Per-record action hints (docs/placements-api.md). Presentation only: the
 * server and the database enforce every rule again. Each hint mirrors the
 * check the corresponding write path performs.
 */

export interface CandidateActions {
  edit: boolean;
  transition: CandidateStatus[];
  visibility: boolean;
  rating: boolean;
  logSubmission: boolean;
}

const owns = (user: UserAccess, perm: Parameters<typeof resolveScope>[1], c: CandidateRef) => {
  const scope = resolveScope(user, perm);
  return scope !== null && ownsCandidate(scope, c);
};

/** For a candidate the caller can read (candidate:read). */
export function candidateActions(user: UserAccess, c: CandidateRef, hasOpenPlacement: boolean): CandidateActions {
  const edit = owns(user, "candidate:update", c);
  return {
    edit,
    transition: edit ? candidateTransitionTargets(c.marketingStatus, hasOpenPlacement) : [],
    visibility: owns(user, "candidate.visibility:update", c),
    rating: owns(user, "candidate.rating:update", c),
    logSubmission: candidateVisible(resolveScope(user, "submission:create"), c),
  };
}

export interface SubmissionActions {
  transition: SubmissionStatus[];
  createInterview: boolean;
  createPlacement: boolean;
}

/**
 * For a submission the caller can read. `candidate` is the candidate as the
 * caller sees it (null when the candidate is not readable to them).
 */
export function submissionActions(
  user: UserAccess,
  s: Pick<ActivityRef, "recruiterId" | "teamId" | "locationId">,
  status: string,
  candidate: CandidateRef | null,
): SubmissionActions {
  const canUpdate = ownsActivity(resolveScope(user, "submission:update"), s);
  return {
    transition: canUpdate ? submissionTransitionTargets(status) : [],
    createInterview: canUpdate && resolveScope(user, "interview:create") !== null && !TERMINAL_SUBMISSION_STATUSES.has(status),
    createPlacement:
      canUpdate &&
      status === "selected" &&
      ownsActivity(resolveScope(user, "placement:create"), s) &&
      candidate !== null &&
      PLACEABLE_CANDIDATE_STATUSES.has(candidate.marketingStatus) &&
      candidateVisible(resolveScope(user, "placement:create"), candidate),
  };
}

/** For a placement the caller can read. */
export function placementTransitions(
  user: UserAccess,
  p: Pick<ActivityRef, "recruiterId" | "teamId" | "locationId">,
  status: string,
): PlacementStatus[] {
  if (!ownsActivity(resolveScope(user, "placement:update"), p)) return [];
  const bgc = ownsActivity(resolveScope(user, "placement.bgc_status:update"), p);
  return placementTransitionTargets(status).filter((to) => to !== "bgc_failed" || bgc);
}

/**
 * Batch planning (FR-CAN-02): Sales leadership, i.e. candidate:create at team,
 * hierarchy or org scope; a recruiter's "own" grant does not qualify. Mirrors
 * authz.batch_manager() (migration 0026).
 */
export const BATCH_MANAGER_SCOPES = ["team", "hierarchy", "org"] as const;

export function canCreateBatch(user: UserAccess): boolean {
  return resolveScopeFor(user, "candidate:create", BATCH_MANAGER_SCOPES) !== null;
}

/**
 * Paperwork and BGC (migration 0044, docs/paperwork-api.md). A paperwork
 * record is covered for a permission through the placement's actor snapshot
 * or its owned candidate (never the all-teams rule); mirrors
 * authz.placement_covered. `candidate` is the candidate as the caller sees it
 * (null when they cannot read it).
 */
export interface PaperworkRef {
  recruiterId: string;
  teamId: string | null;
  locationId: string | null;
  candidate: CandidateRef | null;
}

export function paperworkCovered(user: UserAccess, perm: Parameters<typeof resolveScope>[1], r: PaperworkRef): boolean {
  const scope = resolveScope(user, perm);
  if (!scope) return false;
  return ownsActivity(scope, r) || (r.candidate !== null && ownsCandidate(scope, r.candidate));
}

export interface ChecklistItemActions {
  /** Status targets this caller may set now. */
  transition: ChecklistItemStatus[];
  /** Notes and the document link (document:upload or document:verify). */
  editNotes: boolean;
  /** Owner role, assignee and due date (document:verify). */
  assign: boolean;
}

/** `placementStatus` is null when the caller cannot read the placement (assumed open; the server checks). */
export function checklistItemActions(
  user: UserAccess, r: PaperworkRef, status: string, placementStatus: string | null,
): ChecklistItemActions {
  if (placementStatus === "backout") return { transition: [], editNotes: false, assign: false };
  const upload = paperworkCovered(user, "document:upload", r);
  const verify = paperworkCovered(user, "document:verify", r);
  return {
    transition: checklistItemTransitionTargets(status).filter((to) => (to === "received" ? upload || verify : verify)),
    editNotes: upload || verify,
    assign: verify,
  };
}

export interface BgcActions {
  update: boolean;
  transition: BgcStatus[];
  /**
   * Record `failed` and move the placement to bgc_failed in the same request.
   * Needs bgc:update and the placement rights authz.transition_placement checks.
   */
  failPlacement: boolean;
}

export function bgcActions(user: UserAccess, r: PaperworkRef, status: string, placementStatus: string | null): BgcActions {
  const update = placementStatus !== "backout" && paperworkCovered(user, "bgc:update", r);
  const canFail = status === "failed" || bgcTransitionTargets(status).includes("failed");
  return {
    update,
    transition: update ? bgcTransitionTargets(status) : [],
    failPlacement: update && canFail && placementStatus !== null
      && placementTransitions(user, r, placementStatus).includes("bgc_failed"),
  };
}

/** Template versions: readable with document:read at org scope; published with document:verify at org scope (PW-10). */
export function checklistTemplateAccess(user: UserAccess): { read: boolean; publish: boolean } {
  return {
    read: resolveScopeFor(user, "document:read", ["org"]) !== null,
    publish: resolveScopeFor(user, "document:verify", ["org"]) !== null,
  };
}
