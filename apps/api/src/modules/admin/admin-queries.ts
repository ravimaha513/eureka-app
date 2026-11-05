import { NotFoundException } from "@nestjs/common";
import type pg from "pg";

/**
 * Read helpers shared by the admin services (audit C-04): roles as stored,
 * role labels, departments and coach assignments. Each runs on the caller's
 * transaction.
 */

/** A user's department with its parent, from the department_* / parent_* columns of a join. */
export const departmentOf = (r: { department_id: string | null; department_name: string | null; parent_id: string | null; parent_name: string | null }) =>
  r.department_id
    ? { id: r.department_id, name: r.department_name!, parent: r.parent_id ? { id: r.parent_id, name: r.parent_name! } : null }
    : null;

/** Roles as stored (docs/roles-api.md): system and custom, live and archived. */
export type RoleRow = {
  key: string; label: string; description: string | null; is_system: boolean; is_restricted: boolean;
  is_sales: boolean; is_location_bound: boolean; is_admin: boolean; is_recruiter: boolean; is_coach: boolean;
  track: string; level: number; department_id: string | null; department_name: string | null; cloned_from: string | null;
  archived_at: Date | null; holders: number; row_version: number;
  /** Admin separation class (authz.role_classes, migration 0510; docs/roles-api.md "Admin separation"). */
  classification: "admin" | "data" | "admin_compatible_only";
};
const ROLE_ROWS_SQL = `
  SELECT r.key, r.label, r.description, r.is_system, r.is_restricted, r.is_sales, r.is_location_bound, r.is_admin,
         r.is_recruiter, r.is_coach, r.track, r.level, r.department_id, d.name AS department_name, r.cloned_from, r.archived_at, r.row_version,
         (SELECT count(DISTINCT ur.user_id) FROM eureka.user_role ur JOIN eureka.app_user u ON u.id = ur.user_id
           WHERE ur.role_key = r.key AND ur.valid @> now() AND u.status = 'active')::int AS holders,
         rc.classification
  FROM eureka.role r LEFT JOIN eureka.department d ON d.id = r.department_id
  JOIN authz.role_classes() rc ON rc.role_key = r.key`;

export async function roleRows(c: pg.PoolClient): Promise<RoleRow[]> {
  return (await c.query<RoleRow>(`${ROLE_ROWS_SQL} ORDER BY r.track, r.level, r.label, r.key`)).rows;
}

/** One role as stored; 404 when there is none. */
export async function roleRow(c: pg.PoolClient, key: string): Promise<RoleRow> {
  const { rows } = await c.query<RoleRow>(`${ROLE_ROWS_SQL} WHERE r.key = $1`, [key]);
  if (!rows[0]) throw new NotFoundException();
  return rows[0];
}

/** Role key -> label, for lists that show a user's roles. */
export async function roleLabels(c: pg.PoolClient): Promise<Map<string, string>> {
  return new Map((await c.query<{ key: string; label: string }>(`SELECT key, label FROM eureka.role`)).rows.map((r) => [r.key, r.label]));
}

/** Current coach assignments, limited to the given coaches (null: everyone). */
export async function teamCoaches(c: pg.PoolClient, coachIds: string[] | null) {
  return (await c.query<{ team_id: string; id: string; display_name: string }>(
    `SELECT ca.team_id, u.id, u.display_name FROM eureka.coach_assignment ca
     JOIN eureka.app_user u ON u.id = ca.coach_id
     WHERE ca.valid @> now() AND ($1::uuid[] IS NULL OR ca.coach_id = ANY ($1::uuid[]))
     ORDER BY u.display_name, u.id`, [coachIds])).rows;
}

/** Active users whose role has the coach trait, limited to the given ids (null: everyone). */
export async function coachUsers(c: pg.PoolClient, ids: string[] | null) {
  const { rows } = await c.query<{ id: string; display_name: string; email: string; lead: boolean }>(
    `SELECT u.id, u.display_name, u.email,
            -- A coach who assigns other coaches (coach:assign) is a lead of the interview prep line.
            bool_or(EXISTS (SELECT 1 FROM eureka.role_permission rp WHERE rp.role_key = r.key AND rp.permission = 'coach:assign')) AS lead
     FROM eureka.app_user u JOIN eureka.user_role ur ON ur.user_id = u.id JOIN eureka.role r ON r.key = ur.role_key
     WHERE u.status = 'active' AND ur.valid @> now() AND r.is_coach
       AND ($1::uuid[] IS NULL OR u.id = ANY ($1::uuid[]))
     GROUP BY u.id ORDER BY u.display_name, u.id`, [ids]);
  return rows.map((u) => ({ id: u.id, displayName: u.display_name, email: u.email, role: u.lead ? "interview_lead" : "interview_coach" }));
}
