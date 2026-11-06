import type { Permission, Scope } from "./catalog.js";
import {
  MARKETABLE_STATUSES,
  activityVisible,
  candidateVisible,
  grantsOf,
  ownsCandidate,
  resolveScope,
  type ActivityRef,
  type CandidateRef,
  type EffectiveScope,
  type UserAccess,
} from "./engine.js";

/**
 * "Why can this user see this record?" (docs/admin-api.md AD-16). Pure: explains,
 * role by role, which grant and which fact of the record make it visible to a
 * user, using exactly the rules of candidateVisible / activityVisible. The
 * verdict (`allowed`) always equals what those functions return; the paths only
 * say why. Ids only: callers resolve names for display.
 */

export const EXPLAIN_KINDS = ["candidate", "submission", "interview", "placement"] as const;
export type ExplainKind = (typeof EXPLAIN_KINDS)[number];

/** The read permission each record kind is checked against. */
export const EXPLAIN_PERMISSION: Record<ExplainKind, Permission> = {
  candidate: "candidate:read",
  submission: "submission:read",
  interview: "interview:read",
  placement: "placement:read",
};

/** Which part of the record a path matched: the activity's actor snapshot or the candidate's owners. */
export type ExplainSubject = "record" | "candidate";

export type AccessPath =
  /** An org-wide grant. */
  | { via: "org" }
  /** The user is the recruiter on the record (own, team or hierarchy grants include oneself). */
  | { via: "self"; on: ExplainSubject }
  /** The recruiter on the record reports to the user (hierarchy grant). */
  | { via: "report"; on: ExplainSubject; userId: string }
  /** The record's team is one the user leads, belongs to, coaches, or that is led below them. */
  | { via: "team"; on: ExplainSubject; teamId: string }
  /** The record's location is the location of a location-bound role. */
  | { via: "location"; on: ExplainSubject; locationId: string }
  /** Candidate is "Open to all teams" and marketable; the role is a Sales role. */
  | { via: "all_teams" }
  /** Candidate is shared with one of the user's teams ("Selected teams") and marketable. */
  | { via: "selected_teams" };

/** Why a role that holds the permission still does not cover the record. */
export type MissReason =
  /** Visible to all teams, but not in a marketable status, so the all-teams rule does not apply. */
  | "open_to_all_not_marketable"
  /** Open to all teams / shared, but the role is not a Sales role (the rule is for Sales only). */
  | "open_to_all_not_sales"
  /** Activities are never revealed by the all-teams rule alone. */
  | "open_to_all_not_for_activity"
  /** None of the role's scope facts (recruiters, teams, locations) match the record. */
  | "out_of_scope";

export interface RoleExplanation {
  role: string;
  label?: string;
  locationId?: string;
  /** The role's grant for the permission; null when the role does not hold it. */
  scope: Scope | null;
  paths: AccessPath[];
  /** Set when the role holds the permission but grants no path. */
  miss?: MissReason;
}

export interface Explanation {
  permission: Permission;
  allowed: boolean;
  roles: RoleExplanation[];
  /** Candidate kind only: whether the phone shows in full (candidate.phone:read through ownership). */
  phone?: "full" | "masked" | "none";
}

function ownerPaths(user: UserAccess, scope: EffectiveScope, on: ExplainSubject,
  r: { recruiterId: string | null; teamId: string | null; locationId: string | null }): AccessPath[] {
  if (scope.all) return [{ via: "org" }];
  const out: AccessPath[] = [];
  if (r.recruiterId !== null && scope.recruiterIds.has(r.recruiterId)) {
    out.push(r.recruiterId === user.userId ? { via: "self", on } : { via: "report", on, userId: r.recruiterId });
  }
  if (r.teamId !== null && scope.teamIds.has(r.teamId)) out.push({ via: "team", on, teamId: r.teamId });
  if (r.locationId !== null && scope.locationIds.has(r.locationId)) out.push({ via: "location", on, locationId: r.locationId });
  return out;
}

/** Paths through the "Open to all teams" / "Selected teams" rule, exactly as candidateVisible applies it. */
function shareRule(scope: EffectiveScope, c: CandidateRef): { paths: AccessPath[]; miss?: MissReason } {
  const shared = c.visibility === "all_teams"
    || (c.visibility === "selected_teams" && c.id !== undefined && scope.sharedCandidateIds.has(c.id));
  if (!shared) return { paths: [] };
  if (!scope.allTeams) return { paths: [], miss: "open_to_all_not_sales" };
  if (!MARKETABLE_STATUSES.has(c.marketingStatus)) return { paths: [], miss: "open_to_all_not_marketable" };
  return { paths: [c.visibility === "all_teams" ? { via: "all_teams" } : { via: "selected_teams" }] };
}

function perRole(user: UserAccess, permission: Permission,
  fn: (scope: EffectiveScope) => { paths: AccessPath[]; miss?: MissReason }): RoleExplanation[] {
  return user.roles.map((a) => {
    const granted = grantsOf(a)[permission] ?? null;
    const base: RoleExplanation = {
      role: a.role, scope: granted, paths: [],
      ...(a.label !== undefined ? { label: a.label } : {}),
      ...(a.locationId !== undefined ? { locationId: a.locationId } : {}),
    };
    if (granted === null) return base;
    const scope = resolveScope({ ...user, roles: [a] }, permission, "team");
    if (!scope) return base;
    const { paths, miss } = fn(scope);
    return paths.length ? { ...base, paths } : { ...base, miss: miss ?? "out_of_scope" };
  });
}

export function explainCandidate(user: UserAccess, c: CandidateRef): Explanation {
  const permission = EXPLAIN_PERMISSION.candidate;
  const roles = perRole(user, permission, (scope) => {
    const owned = ownerPaths(user, scope, "candidate", c);
    if (owned.length) return { paths: owned };
    return shareRule(scope, c);
  });
  const phoneScope = resolveScope(user, "candidate.phone:read");
  const allowed = candidateVisible(resolveScope(user, permission), c);
  return {
    permission,
    allowed,
    roles,
    phone: !allowed ? "none" : phoneScope !== null && ownsCandidate(phoneScope, c) ? "full" : "masked",
  };
}

export function explainActivity(user: UserAccess, kind: Exclude<ExplainKind, "candidate">, a: ActivityRef): Explanation {
  const permission = EXPLAIN_PERMISSION[kind];
  const roles = perRole(user, permission, (scope) => {
    const paths = [...ownerPaths(user, scope, "record", a), ...ownerPaths(user, scope, "candidate", a.candidate)];
    // De-duplicate: an org grant matches both subjects.
    const unique = paths.filter((p, i) => paths.findIndex((q) => JSON.stringify(q) === JSON.stringify(p)) === i);
    if (unique.length) return { paths: unique };
    const c = a.candidate;
    const shared = c.visibility === "all_teams" || (c.visibility === "selected_teams" && c.id !== undefined && scope.sharedCandidateIds.has(c.id));
    return { paths: [], ...(shared ? { miss: "open_to_all_not_for_activity" as const } : {}) };
  });
  return { permission, allowed: activityVisible(resolveScope(user, permission), a), roles };
}
