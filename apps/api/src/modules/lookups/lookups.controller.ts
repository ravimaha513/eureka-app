import { Controller, Get, Injectable } from "@nestjs/common";
import { CurrentUser, type AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";

type Item = { id: string; name: string };

/**
 * Reference lists for pickers (docs/placements-api.md "Lookups"). Any
 * signed-in user; ids and display names only, active rows only.
 */
@Injectable()
export class LookupsService {
  constructor(private readonly db: DbService) {}

  async all(user: AuthedUser) {
    return this.db.withUser(user.id, async (c) => {
      const q = async (sql: string) => (await c.query<Item>(sql)).rows;
      return {
        technologies: await q(`SELECT id, name FROM eureka.technology WHERE active ORDER BY name, id`),
        clients: await q(`SELECT id, name FROM eureka.client ORDER BY name, id`),
        vendors: await q(`SELECT id, name FROM eureka.vendor ORDER BY name, id`),
        implementationPartners: await q(`SELECT id, name FROM eureka.implementation_partner ORDER BY name, id`),
        locations: await q(`SELECT id, name FROM eureka.location ORDER BY name, id`),
        coaches: await q(
          `SELECT DISTINCT u.id, u.display_name AS name
           FROM eureka.app_user u JOIN eureka.user_role ur ON ur.user_id = u.id
           WHERE u.status = 'active' AND ur.role_key = 'interview_coach' AND ur.valid @> now()
           ORDER BY name, u.id`),
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
