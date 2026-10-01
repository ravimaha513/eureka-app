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
  candidateTransitionTargets,
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
