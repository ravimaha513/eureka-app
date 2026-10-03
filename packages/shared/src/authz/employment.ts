import { ownsActivity, resolveScope, type ActivityRef, type UserAccess } from "./engine.js";

/**
 * Employees and the assignment lifecycle (FR-EMP-01..09, migration 0045,
 * docs/employees-api.md). The database enforces every rule in its definer
 * functions; these copies drive API pre-checks and the per-record action hints,
 * so they must match the SQL.
 *
 *   on_assignment --(assignment ends: project exit or BGC failed)--> bench
 *   bench --(exit)--> exited
 *   bench | exited --(a new placement joins)--> on_assignment
 *   bench --(return to market: candidate bench -> active)--> bench (Sales places them again)
 */
export const EMPLOYEE_STATUSES = ["on_assignment", "bench", "exited"] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

/** Reasons a user may give when ending an assignment (project exit). `bgc_failed` comes only from placements. */
export const ASSIGNMENT_END_REASONS = ["completed", "terminated", "resigned"] as const;
export type AssignmentEndReason = (typeof ASSIGNMENT_END_REASONS)[number];
/** Every value of assignment.end_reason (migration 0022 CHECK). */
export const ALL_ASSIGNMENT_END_REASONS = [...ASSIGNMENT_END_REASONS, "bgc_failed"] as const;

export const EMPLOYEE_EXIT_REASONS = ["resigned", "terminated", "other"] as const;
export type EmployeeExitReason = (typeof EMPLOYEE_EXIT_REASONS)[number];

export interface EmployeeActions {
  /** Project exit of the open assignment (end date + reason; employee -> bench). */
  endAssignment: boolean;
  /** Set or change the planned end date of the open assignment (extension). */
  setEndDate: boolean;
  /** Bench -> exited. */
  exit: boolean;
  /** Bench employee back to marketing (candidate bench -> active) so Sales can place them again. */
  returnToMarket: boolean;
}

export const NO_EMPLOYEE_ACTIONS: EmployeeActions = { endAssignment: false, setEndDate: false, exit: false, returnToMarket: false };

export interface EmployeeState {
  status: string;
  /** The open assignment exists (end date not set). */
  hasOpenAssignment: boolean;
  /** end_reason of the latest assignment (null while open). */
  lastEndReason: string | null;
  /** The candidate's marketing status as the caller reads it (null when not readable). */
  candidateStatus: string | null;
}

/**
 * May the caller write employment data for an employee whose latest assignment
 * belongs to the placement with this actor snapshot? Mirrors
 * authz.employee_for_update / authz.assignment_for_update: employee:read at org
 * scope (B4.4) and assignment:update on the actor snapshot.
 */
export function canManageEmployment(user: UserAccess, latest: Pick<ActivityRef, "recruiterId" | "teamId" | "locationId"> | null): boolean {
  if (!latest) return false;
  if (!resolveScope(user, "employee:read")?.all) return false;
  return ownsActivity(resolveScope(user, "assignment:update"), latest);
}

/** Per-record hints for the Employees screen (presentation only; the server checks again). */
export function employeeActions(
  user: UserAccess,
  latest: Pick<ActivityRef, "recruiterId" | "teamId" | "locationId"> | null,
  s: EmployeeState,
): EmployeeActions {
  if (!canManageEmployment(user, latest)) return NO_EMPLOYEE_ACTIONS;
  const onAssignment = s.status === "on_assignment" && s.hasOpenAssignment;
  const bench = s.status === "bench" && !s.hasOpenAssignment;
  return {
    endAssignment: onAssignment,
    setEndDate: onAssignment,
    exit: bench,
    returnToMarket: bench && s.lastEndReason !== "bgc_failed" && s.candidateStatus === "bench",
  };
}
