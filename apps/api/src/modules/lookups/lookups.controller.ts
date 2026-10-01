import { Controller, Get, Injectable } from "@nestjs/common";
import { can, type Permission, type UserAccess } from "@eureka/shared";
import { CurrentUser, type AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";

type Item = { id: string; name: string };

/** The coach roster is for callers who schedule or edit interviews (any scope). */
export const COACH_PERMISSIONS: readonly Permission[] = ["interview:create", "interview:update"];
/** Clients, vendors and implementation partners are for callers who work submissions or placements (any scope). */
export const PARTY_PERMISSIONS: readonly Permission[] = ["submission:read", "submission:create", "placement:read"];

const canAny = (access: UserAccess, perms: readonly Permission[]) => perms.some((p) => can(access, p));

/**
 * Reference lists for pickers (docs/placements-api.md "Lookups"). Any
 * signed-in user may call it; ids and display names only, active rows only.
 * Least privilege: `coaches` is populated only for COACH_PERMISSIONS holders,
 * and `clients`, `vendors`, `implementationPartners` only for
 * PARTY_PERMISSIONS holders; otherwise those keys are [] (the shape never
 * changes). `technologies` and `locations` are open to every signed-in user.
 */
@Injectable()
export class LookupsService {
  constructor(private readonly db: DbService) {}

  async all(user: AuthedUser) {
    const coaches = canAny(user.access, COACH_PERMISSIONS);
    const parties = canAny(user.access, PARTY_PERMISSIONS);
    return this.db.withUser(user.id, async (c) => {
      const q = async (sql: string) => (await c.query<Item>(sql)).rows;
      const none: Item[] = [];
      return {
        technologies: await q(`SELECT id, name FROM eureka.technology WHERE active ORDER BY name, id`),
        clients: parties ? await q(`SELECT id, name FROM eureka.client ORDER BY name, id`) : none,
        vendors: parties ? await q(`SELECT id, name FROM eureka.vendor ORDER BY name, id`) : none,
        implementationPartners: parties
          ? await q(`SELECT id, name FROM eureka.implementation_partner ORDER BY name, id`)
          : none,
        locations: await q(`SELECT id, name FROM eureka.location ORDER BY name, id`),
        coaches: coaches
          ? await q(
            `SELECT DISTINCT u.id, u.display_name AS name
             FROM eureka.app_user u JOIN eureka.user_role ur ON ur.user_id = u.id
             WHERE u.status = 'active' AND ur.role_key = 'interview_coach' AND ur.valid @> now()
             ORDER BY name, u.id`)
          : none,
      };
    });
  }
}

@Controller("api/v1/lookups")
export class LookupsController {
  constructor(private readonly svc: LookupsService) {}

  @Get()
  all(@CurrentUser() user: AuthedUser) {
    return this.svc.all(user);
  }
}
