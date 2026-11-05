import { Injectable, NotFoundException } from "@nestjs/common";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { roleLabels, teamCoaches } from "./admin-queries.js";
import { AdminTx } from "./admin-tx.js";
import type { CreateDepartment, CreateLocation } from "./admin.schemas.js";

/**
 * `lp (location_id, user_id)`: who belongs to a location. Primary location,
 * current team membership or lead of a team there, or a current role for it.
 */
const LOCATION_PEOPLE_CTE = `lp AS (
  SELECT u.primary_location_id AS location_id, u.id AS user_id FROM eureka.app_user u WHERE u.primary_location_id IS NOT NULL
  UNION SELECT t.location_id, tm.user_id FROM eureka.team_member tm JOIN eureka.team t ON t.id = tm.team_id
        WHERE t.location_id IS NOT NULL AND tm.valid @> now()
  UNION SELECT t.location_id, t.lead_id FROM eureka.team t WHERE t.location_id IS NOT NULL
  UNION SELECT ur.location_id, ur.user_id FROM eureka.user_role ur WHERE ur.location_id IS NOT NULL AND ur.valid @> now()
)`;

/** Departments and locations (docs/admin-api.md "Locations", "Departments"). */
@Injectable()
export class OrgUnitsService {
  constructor(private readonly tx: AdminTx) {}

  async listDepartments(user: AuthedUser) {
    return this.tx.run(user, async (c) => {
      const { rows } = await c.query<{ id: string; name: string; parent_id: string | null; user_count: number }>(
        `SELECT d.id, d.name, d.parent_id,
                (SELECT count(*)::int FROM eureka.app_user u WHERE u.department_id = d.id AND u.status = 'active') AS user_count
         FROM eureka.department d ORDER BY lower(d.name), d.id`);
      return { items: rows.map((r) => ({ id: r.id, name: r.name, parentId: r.parent_id, userCount: r.user_count })) };
    });
  }

  // Names are free text, so audit rows record ids only (rule 5).
  async createDepartment(user: AuthedUser, body: CreateDepartment) {
    return this.tx.run(user, async (c) => {
      const { rows } = await c.query<{ id: string }>(`SELECT authz.admin_create_department($1, $2) AS id`,
        [body.name, body.parentId ?? null]);
      const id = rows[0]!.id;
      await this.tx.audit.record(c, {
        actorId: user.id, action: "admin.department.created", entityType: "department", entityId: id,
        changes: { parentId: body.parentId ?? null },
      });
      return { id };
    });
  }

  async renameDepartment(user: AuthedUser, departmentId: string, name: string) {
    await this.tx.run(user, async (c) => {
      await c.query(`SELECT authz.admin_rename_department($1, $2)`, [departmentId, name]);
      await this.tx.audit.record(c, { actorId: user.id, action: "admin.department.renamed", entityType: "department", entityId: departmentId });
    });
  }

  /** Locations tab cards: active people, teams and location-role holders per location. */
  async listLocations(user: AuthedUser) {
    return this.tx.run(user, async (c) => {
      const { rows } = await c.query<{
        id: string; name: string; kind: string; state: string | null; timezone: string; people_count: number; team_count: number;
      }>(
        `WITH ${LOCATION_PEOPLE_CTE}
         SELECT l.id, l.name, l.kind, l.state, l.timezone,
                (SELECT count(DISTINCT lp.user_id) FROM lp JOIN eureka.app_user u ON u.id = lp.user_id
                  WHERE lp.location_id = l.id AND u.status = 'active')::int AS people_count,
                (SELECT count(*) FROM eureka.team t WHERE t.location_id = l.id AND t.deleted_at IS NULL)::int AS team_count
         FROM eureka.location l ORDER BY l.name`);
      const holders = await c.query<{ location_id: string; user_id: string; display_name: string; role_key: string }>(
        `SELECT ur.location_id, u.id AS user_id, u.display_name, ur.role_key FROM eureka.user_role ur
         JOIN eureka.app_user u ON u.id = ur.user_id
         WHERE ur.location_id IS NOT NULL AND ur.valid @> now() AND u.status = 'active'
         ORDER BY ur.role_key, u.display_name`);
      const labels = await roleLabels(c);
      return {
        items: rows.map((l) => ({
          id: l.id, name: l.name, kind: l.kind, state: l.state, timezone: l.timezone,
          peopleCount: l.people_count, teamCount: l.team_count,
          roleHolders: holders.rows.filter((h) => h.location_id === l.id)
            .map((h) => ({ userId: h.user_id, displayName: h.display_name, role: h.role_key, label: labels.get(h.role_key) ?? h.role_key })),
        })),
      };
    });
  }

  /**
   * One location's people: active users based there (primary location), in or
   * leading one of its teams, or holding a role for it. Each carries their
   * manager so the client can draw the reporting tree; managers based elsewhere
   * come back in outsideManagers. Read-only.
   */
  async locationDetail(user: AuthedUser, locationId: string) {
    return this.tx.run(user, async (c) => {
      const loc = (await c.query<{ id: string; name: string; kind: string; state: string | null; timezone: string }>(
        `SELECT id, name, kind, state, timezone FROM eureka.location WHERE id = $1`, [locationId])).rows[0];
      if (!loc) throw new NotFoundException();
      const people = (await c.query<{
        id: string; display_name: string; designation: string | null; location_id: string | null; location_name: string | null;
      }>(
        `WITH ${LOCATION_PEOPLE_CTE}
         SELECT u.id, u.display_name, u.designation, u.primary_location_id AS location_id, l.name AS location_name
         FROM eureka.app_user u LEFT JOIN eureka.location l ON l.id = u.primary_location_id
         WHERE u.status = 'active' AND u.id IN (SELECT lp.user_id FROM lp WHERE lp.location_id = $1)
         ORDER BY lower(u.display_name), u.id`, [locationId])).rows;
      const ids = people.map((p) => p.id);
      const managers = await c.query<{ user_id: string; manager_id: string; display_name: string; location_name: string | null }>(
        `SELECT rl.user_id, m.id AS manager_id, m.display_name, l.name AS location_name FROM eureka.reporting_line rl
         JOIN eureka.app_user m ON m.id = rl.manager_id LEFT JOIN eureka.location l ON l.id = m.primary_location_id
         WHERE rl.user_id = ANY($1::uuid[]) AND rl.valid @> now()`, [ids]);
      const labels = await roleLabels(c);
      const roles = await c.query<{ user_id: string; role_key: string; location_id: string | null; location_name: string | null }>(
        `SELECT ur.user_id, ur.role_key, ur.location_id, l.name AS location_name FROM eureka.user_role ur
         LEFT JOIN eureka.location l ON l.id = ur.location_id
         WHERE ur.user_id = ANY($1::uuid[]) AND ur.valid @> now() ORDER BY ur.role_key`, [ids]);
      const memberships = await c.query<{ user_id: string; id: string; name: string; as_lead: boolean }>(
        `SELECT tm.user_id, t.id, t.name, false AS as_lead FROM eureka.team_member tm
         JOIN eureka.team t ON t.id = tm.team_id WHERE tm.user_id = ANY($1::uuid[]) AND tm.valid @> now()
         UNION ALL
         SELECT t.lead_id, t.id, t.name, true FROM eureka.team t WHERE t.lead_id = ANY($1::uuid[])
         ORDER BY name`, [ids]);
      const teams = await c.query<{ id: string; name: string; lead_id: string; lead_name: string }>(
        `SELECT t.id, t.name, t.lead_id, u.display_name AS lead_name FROM eureka.team t
         JOIN eureka.app_user u ON u.id = t.lead_id WHERE t.location_id = $1 ORDER BY t.name, t.id`, [locationId]);
      const teamIds = teams.rows.map((t) => t.id);
      const members = await c.query<{ team_id: string; user_id: string }>(
        `SELECT tm.team_id, tm.user_id FROM eureka.team_member tm
         WHERE tm.team_id = ANY($1::uuid[]) AND tm.valid @> now()`, [teamIds]);
      const coached = (await teamCoaches(c, null)).filter((x) => teamIds.includes(x.team_id));

      const inSet = new Set(ids);
      const outside = new Map<string, { id: string; displayName: string; locationName: string | null }>();
      for (const m of managers.rows) {
        if (!inSet.has(m.manager_id)) outside.set(m.manager_id, { id: m.manager_id, displayName: m.display_name, locationName: m.location_name });
      }
      return {
        location: loc,
        people: people.map((p) => ({
          id: p.id,
          displayName: p.display_name,
          designation: p.designation,
          primaryLocation: p.location_id ? { id: p.location_id, name: p.location_name } : null,
          managerId: managers.rows.find((m) => m.user_id === p.id)?.manager_id ?? null,
          roles: roles.rows.filter((r) => r.user_id === p.id).map((r) => ({
            key: r.role_key, label: labels.get(r.role_key) ?? r.role_key, locationId: r.location_id, locationName: r.location_name,
          })),
          teams: memberships.rows.filter((t) => t.user_id === p.id).map((t) => ({ id: t.id, name: t.name, asLead: t.as_lead })),
        })),
        outsideManagers: [...outside.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)),
        teams: teams.rows.map((t) => ({
          id: t.id,
          name: t.name,
          lead: { id: t.lead_id, displayName: t.lead_name },
          memberIds: members.rows.filter((m) => m.team_id === t.id).map((m) => m.user_id),
          coaches: coached.filter((x) => x.team_id === t.id).map((x) => ({ id: x.id, displayName: x.display_name })),
        })),
      };
    });
  }

  async createLocation(user: AuthedUser, body: CreateLocation) {
    return this.tx.run(user, async (c) => {
      const { rows } = await c.query<{ id: string }>(`SELECT authz.admin_create_location($1, $2, $3, $4) AS id`,
        [body.name, body.kind, body.state ?? null, body.timezone ?? null]);
      const id = rows[0]!.id;
      // Name and state are free text: the kind and the fields set only (rule 5, as renameLocation).
      await this.tx.audit.record(c, {
        actorId: user.id, action: "admin.location.created", entityType: "location", entityId: id,
        changes: { kind: body.kind, fields: Object.keys(body) },
      });
      return { id };
    });
  }

  // Names are free text, so the audit row records the id only (rule 5).
  async renameLocation(user: AuthedUser, locationId: string, name: string) {
    await this.tx.run(user, async (c) => {
      await c.query(`SELECT authz.admin_rename_location($1, $2)`, [locationId, name]);
      await this.tx.audit.record(c, { actorId: user.id, action: "admin.location.renamed", entityType: "location", entityId: locationId });
    });
  }
}
