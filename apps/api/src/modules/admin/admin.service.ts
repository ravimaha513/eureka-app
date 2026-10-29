import { ForbiddenException, HttpException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import type pg from "pg";
import { z } from "zod";
import {
  LOCATION_ROLES,
  ROLES,
  ROLE_LABELS,
  isRestrictedRole,
  resolveScope,
  resolveScopeFor,
  type Role,
} from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { CONFIG, parseEmailList, type AppConfig } from "../../platform/config.js";
import { DbService } from "../../platform/db.service.js";
import { mapAdminError } from "./admin.errors.js";
import type { BulkCreateUsers, CreateDepartment, CreateLocation, CreateRoleRequest, CreateTeam, CreateUser, MoveMember, UserListQuery } from "./admin.schemas.js";
import { likeContains } from "../../platform/sql.js";
import { buildUserImportTemplate } from "./user-import-template.js";

const EMAIL = z.string().email();

/** Thrown inside the transaction to roll it back while still returning the per-row report. */
class BulkOutcome extends Error {
  constructor(readonly report: unknown) { super("bulk_rollback"); }
}

/** A user's department with its parent, from the department_* / parent_* columns of a join. */
const departmentOf = (r: { department_id: string | null; department_name: string | null; parent_id: string | null; parent_name: string | null }) =>
  r.department_id
    ? { id: r.department_id, name: r.department_name!, parent: r.parent_id ? { id: r.parent_id, name: r.parent_name! } : null }
    : null;

const label = (key: string) => ROLE_LABELS[key as Role] ?? key;

/** A role from a key or its label, case-insensitive; null when it names no role. */
const ROLE_BY_TEXT = new Map<string, Role>(ROLES.flatMap((k) => [[k, k], [ROLE_LABELS[k].toLowerCase(), k]] as [string, Role][]));
const roleFromText = (text: string): Role | null => ROLE_BY_TEXT.get(text.toLowerCase()) ?? null;

/** request_role failures that are a problem with one row, not with the import. */
const ROW_ROLE_ERRORS = new Set(["separation_of_duties", "location_required", "location_not_allowed", "role_already_held"]);

/**
 * Admin and team operations (docs/admin-api.md). The controllers check the
 * permission; this service applies the self-change and location rules in the
 * application layer, and every write goes through a definer function that
 * re-checks all of them in the database (migration 0013). Each change is
 * audited in the same transaction.
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** Runs fn as the user and maps database error codes to contract errors. */
  private async tx<T>(user: AuthedUser, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.db.withUser(user.id, fn);
    } catch (err) {
      mapAdminError(err);
    }
  }

  private notSelf(user: AuthedUser, target: string | null | undefined): void {
    if (target && target === user.id) throw new ForbiddenException("self_change");
  }

  // ---------- metadata ----------

  async meta(user: AuthedUser) {
    const { locations, singleAdminMode } = await this.tx(user, async (c) => ({
      locations: (await c.query<{ id: string; name: string }>(`SELECT id, name FROM eureka.location ORDER BY name`)).rows,
      // Migration 0084/0085: one admin may grant restricted roles without a second approver.
      singleAdminMode: (await c.query<{ on: boolean }>(`SELECT authz.single_admin_mode() AS "on"`)).rows[0]!.on,
    }));
    return {
      singleAdminMode,
      roles: ROLES.map((key) => ({
        key,
        label: ROLE_LABELS[key],
        restricted: isRestrictedRole(key),
        locationBound: LOCATION_ROLES.includes(key),
      })),
      locations,
    };
  }

  // ---------- users ----------

  async listUsers(user: AuthedUser, q: UserListQuery) {
    return this.tx(user, async (c) => {
      const params: unknown[] = [];
      const where: string[] = [];
      if (q.search) {
        params.push(likeContains(q.search));
        where.push(`(u.display_name ILIKE $${params.length} OR u.email::text ILIKE $${params.length})`);
      }
      if (q.status) { params.push(q.status); where.push(`u.status = $${params.length}`); }
      if (q.departmentId === "none") where.push(`u.department_id IS NULL`);
      else if (q.departmentId) {
        params.push(q.departmentId);
        where.push(`u.department_id IN (SELECT d.id FROM eureka.department d WHERE d.id = $${params.length} OR d.parent_id = $${params.length})`);
      }
      if (q.team === "none") {
        where.push(`NOT EXISTS (SELECT 1 FROM eureka.team_member tm WHERE tm.user_id = u.id AND tm.valid @> now())
          AND NOT EXISTS (SELECT 1 FROM eureka.team t WHERE t.lead_id = u.id)`);
      } else if (q.team) {
        params.push(q.team);
        where.push(`EXISTS (SELECT 1 FROM eureka.team_member tm WHERE tm.user_id = u.id AND tm.team_id = $${params.length} AND tm.valid @> now())`);
      }
      if (q.role) {
        params.push(q.role);
        where.push(`EXISTS (SELECT 1 FROM eureka.user_role ur WHERE ur.user_id = u.id AND ur.role_key = $${params.length} AND ur.valid @> now())`);
      }
      if (q.locationId) { params.push(q.locationId); where.push(`u.primary_location_id = $${params.length}`); }
      if (q.cursor) { params.push(q.cursor); where.push(`u.id > $${params.length}`); }
      params.push(q.limit + 1);
      const { rows } = await c.query<{
        id: string; email: string; display_name: string; designation: string | null; status: string;
        location_id: string | null; location_name: string | null;
        department_id: string | null; department_name: string | null; parent_id: string | null; parent_name: string | null;
      }>(
        `SELECT u.id, u.email, u.display_name, u.designation, u.status,
                u.primary_location_id AS location_id, l.name AS location_name,
                d.id AS department_id, d.name AS department_name, p.id AS parent_id, p.name AS parent_name
         FROM eureka.app_user u LEFT JOIN eureka.location l ON l.id = u.primary_location_id
         LEFT JOIN eureka.department d ON d.id = u.department_id LEFT JOIN eureka.department p ON p.id = d.parent_id
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY u.id LIMIT $${params.length}`, params);
      const page = rows.slice(0, q.limit);
      const ids = page.map((r) => r.id);

      const managers = await c.query<{ user_id: string; id: string; display_name: string }>(
        `SELECT rl.user_id, m.id, m.display_name FROM eureka.reporting_line rl
         JOIN eureka.app_user m ON m.id = rl.manager_id
         WHERE rl.user_id = ANY($1::uuid[]) AND rl.valid @> now()`, [ids]);
      const roles = await c.query<{ user_id: string; role_key: string; location_id: string | null; location_name: string | null }>(
        `SELECT ur.user_id, ur.role_key, ur.location_id, l.name AS location_name FROM eureka.user_role ur
         LEFT JOIN eureka.location l ON l.id = ur.location_id
         WHERE ur.user_id = ANY($1::uuid[]) AND ur.valid @> now() ORDER BY ur.role_key`, [ids]);
      const teams = await c.query<{ user_id: string; id: string; name: string; as_lead: boolean }>(
        `SELECT tm.user_id, t.id, t.name, false AS as_lead FROM eureka.team_member tm
         JOIN eureka.team t ON t.id = tm.team_id WHERE tm.user_id = ANY($1::uuid[]) AND tm.valid @> now()
         UNION ALL
         SELECT t.lead_id, t.id, t.name, true FROM eureka.team t WHERE t.lead_id = ANY($1::uuid[])
         ORDER BY name`, [ids]);

      // Staff phone (Settings profile) only for staff.contact:read holders (ST-3); RLS hides other rows anyway.
      const contact = resolveScope(user.access, "staff.contact:read")?.all === true;
      const phones = contact ? await c.query<{ user_id: string; phone_e164: string | null }>(
        `SELECT user_id, phone_e164 FROM eureka.staff_profile WHERE user_id = ANY($1::uuid[])`, [ids]) : { rows: [] };

      return {
        /** Presentation hint: whether the phone column applies to this caller. */
        contactVisible: contact,
        items: page.map((r) => {
          const m = managers.rows.find((x) => x.user_id === r.id);
          return {
            id: r.id,
            email: r.email,
            displayName: r.display_name,
            designation: r.designation,
            ...(contact ? { phone: phones.rows.find((x) => x.user_id === r.id)?.phone_e164 ?? null } : {}),
            status: r.status,
            primaryLocation: r.location_id ? { id: r.location_id, name: r.location_name } : null,
            department: departmentOf(r),
            manager: m ? { id: m.id, displayName: m.display_name } : null,
            roles: roles.rows.filter((x) => x.user_id === r.id).map((x) => ({
              key: x.role_key, label: label(x.role_key), locationId: x.location_id, locationName: x.location_name,
            })),
            teams: teams.rows.filter((x) => x.user_id === r.id).map((x) => ({ id: x.id, name: x.name, asLead: x.as_lead })),
          };
        }),
        nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null,
      };
    });
  }

  /** KPI cards above the staff list: active users per role, only roles that have users (ST-3). */
  async userSummary(user: AuthedUser) {
    return this.tx(user, async (c) => {
      const { rows } = await c.query<{ role_key: string; n: number }>(
        `SELECT ur.role_key, count(DISTINCT ur.user_id)::int AS n
         FROM eureka.user_role ur JOIN eureka.app_user u ON u.id = ur.user_id
         WHERE ur.valid @> now() AND u.status = 'active'
         GROUP BY ur.role_key HAVING count(*) > 0`);
      const counts = new Map(rows.map((r) => [r.role_key, r.n]));
      const totals = (await c.query<{ active: number; inactive: number }>(
        `SELECT count(*) FILTER (WHERE status = 'active')::int AS active, count(*) FILTER (WHERE status = 'inactive')::int AS inactive
         FROM eureka.app_user`)).rows[0]!;
      return {
        active: totals.active,
        inactive: totals.inactive,
        roles: ROLES.filter((k) => counts.has(k)).map((key) => ({ key, label: ROLE_LABELS[key], count: counts.get(key)! })),
      };
    });
  }

  /**
   * Whether an email may belong to a user: in the Google hosted domain, or on
   * the staging test list, or any email when password sign-in is on (staging
   * and local only; the config refuses it elsewhere).
   */
  private emailAllowed(email: string): boolean {
    const domain = this.config.GOOGLE_HOSTED_DOMAIN?.trim().toLowerCase();
    if (!domain || this.config.PASSWORD_LOGIN === "on") return true;
    const e = email.trim().toLowerCase();
    return e.endsWith(`@${domain}`) || parseEmailList(this.config.AUTH_TEST_EMAILS).includes(e);
  }

  /** An org admin sets a temporary password for a user (staging/local); the user must change it at first sign-in. */
  async setPassword(user: AuthedUser, id: string, password: string): Promise<void> {
    if (this.config.PASSWORD_LOGIN !== "on") throw new NotFoundException();
    await this.tx(user, async (c) => { await c.query(`SELECT authz.admin_set_password($1, $2)`, [id, password]); });
  }

  async createUser(user: AuthedUser, body: CreateUser) {
    if (!this.emailAllowed(body.email)) throw new UnprocessableEntityException("email_domain");
    if (body.temporaryPassword !== undefined && this.config.PASSWORD_LOGIN !== "on") {
      throw new UnprocessableEntityException("password_login_disabled");
    }
    return this.tx(user, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `SELECT authz.admin_create_user($1, $2, $3, $4) AS id`,
        [body.email, body.displayName, body.designation ?? null, body.primaryLocationId ?? null]);
      const id = rows[0]!.id;
      if (body.temporaryPassword !== undefined) await c.query(`SELECT authz.admin_set_password($1, $2)`, [id, body.temporaryPassword]);
      await this.audit.record(c, {
        actorId: user.id, action: "admin.user.created", entityType: "app_user", entityId: id,
        changes: { email: body.email, displayName: body.displayName, designation: body.designation, primaryLocationId: body.primaryLocationId },
      });
      return { id };
    });
  }

  /**
   * Bulk create (docs/admin-api.md). All or nothing: every row is checked and
   * inserted in one transaction, and the transaction is rolled back when any
   * row fails or when `dryRun` is set, so a preview shows exactly what a real
   * run would do. Each user goes through the same definer function and audit
   * event as the single create; each role through `authz.request_role`, so
   * restricted roles still wait for a second approver (AD-3).
   */
  async bulkCreateUsers(user: AuthedUser, body: BulkCreateUsers) {
    type RoleResult = { role: Role; label: string; status: "applied" | "pending_approval" };
    type Row = { row: number; email: string; displayName: string; status: "ok" | "error"; error?: string; id?: string; roles: RoleResult[] };
    try {
      return await this.tx(user, async (c) => {
        const locs = (await c.query<{ id: string; name: string }>(`SELECT id, name FROM eureka.location`)).rows;
        const byName = new Map(locs.map((l) => [l.name.trim().toLowerCase(), l.id]));
        const seen = new Set<string>();
        const results: Row[] = [];
        for (const [i, r] of body.rows.entries()) {
          const email = r.email.trim();
          const displayName = r.displayName.trim();
          const designation = r.designation?.trim() || null;
          const locName = r.location?.trim();
          const res: Row = { row: i + 1, email, displayName, status: "ok", roles: [] };
          results.push(res);
          const fail = (code: string) => { res.status = "error"; res.error = code; };
          if (!EMAIL.safeParse(email).success) { fail("invalid_email"); continue; }
          if (!this.emailAllowed(email)) { fail("email_domain"); continue; }
          if (!displayName) { fail("name_required"); continue; }
          if (seen.has(email.toLowerCase())) { fail("duplicate_in_file"); continue; }
          seen.add(email.toLowerCase());
          const locationId = locName ? byName.get(locName.toLowerCase()) : null;
          if (locName && !locationId) { fail("unknown_location"); continue; }
          const roles = (r.roles ?? []).map((x) => x.trim()).filter(Boolean).map(roleFromText);
          if (roles.includes(null)) { fail("unknown_role"); continue; }
          const wanted = roles as Role[];
          if (new Set(wanted).size !== wanted.length) { fail("duplicate_role"); continue; }
          if (wanted.includes("org_admin") && wanted.length > 1) { fail("separation_of_duties"); continue; }
          if (wanted.some((k) => LOCATION_ROLES.includes(k)) && !locationId) { fail("location_required"); continue; }
          await c.query("SAVEPOINT bulk_row");
          try {
            const { rows } = await c.query<{ id: string }>(
              `SELECT authz.admin_create_user($1, $2, $3, $4) AS id`, [email, displayName, designation, locationId ?? null]);
            res.id = rows[0]!.id;
            await this.audit.record(c, {
              actorId: user.id, action: "admin.user.created", entityType: "app_user", entityId: res.id,
              changes: { email, displayName, designation: designation ?? undefined, primaryLocationId: locationId ?? undefined, bulk: true },
            });
            for (const role of wanted) {
              const roleLocation = LOCATION_ROLES.includes(role) ? locationId! : null;
              const q = (await c.query<{ request_id: string; request_status: "applied" | "pending_approval" }>(
                `SELECT * FROM authz.request_role($1, $2, $3)`, [res.id, role, roleLocation])).rows[0]!;
              await this.audit.record(c, {
                actorId: user.id,
                action: q.request_status === "applied" ? "admin.role.granted" : "admin.role.requested",
                entityType: "app_user", entityId: res.id,
                changes: { requestId: q.request_id, role, locationId: roleLocation, bulk: true },
              });
              res.roles.push({ role, label: ROLE_LABELS[role], status: q.request_status });
            }
            await c.query("RELEASE SAVEPOINT bulk_row");
          } catch (err) {
            const e = err as { code?: string; constraint?: string; message?: string };
            const code = e.code === "23505" && e.constraint === "app_user_email_key" ? "email_exists"
              : e.code !== undefined && e.message !== undefined && ROW_ROLE_ERRORS.has(e.message) ? e.message : null;
            if (!code) throw err; // not_permitted and anything unexpected abort the whole import
            await c.query("ROLLBACK TO SAVEPOINT bulk_row");
            delete res.id;
            res.roles = [];
            fail(code);
          }
        }
        const failed = results.filter((x) => x.status === "error").length;
        const committed = !body.dryRun && failed === 0;
        const report = { dryRun: body.dryRun, committed, created: committed ? results.length : 0, failed,
          rows: committed ? results : results.map(({ id: _id, ...rest }) => rest) };
        if (!committed) throw new BulkOutcome(report);
        await this.audit.record(c, {
          actorId: user.id, action: "admin.user.bulk_created", entityType: "app_user",
          changes: { count: results.length, roles: results.reduce((n, x) => n + x.roles.length, 0) },
        });
        return report;
      });
    } catch (err) {
      if (err instanceof BulkOutcome) return err.report;
      throw err;
    }
  }

  /** The bulk import template (docs/admin-api.md): an .xlsx with role and location dropdowns. */
  async bulkTemplate(user: AuthedUser): Promise<Buffer> {
    const locations = await this.tx(user, async (c) =>
      (await c.query<{ name: string }>(`SELECT name FROM eureka.location ORDER BY name`)).rows.map((l) => l.name));
    return buildUserImportTemplate(ROLES.map((k) => ROLE_LABELS[k]), locations);
  }

  async setStatus(user: AuthedUser, id: string, active: boolean) {
    this.notSelf(user, id);
    await this.tx(user, async (c) => {
      await c.query(`SELECT authz.admin_set_user_status($1, $2)`, [id, active]);
      await this.audit.record(c, {
        actorId: user.id, action: active ? "admin.user.reactivated" : "admin.user.deactivated",
        entityType: "app_user", entityId: id,
      });
    });
  }

  async setManager(user: AuthedUser, id: string, managerId: string | null) {
    this.notSelf(user, id);
    this.notSelf(user, managerId);
    await this.tx(user, async (c) => {
      await c.query(`SELECT authz.admin_set_manager($1, $2)`, [id, managerId]);
      await this.audit.record(c, {
        actorId: user.id, action: "admin.user.manager", entityType: "app_user", entityId: id, changes: { managerId },
      });
    });
  }

  // ---------- roles ----------

  private checkLocation(role: Role, locationId: string | undefined): void {
    const bound = LOCATION_ROLES.includes(role);
    if (bound && !locationId) throw new UnprocessableEntityException("location_required");
    if (!bound && locationId) throw new UnprocessableEntityException("location_not_allowed");
  }

  async requestRole(user: AuthedUser, body: CreateRoleRequest) {
    this.notSelf(user, body.userId);
    this.checkLocation(body.role, body.locationId);
    return this.tx(user, async (c) => {
      const { rows } = await c.query<{ request_id: string; request_status: "applied" | "pending_approval" }>(
        `SELECT * FROM authz.request_role($1, $2, $3)`, [body.userId, body.role, body.locationId ?? null]);
      const r = rows[0]!;
      await this.audit.record(c, {
        actorId: user.id,
        action: r.request_status === "applied" ? "admin.role.granted" : "admin.role.requested",
        entityType: "app_user", entityId: body.userId,
        changes: { requestId: r.request_id, role: body.role, locationId: body.locationId ?? null },
      });
      return { id: r.request_id, status: r.request_status };
    });
  }

  async listRoleRequests(user: AuthedUser, status: string | undefined) {
    return this.tx(user, async (c) => {
      const { rows } = await c.query<{
        id: string; user_id: string; user_name: string; user_email: string; role_key: string; location_id: string | null;
        requested_by: string; requested_by_name: string; requested_at: Date; status: string;
        decided_by: string | null; decided_by_name: string | null; decided_at: Date | null;
      }>(
        `SELECT * FROM (
           SELECT q.id, q.user_id, u.display_name AS user_name, u.email::text AS user_email, q.role_key, q.location_id,
                  q.requested_by, rb.display_name AS requested_by_name, q.requested_at,
                  CASE WHEN q.status = 'pending' AND q.expires_at <= now() THEN 'expired' ELSE q.status END AS status,
                  q.decided_by, d.display_name AS decided_by_name, q.decided_at
           FROM eureka.role_request q
           JOIN eureka.app_user u ON u.id = q.user_id
           JOIN eureka.app_user rb ON rb.id = q.requested_by
           LEFT JOIN eureka.app_user d ON d.id = q.decided_by) s
         WHERE $1::text IS NULL OR s.status = $1
         ORDER BY s.requested_at DESC, s.id LIMIT 500`, [status ?? null]);
      return {
        items: rows.map((r) => ({
          id: r.id,
          user: { id: r.user_id, displayName: r.user_name, email: r.user_email },
          role: r.role_key,
          roleLabel: label(r.role_key),
          locationId: r.location_id,
          requestedBy: { id: r.requested_by, displayName: r.requested_by_name },
          requestedAt: r.requested_at,
          status: r.status,
          decidedBy: r.decided_by ? { id: r.decided_by, displayName: r.decided_by_name } : null,
          decidedAt: r.decided_at,
        })),
      };
    });
  }

  async decide(user: AuthedUser, id: string, decision: "approve" | "reject") {
    return this.tx(user, async (c) => {
      const fn = decision === "approve" ? "authz.approve_role_request" : "authz.reject_role_request";
      const { rows } = await c.query<{ s: "approved" | "rejected" }>(`SELECT ${fn}($1) AS s`, [id]);
      await this.audit.record(c, {
        actorId: user.id, action: `admin.role_request.${rows[0]!.s}`, entityType: "role_request", entityId: id,
      });
      return { status: rows[0]!.s };
    });
  }

  async revokeRole(user: AuthedUser, userId: string, role: Role, locationId: string | undefined) {
    this.notSelf(user, userId);
    if (locationId && !LOCATION_ROLES.includes(role)) throw new UnprocessableEntityException("location_not_allowed");
    await this.tx(user, async (c) => {
      await c.query(`SELECT authz.revoke_role($1, $2, $3)`, [userId, role, locationId ?? null]);
      await this.audit.record(c, {
        actorId: user.id, action: "admin.role.revoked", entityType: "app_user", entityId: userId,
        changes: { role, locationId: locationId ?? null },
      });
    });
  }

  // ---------- teams ----------

  async listTeams(user: AuthedUser) {
    return this.tx(user, async (c) => {
      const teams = await c.query<{
        id: string; name: string; location_id: string | null; location_name: string | null; lead_id: string; lead_name: string;
        department_id: string | null; department_name: string | null; parent_id: string | null; parent_name: string | null;
      }>(
        `SELECT t.id, t.name, t.location_id, l.name AS location_name, t.lead_id, u.display_name AS lead_name,
                d.id AS department_id, d.name AS department_name, p.id AS parent_id, p.name AS parent_name
         FROM eureka.team t JOIN eureka.app_user u ON u.id = t.lead_id
         LEFT JOIN eureka.location l ON l.id = t.location_id
         LEFT JOIN eureka.department d ON d.id = u.department_id LEFT JOIN eureka.department p ON p.id = d.parent_id
         ORDER BY t.name, t.id`);
      const members = await c.query<{ team_id: string; id: string; display_name: string }>(
        `SELECT tm.team_id, u.id, u.display_name FROM eureka.team_member tm
         JOIN eureka.app_user u ON u.id = tm.user_id WHERE tm.valid @> now() ORDER BY u.display_name`);
      const coached = await this.teamCoaches(c, null);
      const coaches = await this.coachUsers(c, null);
      // Active users who neither lead nor belong to a team (Teams tab "Assign them" hint).
      const unassigned = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM eureka.app_user u WHERE u.status = 'active'
           AND NOT EXISTS (SELECT 1 FROM eureka.team_member tm WHERE tm.user_id = u.id AND tm.valid @> now())
           AND NOT EXISTS (SELECT 1 FROM eureka.team t WHERE t.lead_id = u.id)`);
      return {
        unassignedCount: unassigned.rows[0]!.n,
        items: teams.rows.map((t) => ({
          id: t.id,
          name: t.name,
          location: t.location_id ? { id: t.location_id, name: t.location_name } : null,
          lead: { id: t.lead_id, displayName: t.lead_name },
          // The lead's department (descriptive; Teams tab card header).
          department: departmentOf(t),
          members: members.rows.filter((m) => m.team_id === t.id).map((m) => ({ id: m.id, displayName: m.display_name })),
          coaches: coached.filter((m) => m.team_id === t.id).map((m) => ({ id: m.id, displayName: m.display_name })),
        })),
        coaches,
      };
    });
  }

  async createTeam(user: AuthedUser, body: CreateTeam) {
    this.notSelf(user, body.leadId);
    return this.tx(user, async (c) => {
      const { rows } = await c.query<{ id: string }>(`SELECT authz.admin_create_team($1, $2, $3) AS id`,
        [body.name, body.leadId, body.locationId ?? null]);
      const id = rows[0]!.id;
      await this.audit.record(c, { actorId: user.id, action: "admin.team.created", entityType: "team", entityId: id, changes: body });
      return { id };
    });
  }

  // The name is free text, so the audit row records only that it changed (rule 5).
  async renameTeam(user: AuthedUser, teamId: string, name: string) {
    await this.tx(user, async (c) => {
      await c.query(`SELECT authz.admin_rename_team($1, $2)`, [teamId, name]);
      await this.audit.record(c, { actorId: user.id, action: "admin.team.renamed", entityType: "team", entityId: teamId });
    });
  }

  // ---------- departments ----------
  // Descriptive only (migration 0230): nothing in authz reads a department.

  async listDepartments(user: AuthedUser) {
    return this.tx(user, async (c) => {
      const { rows } = await c.query<{ id: string; name: string; parent_id: string | null; user_count: number }>(
        `SELECT d.id, d.name, d.parent_id,
                (SELECT count(*)::int FROM eureka.app_user u WHERE u.department_id = d.id AND u.status = 'active') AS user_count
         FROM eureka.department d ORDER BY lower(d.name), d.id`);
      return { items: rows.map((r) => ({ id: r.id, name: r.name, parentId: r.parent_id, userCount: r.user_count })) };
    });
  }

  // Names are free text, so audit rows record ids only (rule 5).
  async createDepartment(user: AuthedUser, body: CreateDepartment) {
    return this.tx(user, async (c) => {
      const { rows } = await c.query<{ id: string }>(`SELECT authz.admin_create_department($1, $2) AS id`,
        [body.name, body.parentId ?? null]);
      const id = rows[0]!.id;
      await this.audit.record(c, {
        actorId: user.id, action: "admin.department.created", entityType: "department", entityId: id,
        changes: { parentId: body.parentId ?? null },
      });
      return { id };
    });
  }

  async renameDepartment(user: AuthedUser, departmentId: string, name: string) {
    await this.tx(user, async (c) => {
      await c.query(`SELECT authz.admin_rename_department($1, $2)`, [departmentId, name]);
      await this.audit.record(c, { actorId: user.id, action: "admin.department.renamed", entityType: "department", entityId: departmentId });
    });
  }

  async setDepartment(user: AuthedUser, userId: string, departmentId: string | null) {
    await this.tx(user, async (c) => {
      const { rows } = await c.query<{ previous: string | null }>(
        `SELECT authz.admin_set_user_department($1, $2) AS previous`, [userId, departmentId]);
      await this.audit.record(c, {
        actorId: user.id, action: "admin.user.department", entityType: "app_user", entityId: userId,
        changes: { departmentId, previous: rows[0]!.previous },
      });
    });
  }

  async createLocation(user: AuthedUser, body: CreateLocation) {
    return this.tx(user, async (c) => {
      const { rows } = await c.query<{ id: string }>(`SELECT authz.admin_create_location($1, $2, $3, $4) AS id`,
        [body.name, body.kind, body.state ?? null, body.timezone ?? null]);
      const id = rows[0]!.id;
      await this.audit.record(c, { actorId: user.id, action: "admin.location.created", entityType: "location", entityId: id, changes: body });
      return { id };
    });
  }

  async setLead(user: AuthedUser, teamId: string, leadId: string) {
    this.notSelf(user, leadId);
    await this.tx(user, async (c) => {
      await c.query(`SELECT authz.admin_set_team_lead($1, $2)`, [teamId, leadId]);
      await this.audit.record(c, { actorId: user.id, action: "admin.team.lead", entityType: "team", entityId: teamId, changes: { leadId } });
    });
  }

  async addMember(user: AuthedUser, teamId: string, userId: string) {
    this.notSelf(user, userId);
    await this.tx(user, async (c) => {
      await c.query(`SELECT authz.admin_add_team_member($1, $2)`, [teamId, userId]);
      await this.audit.record(c, { actorId: user.id, action: "admin.team.member_added", entityType: "team", entityId: teamId, changes: { userId } });
    });
  }

  /**
   * Adds several people to one team. Each add runs on its own (authz.admin_add_team_member),
   * so one person already in a team does not block the rest; failures come back per user
   * with the contract error code. 404 if the team does not exist.
   */
  async addMembers(user: AuthedUser, teamId: string, userIds: string[]) {
    const exists = await this.tx(user, async (c) =>
      (await c.query(`SELECT 1 FROM eureka.team WHERE id = $1`, [teamId])).rowCount === 1);
    if (!exists) throw new NotFoundException();
    const added: string[] = [];
    const failed: { userId: string; error: string }[] = [];
    for (const userId of [...new Set(userIds)]) {
      try {
        await this.addMember(user, teamId, userId);
        added.push(userId);
      } catch (err) {
        if (!(err instanceof HttpException)) throw err;
        const res = err.getResponse();
        const code = typeof res === "object" && res && "message" in res ? String((res as { message: unknown }).message) : err.message;
        failed.push({ userId, error: err.getStatus() === 404 ? "user_not_found" : code });
      }
    }
    return { added, failed };
  }

  /**
   * Designation (display label) of another user (migration 0111). `via`
   * "admin": access:manage (Users & Access, any user); "hierarchy":
   * designation:change over the users the grant covers. Read before write:
   * 404 for an unknown user, 403 outside the caller's scope or for themself;
   * authz.set_designation re-checks all of it in the database.
   */
  async setDesignation(user: AuthedUser, targetId: string, designation: string | null, via: "admin" | "hierarchy") {
    return this.tx(user, async (c) => {
      const before = (await c.query<{ designation: string | null }>(
        `SELECT designation FROM eureka.app_user WHERE id = $1`, [targetId])).rows[0];
      if (!before) throw new NotFoundException();
      this.notSelf(user, targetId);
      if (via === "hierarchy") {
        const scope = resolveScope(user.access, "designation:change");
        if (!scope) throw new ForbiddenException("not_permitted");
        if (!scope.all) {
          const covered = (await c.query<{ ok: boolean }>(
            `SELECT $1::uuid = ANY (authz.scope_user_ids('designation:change')) AS ok`, [targetId])).rows[0]!.ok;
          if (!covered) throw new ForbiddenException("not_in_scope");
        }
      }
      await c.query(`SELECT authz.set_designation($1, $2)`, [targetId, designation]);
      await this.audit.record(c, {
        actorId: user.id, action: "user.designation_changed", entityType: "app_user", entityId: targetId,
        changes: { designation, previous: before.designation, via },
      });
      return { id: targetId, designation };
    });
  }

  // ---------- coach assignments (AD-11) ----------

  /** Current coach assignments, limited to the given coaches (null: everyone). */
  private async teamCoaches(c: pg.PoolClient, coachIds: string[] | null) {
    return (await c.query<{ team_id: string; id: string; display_name: string }>(
      `SELECT ca.team_id, u.id, u.display_name FROM eureka.coach_assignment ca
       JOIN eureka.app_user u ON u.id = ca.coach_id
       WHERE ca.valid @> now() AND ($1::uuid[] IS NULL OR ca.coach_id = ANY ($1::uuid[]))
       ORDER BY u.display_name, u.id`, [coachIds])).rows;
  }

  /** Active users holding a coach role (interview_coach, interview_lead), limited to the given ids (null: everyone). */
  private async coachUsers(c: pg.PoolClient, ids: string[] | null) {
    const { rows } = await c.query<{ id: string; display_name: string; email: string; lead: boolean }>(
      `SELECT u.id, u.display_name, u.email,
              bool_or(ur.role_key = 'interview_lead') AS lead
       FROM eureka.app_user u JOIN eureka.user_role ur ON ur.user_id = u.id
       WHERE u.status = 'active' AND ur.valid @> now() AND ur.role_key IN ('interview_coach', 'interview_lead')
         AND ($1::uuid[] IS NULL OR u.id = ANY ($1::uuid[]))
       GROUP BY u.id ORDER BY u.display_name, u.id`, [ids]);
    return rows.map((u) => ({ id: u.id, displayName: u.display_name, email: u.email, role: u.lead ? "interview_lead" : "interview_coach" }));
  }

  /**
   * AD-11, coach:assign: every team (coaches support any sales team) with the
   * caller's assignable coaches on it, and those coaches: active coach-role
   * holders below the caller in the reporting hierarchy (everyone for an org grant).
   */
  async coachAssignments(user: AuthedUser) {
    const scope = resolveScope(user.access, "coach:assign");
    if (!scope) throw new ForbiddenException("not_permitted");
    const ids = scope.all ? null : user.access.subordinateUserIds;
    return this.tx(user, async (c) => {
      const teams = await c.query<{ id: string; name: string; lead_id: string; lead_name: string }>(
        `SELECT t.id, t.name, t.lead_id, u.display_name AS lead_name
         FROM eureka.team t JOIN eureka.app_user u ON u.id = t.lead_id ORDER BY t.name, t.id`);
      const coaches = await this.coachUsers(c, ids);
      const coached = await this.teamCoaches(c, coaches.map((u) => u.id));
      return {
        items: teams.rows.map((t) => ({
          id: t.id,
          name: t.name,
          lead: { id: t.lead_id, displayName: t.lead_name },
          coaches: coached.filter((m) => m.team_id === t.id).map((m) => ({ id: m.id, displayName: m.display_name })),
        })),
        coaches,
      };
    });
  }

  /**
   * AD-11: assign a coach to a team or end the assignment. `via` "admin":
   * access:manage, any coach; "hierarchy": coach:assign over the coaches below
   * the caller. 404 unknown team, 403 self or outside the scope; the definer
   * functions re-check everything. Audited with ids only.
   */
  async changeCoach(user: AuthedUser, via: "admin" | "hierarchy", op: "assign" | "unassign", teamId: string, coachId: string) {
    this.notSelf(user, coachId);
    if (via === "hierarchy") {
      const scope = resolveScope(user.access, "coach:assign");
      if (!scope) throw new ForbiddenException("not_permitted");
      if (!scope.all && !user.access.subordinateUserIds.includes(coachId)) throw new ForbiddenException("not_in_scope");
    }
    await this.tx(user, async (c) => {
      const team = await c.query(`SELECT 1 FROM eureka.team WHERE id = $1`, [teamId]);
      if (team.rowCount === 0) throw new NotFoundException();
      await c.query(`SELECT authz.${op}_coach($1, $2)`, [coachId, teamId]);
      await this.audit.record(c, {
        actorId: user.id, action: `${via === "admin" ? "admin." : ""}team.coach_${op}ed`, entityType: "team", entityId: teamId,
        changes: { coachId },
      });
    });
  }

  /** OD-07 / AD-8: team:move_member must cover both teams (engine here, definer function in the database). */
  /**
   * AD-10: the teams the caller may add members to (the ones they lead, plus
   * any a hierarchy or org grant covers), with their members and the active
   * recruiters who are in no team yet: for team/hierarchy callers, only those
   * with no manager yet or below the caller (or a lead of one of those teams)
   * in the reporting line.
   */
  async myTeams(user: AuthedUser) {
    const all = !!resolveScope(user.access, "team:add_member")?.all;
    const wider = [...(resolveScopeFor(user.access, "team:add_member", ["hierarchy"])?.teamIds ?? [])];
    return this.tx(user, async (c) => {
      const teams = await c.query<{ id: string; name: string; lead_id: string; lead_name: string }>(
        `SELECT t.id, t.name, t.lead_id, u.display_name AS lead_name
         FROM eureka.team t JOIN eureka.app_user u ON u.id = t.lead_id
         WHERE $1::boolean OR t.lead_id = $2 OR t.id = ANY ($3::uuid[]) ORDER BY t.name, t.id`, [all, user.id, wider]);
      const members = await c.query<{ team_id: string; id: string; display_name: string }>(
        `SELECT tm.team_id, u.id, u.display_name FROM eureka.team_member tm
         JOIN eureka.app_user u ON u.id = tm.user_id
         WHERE tm.valid @> now() AND tm.team_id = ANY ($1::uuid[]) ORDER BY u.display_name`, [teams.rows.map((t) => t.id)]);
      const addable = await c.query<{ id: string; display_name: string; email: string }>(
        `SELECT u.id, u.display_name, u.email FROM eureka.app_user u
         WHERE u.status = 'active' AND u.id <> $1
           AND EXISTS (SELECT 1 FROM eureka.user_role ur WHERE ur.user_id = u.id AND ur.role_key = 'recruiter' AND ur.valid @> now())
           AND NOT EXISTS (SELECT 1 FROM eureka.team_member tm WHERE tm.user_id = u.id AND tm.valid @> now())
           AND ($2::boolean
             OR NOT EXISTS (SELECT 1 FROM eureka.reporting_closure rc WHERE rc.descendant_id = u.id)
             OR EXISTS (SELECT 1 FROM eureka.reporting_closure rc
                 WHERE rc.descendant_id = u.id AND rc.ancestor_id = ANY ($3::uuid[])))
         ORDER BY u.display_name, u.id LIMIT 500`, [user.id, all, [user.id, ...teams.rows.map((t) => t.lead_id)]]);
      return {
        items: teams.rows.map((t) => ({
          id: t.id,
          name: t.name,
          lead: { id: t.lead_id, displayName: t.lead_name },
          members: members.rows.filter((m) => m.team_id === t.id).map((m) => ({ id: m.id, displayName: m.display_name })),
        })),
        addable: addable.rows.map((u) => ({ id: u.id, displayName: u.display_name, email: u.email })),
      };
    });
  }

  /**
   * AD-10: add an unassigned recruiter to a team the caller leads. 404 for an
   * unknown team, 403 outside the caller's teams; authz.team_add_member
   * re-checks all of it in the database.
   */
  async leadAddMember(user: AuthedUser, teamId: string, userId: string) {
    this.notSelf(user, userId);
    await this.tx(user, async (c) => {
      const team = (await c.query<{ lead_id: string }>(`SELECT lead_id FROM eureka.team WHERE id = $1`, [teamId])).rows[0];
      if (!team) throw new NotFoundException();
      const covered = !!resolveScope(user.access, "team:add_member")?.all
        || team.lead_id === user.id
        || !!resolveScopeFor(user.access, "team:add_member", ["hierarchy"])?.teamIds.has(teamId);
      if (!covered) throw new ForbiddenException("not_in_scope");
      await c.query(`SELECT authz.team_add_member($1, $2)`, [teamId, userId]);
      await this.audit.record(c, { actorId: user.id, action: "team.member_added", entityType: "team", entityId: teamId, changes: { userId } });
    });
  }

  async moveMember(user: AuthedUser, fromTeamId: string, body: MoveMember) {
    this.notSelf(user, body.userId);
    const scope = resolveScope(user.access, "team:move_member");
    if (!scope || !(scope.all || (scope.teamIds.has(fromTeamId) && scope.teamIds.has(body.toTeamId)))) {
      throw new ForbiddenException("not_in_scope");
    }
    return this.tx(user, async (c) => {
      const { rows } = await c.query<{ moved_candidates: number; reassigned_to: string }>(
        `SELECT * FROM authz.move_team_member($1, $2, $3, $4)`,
        [body.userId, fromTeamId, body.toTeamId, body.reassignTo ?? null]);
      const r = rows[0]!;
      const target = await c.query<{ display_name: string }>(
        `SELECT display_name FROM eureka.app_user WHERE id = $1`, [r.reassigned_to]);
      await this.audit.record(c, {
        actorId: user.id, action: "team.member_moved", entityType: "team", entityId: fromTeamId,
        changes: { userId: body.userId, fromTeamId, toTeamId: body.toTeamId, reassignedTo: r.reassigned_to, movedCandidates: r.moved_candidates },
      });
      return {
        movedCandidates: r.moved_candidates,
        reassignedTo: { id: r.reassigned_to, displayName: target.rows[0]?.display_name ?? null },
      };
    });
  }
}
