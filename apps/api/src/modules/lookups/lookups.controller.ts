import { Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, Post, Query, UnprocessableEntityException } from "@nestjs/common";
import { z } from "zod";
import { can, type Permission, type UserAccess } from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import { CurrentUser, RequirePermission, SelfService, type AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { dbErrorMapper } from "../../platform/errors.js";
import { likeContains } from "../../platform/sql.js";

type Item = { id: string; name: string };

/** The coach roster is for callers who schedule or edit interviews (any scope). */
export const COACH_PERMISSIONS: readonly Permission[] = ["interview:create", "interview:update"];
/** Clients, vendors and implementation partners are for callers who work submissions or placements (any scope). */
export const PARTY_PERMISSIONS: readonly Permission[] = ["submission:read", "submission:create", "placement:read"];

const canAny = (access: UserAccess, perms: readonly Permission[]) => perms.some((p) => can(access, p));

/** Same limits as authz.create_technology: 1–60 characters, no control characters. */
export const CreateTechnology = z.object({
  name: z.string().trim().min(1).max(60).regex(/^[^\p{Cc}]*$/u, "Must not contain control characters"),
}).strict();

/** Same limits as authz.create_client / create_vendor: 1–60 characters, no control characters. */
export const CreateParty = z.object({
  name: z.string().trim().min(1).max(60).regex(/^[^\p{Cc}]*$/u, "Must not contain control characters"),
}).strict();

/** Party lists per narrowed lookup when `q` is given without `limit`. */
export const PARTY_SEARCH_DEFAULT_LIMIT = 50;

/**
 * GET /lookups query (all optional). Not strict: the route took no query before, so unknown
 * keys stay ignored (no breaking change).
 */
export const LookupsQuery = z.object({
  q: z.string().trim().min(1).max(60).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
}).strip();
export type LookupsQuery = z.infer<typeof LookupsQuery>;

const mapCreatePartyError = dbErrorMapper({
  invalid_name: () => new UnprocessableEntityException("Name must be 1–60 characters"),
});

const mapCreateTechnologyError = dbErrorMapper({
  technology_inactive: () => new ConflictException("That technology has been retired"),
  invalid_name: () => new UnprocessableEntityException("Name must be 1–60 characters"),
});

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
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  /**
   * Without a query: every list complete, in exactly the shape it always had. With `q` and/or `limit`
   * (C-09): clients, vendors and implementation partners are narrowed to names containing `q`
   * (case-insensitive) and capped at `limit` (default PARTY_SEARCH_DEFAULT_LIMIT) each; the response
   * then also carries `truncated` (true when any of those three lists was cut at the cap).
   */
  async all(user: AuthedUser, search: LookupsQuery = {}) {
    const coaches = canAny(user.access, COACH_PERMISSIONS);
    const parties = canAny(user.access, PARTY_PERMISSIONS);
    const narrowed = search.q !== undefined || search.limit !== undefined;
    const cap = search.limit ?? PARTY_SEARCH_DEFAULT_LIMIT;
    let truncated = false;
    return this.db.withUser(user.id, async (c) => {
      const q = async (sql: string) => (await c.query<Item>(sql)).rows;
      const party = async (table: string): Promise<Item[]> => {
        if (!narrowed) return q(`SELECT id, name FROM eureka.${table} ORDER BY name, id`);
        const rows = (await c.query<Item>(
          `SELECT id, name FROM eureka.${table} WHERE ($1::text IS NULL OR name ILIKE $1) ORDER BY name, id LIMIT $2`,
          [search.q === undefined ? null : likeContains(search.q), cap + 1])).rows;
        if (rows.length > cap) truncated = true;
        return rows.slice(0, cap);
      };
      const none: Item[] = [];
      const clients = parties ? await party("client") : none;
      const vendors = parties ? await party("vendor") : none;
      const implementationPartners = parties ? await party("implementation_partner") : none;
      return {
        technologies: await q(`SELECT id, name FROM eureka.technology WHERE active ORDER BY name, id`),
        clients,
        vendors,
        implementationPartners,
        locations: await q(`SELECT id, name FROM eureka.location ORDER BY name, id`),
        coaches: coaches
          ? await q(
            `SELECT DISTINCT u.id, u.display_name AS name
             FROM eureka.app_user u JOIN eureka.user_role ur ON ur.user_id = u.id
             JOIN eureka.role r ON r.key = ur.role_key
             WHERE u.status = 'active' AND r.is_coach AND NOT EXISTS (
               SELECT 1 FROM eureka.role_permission rp WHERE rp.role_key = r.key AND rp.permission = 'coach:assign')
               AND ur.valid @> now()
             ORDER BY name, u.id`)
          : none,
        // Live business roles for owner / folder-role pickers (docs/roles-api.md): key as id, label as name.
        roles: await q(`SELECT key AS id, label AS name FROM eureka.role
                        WHERE archived_at IS NULL AND NOT is_admin ORDER BY track, level, label, key`),
        ...(narrowed ? { truncated } : {}),
      };
    });
  }

  /**
   * Adds a technology (technology:create: Sales leads and above, org admins). An existing
   * active name (case-insensitive) is returned instead of a duplicate, with `created: false`.
   */
  async createTechnology(user: AuthedUser, name: string) {
    if (!can(user.access, "technology:create")) throw new ForbiddenException("Not permitted");
    return this.db.withUser(user.id, async (c) => {
      const { rows } = await c.query<{ technology_id: string; technology_name: string; created: boolean }>(
        `SELECT technology_id, technology_name, created FROM authz.create_technology($1)`, [name]);
      const r = rows[0]!;
      if (r.created) {
        await this.audit.record(c, { actorId: user.id, action: "technology.created", entityType: "technology", entityId: r.technology_id });
      }
      return { id: r.technology_id, name: r.technology_name, created: r.created };
    }).catch(mapCreateTechnologyError);
  }

  /**
   * Adds a client or vendor (client:create / vendor:create: every Sales role). An existing
   * name (case-insensitive) is returned instead of a duplicate, with `created: false`.
   */
  async createParty(user: AuthedUser, kind: "client" | "vendor", name: string) {
    if (!can(user.access, `${kind}:create`)) throw new ForbiddenException("Not permitted");
    return this.db.withUser(user.id, async (c) => {
      const { rows } = await c.query<{ id: string; name: string; created: boolean }>(
        `SELECT ${kind}_id AS id, ${kind}_name AS name, created FROM authz.create_${kind}($1)`, [name]);
      const r = rows[0]!;
      if (r.created) {
        await this.audit.record(c, { actorId: user.id, action: `${kind}.created`, entityType: kind, entityId: r.id });
      }
      return { id: r.id, name: r.name, created: r.created };
    }).catch(mapCreatePartyError);
  }
}

@Controller("api/v1/lookups")
export class LookupsController {
  constructor(private readonly svc: LookupsService) {}

  @Get()
  @SelfService()
  all(@CurrentUser() user: AuthedUser, @Query() query: unknown) {
    return this.svc.all(user, LookupsQuery.parse(query ?? {}));
  }

  @Post("technologies")
  @HttpCode(200)
  @RequirePermission("technology:create")
  createTechnology(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.svc.createTechnology(user, CreateTechnology.parse(body).name);
  }

  @Post("clients")
  @HttpCode(200)
  @RequirePermission("client:create")
  createClient(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.svc.createParty(user, "client", CreateParty.parse(body).name);
  }

  @Post("vendors")
  @HttpCode(200)
  @RequirePermission("vendor:create")
  createVendor(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.svc.createParty(user, "vendor", CreateParty.parse(body).name);
  }
}
