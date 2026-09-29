import {
  GRANTS,
  HOTLIST_STATUSES,
  HOTLIST_VISIBILITY,
  SALES_ROLES,
  type Permission,
  type Role,
} from "./catalog.js";

/**
 * Application-layer authorization engine (design B4). Pure functions: no I/O.
 * The database enforces the same rules independently through RLS policies that
 * compute scope from its own tables (design B4.5); differential tests compare
 * the two layers.
 */

export interface RoleAssignment {
  role: Role;
  /** Required for location-bound roles. */
  locationId?: string;
}

/** Everything about a user that scope resolution needs, loaded once per request. */
export interface UserAccess {
  userId: string;
  roles: RoleAssignment[];
  /** Teams the user belongs to as a member (recruiter) or leads. */
  teamIds: string[];
  /** Users below this user in the reporting hierarchy (excluding the user). */
  subordinateUserIds: string[];
  /** Teams led by this user or by anyone below them. */
  subtreeTeamIds: string[];
  /** Teams this user supports as an Interview Coach. */
  coachedTeamIds: string[];
}

export interface EffectiveScope {
  all: boolean;
  recruiterIds: ReadonlySet<string>;
  teamIds: ReadonlySet<string>;
  locationIds: ReadonlySet<string>;
  /** Candidates marked "Open to all teams" are visible (Sales roles only). */
  allTeams: boolean;
  /** hotlist:read only: every Hot List candidate is visible (HOTLIST_VISIBILITY = "everyone"). */
  hotlistOpen: boolean;
}

const HOTLIST_STATUS_SET: ReadonlySet<string> = new Set(HOTLIST_STATUSES);

/** Statuses in which an "Open to all teams" candidate is shown to other teams. */
export const MARKETABLE_STATUSES = new Set(["active", "full_of_interviews"]);

/** Permissions to which the "Open to all teams" rule applies. */
const ALL_TEAMS_PERMISSIONS = new Set<Permission>([
  "candidate:read",
  "hotlist:read",
  "submission:create",
  "placement:create",
]);

/**
 * Resolve the union of all grants the user holds for a permission.
 * Returns null when the user holds no grant (deny).
 */
export function resolveScope(
  user: UserAccess,
  permission: Permission,
  hotlistVisibility: "everyone" | "team" = HOTLIST_VISIBILITY,
): EffectiveScope | null {
  const hotlistOpen = permission === "hotlist:read" && hotlistVisibility === "everyone";
  const recruiterIds = new Set<string>();
  const teamIds = new Set<string>();
  const locationIds = new Set<string>();
  let all = false;
  let granted = false;
  let allTeams = false;

  for (const assignment of user.roles) {
    const scope = GRANTS[assignment.role][permission];
    if (!scope) continue;
    granted = true;
    if (ALL_TEAMS_PERMISSIONS.has(permission) && SALES_ROLES.includes(assignment.role)) {
      allTeams = true;
    }
    switch (scope) {
      case "own":
        recruiterIds.add(user.userId);
        break;
      case "team":
        recruiterIds.add(user.userId);
        user.teamIds.forEach((t) => teamIds.add(t));
        break;
      case "coached":
        user.coachedTeamIds.forEach((t) => teamIds.add(t));
        break;
      case "hierarchy":
        recruiterIds.add(user.userId);
        user.subordinateUserIds.forEach((u) => recruiterIds.add(u));
        user.teamIds.forEach((t) => teamIds.add(t));
        user.subtreeTeamIds.forEach((t) => teamIds.add(t));
        break;
      case "location":
        if (!assignment.locationId) {
          throw new Error(`Role ${assignment.role} requires a location`);
        }
        locationIds.add(assignment.locationId);
        break;
      case "org":
        all = true;
        break;
    }
  }

  if (!granted && !hotlistOpen) return null;
  return { all, recruiterIds, teamIds, locationIds, allTeams, hotlistOpen };
}

export function can(user: UserAccess, permission: Permission): boolean {
  return resolveScope(user, permission) !== null;
}

export interface CandidateRef {
  recruiterId: string | null;
  teamId: string | null;
  locationId: string | null;
  visibility: "team" | "all_teams";
  marketingStatus: string;
}

/** Visible through ownership, team, hierarchy, location or org (not the all-teams rule). */
export function ownsCandidate(scope: EffectiveScope, c: CandidateRef): boolean {
  return (
    scope.all ||
    (c.recruiterId !== null && scope.recruiterIds.has(c.recruiterId)) ||
    (c.teamId !== null && scope.teamIds.has(c.teamId)) ||
    (c.locationId !== null && scope.locationIds.has(c.locationId))
  );
}

export function candidateVisible(scope: EffectiveScope | null, c: CandidateRef): boolean {
  if (!scope) return false;
  if (ownsCandidate(scope, c)) return true;
  return (
    scope.allTeams && c.visibility === "all_teams" && MARKETABLE_STATUSES.has(c.marketingStatus)
  );
}

/** Hot List membership for a hotlist:read scope. */
export function hotlistVisible(scope: EffectiveScope | null, c: CandidateRef): boolean {
  if (!scope || !HOTLIST_STATUS_SET.has(c.marketingStatus)) return false;
  return scope.hotlistOpen || candidateVisible(scope, c);
}

/** Submissions, interviews and placements carry a snapshot of the acting team. */
export interface ActivityRef {
  recruiterId: string;
  teamId: string | null;
  locationId: string | null;
  candidate: CandidateRef;
}

/**
 * An activity is visible to the actor's hierarchy, and to the hierarchy that
 * owns the candidate (so owners see other teams' submissions of their
 * candidate). The all-teams rule alone does not reveal other teams' activity.
 */
export function activityVisible(scope: EffectiveScope | null, a: ActivityRef): boolean {
  if (!scope) return false;
  if (scope.all) return true;
  if (scope.recruiterIds.has(a.recruiterId)) return true;
  if (a.teamId !== null && scope.teamIds.has(a.teamId)) return true;
  if (a.locationId !== null && scope.locationIds.has(a.locationId)) return true;
  return ownsCandidate(scope, a.candidate);
}

export interface CandidateFields {
  phone: string | null;
  dob: string | null;
}

export interface MaskedCandidateFields {
  phone: string | null;
  phoneMasked: boolean;
  dob: string | null;
  dobMasked: string | null;
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return `•••-•••-${digits.slice(-2).padStart(2, "•")}`;
}

/**
 * Field policy (design B4.6). Phone needs candidate.phone:read covering the
 * candidate through ownership; a candidate seen only through the all-teams rule
 * shows a masked phone. DOB needs candidate.dob:read.
 */
export function applyCandidateFieldPolicy(
  user: UserAccess,
  c: CandidateRef,
  fields: CandidateFields,
): MaskedCandidateFields {
  const phoneScope = resolveScope(user, "candidate.phone:read");
  const phoneAllowed = phoneScope !== null && ownsCandidate(phoneScope, c);
  const dobAllowed = resolveScope(user, "candidate.dob:read") !== null;
  return {
    phone: phoneAllowed ? fields.phone : fields.phone ? maskPhone(fields.phone) : null,
    phoneMasked: !phoneAllowed && fields.phone !== null,
    dob: dobAllowed ? fields.dob : null,
    dobMasked: !dobAllowed && fields.dob ? `•• / •• / ${fields.dob.slice(0, 4)}` : null,
  };
}

/** Capability list for the web app's navigation (presentation only). */
export function capabilities(
  user: UserAccess,
  hotlistVisibility: "everyone" | "team" = HOTLIST_VISIBILITY,
): Permission[] {
  const perms = new Set<Permission>();
  if (hotlistVisibility === "everyone") perms.add("hotlist:read");
  for (const a of user.roles) {
    for (const p of Object.keys(GRANTS[a.role]) as Permission[]) perms.add(p);
  }
  return [...perms].sort();
}
