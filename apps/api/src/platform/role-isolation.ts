/**
 * The sheet-import role must never be able to become another Eureka role
 * (docs/import.md; migrations 0028, 0033, 0041). Checked by the restore drill
 * (src/db/restore-check.ts) and when the API starts (fail fast).
 */
export interface Queryable {
  query<R = unknown>(sql: string): Promise<{ rows: R[] }>;
}

/** Roles eureka_import is a member of among eureka_* and authz_definer (pg_auth_members is readable by every role). */
export async function importRoleMemberships(db: Queryable): Promise<string[]> {
  const { rows } = await db.query<{ role: string }>(
    `SELECT DISTINCT g.rolname AS role FROM pg_auth_members m
       JOIN pg_roles r ON r.oid = m.member JOIN pg_roles g ON g.oid = m.roleid
      WHERE r.rolname = 'eureka_import' AND (g.rolname LIKE 'eureka\\_%' OR g.rolname = 'authz_definer')
      ORDER BY 1`);
  return rows.map((r) => r.role);
}

export async function assertImportRoleIsolated(db: Queryable): Promise<void> {
  const roles = await importRoleMemberships(db);
  if (roles.length) {
    throw new Error(`eureka_import is a member of ${roles.join(", ")}; revoke it (see migration 0033) before starting`);
  }
}
