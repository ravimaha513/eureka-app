import { GRANTS, type Permission } from "./catalog.js";
import { ownsCandidate, resolveScope, type CandidateRef, type UserAccess } from "./engine.js";
import { canCreateBatch } from "./actions.js";

/**
 * Training batches, courses and progress (docs/training-api.md, migration 0065).
 * Pure functions mirroring the database rules; the database checks again.
 */

export type TrainingPermission = "training:read" | "training:manage" | "training.progress:update";

/** What decides batch-level coverage: the batch's location and its trainer. */
export interface TrainingBatchRef {
  locationId: string;
  trainerId: string | null;
}

/**
 * Batch-level coverage (TR-2), mirrors authz.training_batch_ids(perm): an org
 * grant covers every batch, a location grant the batches of that location, a
 * coached grant the batches where the user is the trainer. Own, team and
 * hierarchy grants cover no batch (they reach single candidates, see
 * trainingCandidateCovered).
 */
export function trainingBatchCovered(user: UserAccess, perm: TrainingPermission, b: TrainingBatchRef): boolean {
  for (const a of user.roles) {
    const scope = GRANTS[a.role][perm as Permission];
    if (scope === "org") return true;
    if (scope === "location" && a.locationId === b.locationId) return true;
    if (scope === "coached" && b.trainerId !== null && b.trainerId === user.userId) return true;
  }
  return false;
}

/**
 * Candidate-level coverage for reading progress (TR-3): the candidate is owned
 * under training:read (own, team, hierarchy, coached teams, location, org;
 * never the Open-to-all-teams rule), mirrors authz.owned_candidate_ids.
 */
export function trainingCandidateCovered(user: UserAccess, c: CandidateRef): boolean {
  const scope = resolveScope(user, "training:read");
  return scope !== null && ownsCandidate(scope, c);
}

/** True when the user may manage training somewhere (course library, batches). */
export function canManageTraining(user: UserAccess): boolean {
  return resolveScope(user, "training:manage") !== null;
}

/**
 * May create batches somewhere: Sales leadership (canCreateBatch, migration
 * 0026) or a training manager (migration 0065). Mirrors the first check of
 * authz.create_batch; the location is checked there too.
 */
export function canPlanBatch(user: UserAccess): boolean {
  return canCreateBatch(user) || canManageTraining(user);
}

/** Locations where a training:manage grant applies; `all` for an org grant. */
export function trainingManageLocations(user: UserAccess): { all: boolean; locationIds: string[] } {
  const scope = resolveScope(user, "training:manage");
  return { all: scope?.all ?? false, locationIds: scope ? [...scope.locationIds] : [] };
}

export interface ProgressModule {
  courseId: string;
  moduleId: string;
  durationMinutes: number;
}

export interface CourseProgress {
  courseId: string;
  completedModules: number;
  totalModules: number;
  completedMinutes: number;
  totalMinutes: number;
  percent: number;
}

/**
 * Progress formula (TR-9), weighted by module duration:
 *   course %  = floor(100 × Σ minutes of completed modules of the course / Σ minutes of all its modules)
 *   overall % = floor(100 × Σ completed minutes over all assigned courses / Σ minutes of all their modules)
 * Rounded down, so 100 % means every module is done. A course without modules
 * is 0 % and adds nothing to the overall figure; no modules at all is 0 %.
 * Completions of modules outside `modules` (an unassigned course) are ignored.
 */
export function trainingProgress(modules: readonly ProgressModule[], completed: ReadonlySet<string>) {
  const byCourse = new Map<string, CourseProgress>();
  let done = 0, total = 0;
  for (const m of modules) {
    let c = byCourse.get(m.courseId);
    if (!c) {
      c = { courseId: m.courseId, completedModules: 0, totalModules: 0, completedMinutes: 0, totalMinutes: 0, percent: 0 };
      byCourse.set(m.courseId, c);
    }
    c.totalModules += 1;
    c.totalMinutes += m.durationMinutes;
    total += m.durationMinutes;
    if (completed.has(m.moduleId)) {
      c.completedModules += 1;
      c.completedMinutes += m.durationMinutes;
      done += m.durationMinutes;
    }
  }
  const pct = (a: number, b: number) => (b > 0 ? Math.floor((100 * a) / b) : 0);
  for (const c of byCourse.values()) c.percent = pct(c.completedMinutes, c.totalMinutes);
  return { courses: [...byCourse.values()], completedMinutes: done, totalMinutes: total, percent: pct(done, total) };
}

/** Display name of a batch (TR-5): its own name, else "<technology> <Mon YYYY>". */
export function batchDisplayName(name: string | null, technology: string, startMonth: string): string {
  if (name && name.trim()) return name.trim();
  const month = new Date(`${startMonth.slice(0, 7)}-01T00:00:00Z`)
    .toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  return `${technology} ${month}`;
}

/** Cover tints and icons shared by batches and courses (CHECK lists in migration 0065). */
export const TRAINING_COVER_COLORS = ["indigo", "teal", "amber", "rose", "violet", "sky"] as const;
export const TRAINING_COVER_ICONS = ["book", "code", "database", "cloud", "shield", "chart", "users", "cap"] as const;
