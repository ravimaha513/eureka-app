import { resolveScope, resolveScopeFor } from "@eureka/shared";
import type { AuthedUser } from "../../platform/auth.guard.js";

/**
 * AD-10 team rule for `team:add_member` (audit C-04: one copy for the add and
 * the remove): an org grant covers every team; otherwise the team the caller
 * leads, or a team a hierarchy grant covers. The definer functions
 * (authz.team_add_member, authz.team_remove_member) re-check it in the database.
 */
export function leadTeamCovered(user: Pick<AuthedUser, "id" | "access">, teamId: string, leadId: string): boolean {
  return !!resolveScope(user.access, "team:add_member")?.all
    || leadId === user.id
    || !!resolveScopeFor(user.access, "team:add_member", ["hierarchy"])?.teamIds.has(teamId);
}

/** The `team:add_member` reach for listing (GET /teams/mine): every team, or these hierarchy teams plus the ones led. */
export function leadTeamReach(user: Pick<AuthedUser, "access">): { all: boolean; hierarchyTeamIds: string[] } {
  return {
    all: !!resolveScope(user.access, "team:add_member")?.all,
    hierarchyTeamIds: [...(resolveScopeFor(user.access, "team:add_member", ["hierarchy"])?.teamIds ?? [])],
  };
}
