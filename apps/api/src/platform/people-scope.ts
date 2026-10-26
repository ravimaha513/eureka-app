import { resolveScope, type Permission, type UserAccess } from "@eureka/shared";

/**
 * People pickers follow the reporting structure for sales roles: a caller whose
 * grant for `perm` is own/team/hierarchy only sees the people that grant covers
 * (authz.scope_user_ids: their team, or their reporting subtree). Org and
 * location grants keep the unscoped list, so this returns null for them, and
 * for callers without the grant (the caller decides what that means).
 */
export function pickerScopePerm(access: UserAccess, perm: Permission): Permission | null {
  const s = resolveScope(access, perm);
  return s && !s.all && s.locationIds.size === 0 ? perm : null;
}

/** `col` is a user in scope_user_ids(perm), as an InitPlan (rule 3). Pushes perm onto params. */
export function inPickerScope(col: string, perm: Permission, params: unknown[]): string {
  params.push(perm);
  return `${col} = ANY ((SELECT authz.scope_user_ids($${params.length}))::uuid[])`;
}
