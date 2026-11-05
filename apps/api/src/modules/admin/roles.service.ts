import { Injectable } from "@nestjs/common";
import type pg from "pg";
import {
  ADMIN_COMPATIBLE_PERMISSIONS,
  ADMIN_PERMISSIONS,
  PERMISSIONS,
  PERMISSION_DESCRIPTIONS,
  ORG_SENSITIVE_PERMISSIONS,
  RESTRICTED_PERMISSIONS,
  SCOPES,
  permissionArea, FIXED_ROLE_PERMISSIONS } from "@eureka/shared";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { roleRow, roleRows, type RoleRow } from "./admin-queries.js";
import { AdminTx } from "./admin-tx.js";
import type { CreateRole, SetRoleGrants, UpdateRole } from "./admin.schemas.js";

const roleItem = (r: RoleRow, grants?: Record<string, string>) => ({
  key: r.key, label: r.label, description: r.description, isSystem: r.is_system, restricted: r.is_restricted,
  traits: { sales: r.is_sales, locationBound: r.is_location_bound, admin: r.is_admin, recruiter: r.is_recruiter, coach: r.is_coach },
  track: r.track, level: r.level,
  department: r.department_id ? { id: r.department_id, name: r.department_name! } : null,
  clonedFrom: r.cloned_from, holders: r.holders, archivedAt: r.archived_at, rowVersion: r.row_version,
  classification: r.classification,
  ...(grants ? { grants } : {}),
});

/** Role definitions and the admin-separation reports (docs/roles-api.md). */
@Injectable()
export class RolesService {
  constructor(private readonly tx: AdminTx) {}

  async listRoles(user: AuthedUser, includeArchived: boolean) {
    return this.tx.run(user, async (c) => {
      const roles = (await roleRows(c)).filter((r) => includeArchived || !r.archived_at);
      const grants = (await c.query<{ role_key: string; permission: string; scope: string }>(
        `SELECT role_key, permission, scope FROM eureka.role_permission ORDER BY permission`)).rows;
      return {
        items: roles.map((r) => roleItem(r, Object.fromEntries(grants.filter((g) => g.role_key === r.key).map((g) => [g.permission, g.scope])))),
      };
    });
  }

  listPermissions() {
    return {
      scopes: [...SCOPES],
      items: PERMISSIONS.filter((key) => !FIXED_ROLE_PERMISSIONS.includes(key)).map((key) => ({
        key, area: permissionArea(key), description: PERMISSION_DESCRIPTIONS[key],
        restricted: RESTRICTED_PERMISSIONS.includes(key), orgSensitive: ORG_SENSITIVE_PERMISSIONS.includes(key),
        adminOnly: ADMIN_PERMISSIONS.includes(key), adminCompatible: ADMIN_COMPATIBLE_PERMISSIONS.includes(key),
      })),
    };
  }

  async createRole(user: AuthedUser, body: CreateRole) {
    return this.tx.run(user, async (c) => {
      const { rows } = await c.query<{ key: string }>(`SELECT authz.role_create($1, $2, $3, $4, $5, $6) AS key`,
        [body.label, body.cloneFrom, body.description ?? null, body.departmentId ?? null, body.track ?? null, body.level ?? null]);
      const key = rows[0]!.key;
      // Labels and descriptions are free text: the audit row keeps keys only (rule 5); entity_id is a
      // uuid column, so the role key travels in changes.
      await this.tx.audit.record(c, {
        actorId: user.id, action: "admin.role.created", entityType: "role",
        changes: { key, clonedFrom: body.cloneFrom, departmentId: body.departmentId ?? null },
      });
      return { key };
    });
  }

  /** The role's row_version after a write in this transaction (the definer function holds the row lock). */
  private async roleVersion(c: pg.PoolClient, key: string): Promise<number> {
    return (await c.query<{ v: number }>(`SELECT row_version AS v FROM eureka.role WHERE key = $1`, [key])).rows[0]!.v;
  }

  /**
   * expected: the optional If-Match rowVersion (docs/roles-api.md "Concurrency"); the definer function
   * refuses a stale one (412) under the row lock. Returns the role's rowVersion after the edit.
   */
  async updateRole(user: AuthedUser, key: string, body: UpdateRole, expected: number | null = null): Promise<number> {
    return this.tx.run(user, async (c) => {
      await roleRow(c, key);
      const { rows } = await c.query<{ changed: string[] }>(
        `SELECT authz.role_update($1, $2::jsonb, $3) AS changed`, [key, JSON.stringify(body), expected]);
      if (rows[0]!.changed.length > 0) {
        await this.tx.audit.record(c, {
          actorId: user.id, action: "admin.role.updated", entityType: "role",
          changes: { key, fields: rows[0]!.changed, ...(rows[0]!.changed.includes("traits") ? { traits: body.traits } : {}) },
        });
      }
      return this.roleVersion(c, key);
    });
  }

  async setRoleGrants(user: AuthedUser, key: string, body: SetRoleGrants, expected: number | null = null): Promise<number> {
    return this.tx.run(user, async (c) => {
      await roleRow(c, key);
      const { rows } = await c.query<{ d: { added: string[]; removed: string[]; changed: string[] } }>(
        `SELECT authz.role_set_grants($1, $2::jsonb, $3) AS d`, [key, JSON.stringify(body.grants), expected]);
      const d = rows[0]!.d;
      if (d.added.length + d.removed.length + d.changed.length > 0) {
        await this.tx.audit.record(c, {
          actorId: user.id, action: "admin.role.grants_changed", entityType: "role",
          changes: { key, added: d.added, removed: d.removed, changed: d.changed },
        });
      }
      return this.roleVersion(c, key);
    });
  }

  /** Roles that break admin/data separation (docs/roles-api.md "Admin separation"); read-only report. */
  async listRoleViolations(user: AuthedUser) {
    return this.tx.run(user, async (c) => {
      const { rows } = await c.query<{
        role_key: string; label: string; is_system: boolean; is_admin: boolean; archived: boolean; holders: number; permissions: string[];
      }>(`SELECT * FROM authz.role_admin_violations()`);
      return {
        items: rows.map((r) => ({
          key: r.role_key, label: r.label, isSystem: r.is_system, admin: r.is_admin, archived: r.archived,
          holders: r.holders, permissions: r.permissions,
        })),
      };
    });
  }

  /**
   * Users holding admin and data roles at once (docs/roles-api.md "Admin separation", migration 0510);
   * read-only report, nothing is stripped.
   */
  async listUserViolations(user: AuthedUser) {
    return this.tx.run(user, async (c) => {
      const { rows } = await c.query<{
        user_id: string; display_name: string; status: string; admin_roles: string[]; data_roles: string[];
      }>(`SELECT * FROM authz.user_admin_violations()`);
      return {
        items: rows.map((r) => ({
          id: r.user_id, displayName: r.display_name, status: r.status, adminRoles: r.admin_roles, dataRoles: r.data_roles,
        })),
      };
    });
  }

  async archiveRole(user: AuthedUser, key: string, restore: boolean) {
    await this.tx.run(user, async (c) => {
      const r = await roleRow(c, key);
      if (restore ? !r.archived_at : !!r.archived_at) return;
      await c.query(restore ? `SELECT authz.role_restore($1)` : `SELECT authz.role_archive($1)`, [key]);
      await this.tx.audit.record(c, {
        actorId: user.id, action: restore ? "admin.role.restored" : "admin.role.archived", entityType: "role", changes: { key },
      });
    });
  }
}
