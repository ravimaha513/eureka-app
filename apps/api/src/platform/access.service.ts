import { Injectable } from "@nestjs/common";
import type pg from "pg";
import { ROLES, type Role, type UserAccess } from "@eureka/shared";

/** Loads the access facts the engine needs (design B4.3), from current rows. */
@Injectable()
export class AccessService {
  async load(c: pg.PoolClient, userId: string): Promise<UserAccess> {
    // One round trip: this runs before every authenticated request.
    const { rows: [r] } = await c.query<{
      roles: { role_key: string; location_id: string | null }[];
      teams: string[]; subs: string[]; subtree: string[]; coached: string[];
    }>(
      `SELECT
         COALESCE((SELECT json_agg(json_build_object('role_key', role_key, 'location_id', location_id))
                   FROM eureka.user_role WHERE user_id = $1 AND valid @> now()), '[]') AS roles,
         ARRAY(SELECT team_id FROM eureka.team_member WHERE user_id = $1 AND valid @> now()
               UNION SELECT id FROM eureka.team WHERE lead_id = $1)::text[] AS teams,
         ARRAY(SELECT descendant_id FROM eureka.reporting_closure WHERE ancestor_id = $1)::text[] AS subs,
         ARRAY(SELECT t.id FROM eureka.team t WHERE t.lead_id = $1
               UNION SELECT t.id FROM eureka.team t JOIN eureka.reporting_closure rc ON rc.descendant_id = t.lead_id
               WHERE rc.ancestor_id = $1)::text[] AS subtree,
         ARRAY(SELECT team_id FROM eureka.coach_assignment WHERE coach_id = $1 AND valid @> now())::text[] AS coached`,
      [userId],
    );
    return {
      userId,
      roles: r!.roles
        .filter((x) => (ROLES as readonly string[]).includes(x.role_key))
        .map((x) => ({ role: x.role_key as Role, locationId: x.location_id ?? undefined })),
      teamIds: r!.teams,
      subordinateUserIds: r!.subs,
      subtreeTeamIds: r!.subtree,
      coachedTeamIds: r!.coached,
    };
  }
}
