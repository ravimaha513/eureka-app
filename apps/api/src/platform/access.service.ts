import { Injectable } from "@nestjs/common";
import type pg from "pg";
import { ROLES, type Role, type UserAccess } from "@eureka/shared";

/** Loads the access facts the engine needs (design B4.3), from current rows. */
@Injectable()
export class AccessService {
  async load(c: pg.PoolClient, userId: string): Promise<UserAccess> {
    const roles = await c.query<{ role_key: string; location_id: string | null }>(
      `SELECT role_key, location_id FROM eureka.user_role WHERE user_id = $1 AND valid @> now()`,
      [userId],
    );
    const teams = await c.query<{ team_id: string }>(
      `SELECT team_id FROM eureka.team_member WHERE user_id = $1 AND valid @> now()
       UNION SELECT id FROM eureka.team WHERE lead_id = $1`,
      [userId],
    );
    const subs = await c.query<{ descendant_id: string }>(
      `SELECT descendant_id FROM eureka.reporting_closure WHERE ancestor_id = $1`,
      [userId],
    );
    const subtree = await c.query<{ id: string }>(
      `SELECT t.id FROM eureka.team t WHERE t.lead_id = $1
       UNION SELECT t.id FROM eureka.team t JOIN eureka.reporting_closure rc ON rc.descendant_id = t.lead_id
       WHERE rc.ancestor_id = $1`,
      [userId],
    );
    const coached = await c.query<{ team_id: string }>(
      `SELECT team_id FROM eureka.coach_assignment WHERE coach_id = $1 AND valid @> now()`,
      [userId],
    );
    return {
      userId,
      roles: roles.rows
        .filter((r) => (ROLES as readonly string[]).includes(r.role_key))
        .map((r) => ({ role: r.role_key as Role, locationId: r.location_id ?? undefined })),
      teamIds: teams.rows.map((r) => r.team_id),
      subordinateUserIds: subs.rows.map((r) => r.descendant_id),
      subtreeTeamIds: subtree.rows.map((r) => r.id),
      coachedTeamIds: coached.rows.map((r) => r.team_id),
    };
  }
}
