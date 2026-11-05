import { createHash, randomBytes } from "node:crypto";
import { BadGatewayException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { resolveScope } from "@eureka/shared";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { CONFIG, parseEmailList, type AppConfig } from "../../platform/config.js";
import { MAIL_PORT, type MailPort } from "../../platform/mail.js";
import { likeContains } from "../../platform/sql.js";
import { USER_PURGE_DAYS } from "../../worker/jobs/user-purge.js";
import { departmentOf, roleLabels, roleRows } from "./admin-queries.js";
import { AdminTx, notSelf } from "./admin-tx.js";
import type { CreateUser, UserListQuery } from "./admin.schemas.js";

/** How long an emailed set-password link stays open. */
export const PASSWORD_INVITE_TTL_HOURS = 72;

/**
 * Whether an email may belong to a user: in the Google hosted domain, or on
 * the staging test list, or any email when password sign-in is on (staging
 * and local only; the config refuses it elsewhere).
 */
export function emailAllowed(config: AppConfig, email: string): boolean {
  const domain = config.GOOGLE_HOSTED_DOMAIN?.trim().toLowerCase();
  if (!domain || config.PASSWORD_LOGIN === "on") return true;
  const e = email.trim().toLowerCase();
  return e.endsWith(`@${domain}`) || parseEmailList(config.AUTH_TEST_EMAILS).includes(e);
}

/**
 * Users & Access: the user list, single-user writes and designations
 * (docs/admin-api.md "Users"). The controllers check the permission; this
 * service applies the self-change rule in the application layer, and every
 * write goes through a definer function that re-checks it in the database
 * (migration 0013). Each change is audited in the same transaction.
 */
@Injectable()
export class AdminUsersService {
  // Logger context kept from the former AdminService so log lines are unchanged.
  private readonly log = new Logger("AdminService");

  constructor(
    private readonly tx: AdminTx,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(MAIL_PORT) private readonly mail: MailPort,
  ) {}

  async meta(user: AuthedUser) {
    const { locations, singleAdminMode, roles } = await this.tx.run(user, async (c) => ({
      locations: (await c.query<{ id: string; name: string }>(`SELECT id, name FROM eureka.location ORDER BY name`)).rows,
      roles: await roleRows(c),
      // Migration 0084/0085: one admin may grant restricted roles without a second approver.
      singleAdminMode: (await c.query<{ on: boolean }>(`SELECT authz.single_admin_mode() AS "on"`)).rows[0]!.on,
    }));
    return {
      singleAdminMode,
      // Live roles in ladder order: what the grant pickers offer (docs/roles-api.md).
      roles: roles.filter((r) => !r.archived_at).map((r) => ({
        key: r.key,
        label: r.label,
        restricted: r.is_restricted,
        locationBound: r.is_location_bound,
        isSystem: r.is_system,
        track: r.track,
        level: r.level,
        recruiter: r.is_recruiter,
        department: r.department_id ? { id: r.department_id, name: r.department_name! } : null,
      })),
      locations,
    };
  }

  // ---------- users ----------

  async listUsers(user: AuthedUser, q: UserListQuery) {
    return this.tx.run(user, async (c) => {
      const params: unknown[] = [];
      // Deleted users (migration 0280) are anonymized tombstones, never listed.
      const where: string[] = ["u.deleted_at IS NULL"];
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
        deactivated_at: Date | null; location_id: string | null; location_name: string | null;
        department_id: string | null; department_name: string | null; parent_id: string | null; parent_name: string | null;
      }>(
        `SELECT u.id, u.email, u.display_name, u.designation, u.status, u.deactivated_at,
                u.primary_location_id AS location_id, l.name AS location_name,
                d.id AS department_id, d.name AS department_name, p.id AS parent_id, p.name AS parent_name
         FROM eureka.app_user u LEFT JOIN eureka.location l ON l.id = u.primary_location_id
         LEFT JOIN eureka.department d ON d.id = u.department_id LEFT JOIN eureka.department p ON p.id = d.parent_id
         WHERE ${where.join(" AND ")}
         ORDER BY u.id LIMIT $${params.length}`, params);
      const page = rows.slice(0, q.limit);
      const ids = page.map((r) => r.id);

      const managers = await c.query<{ user_id: string; id: string; display_name: string }>(
        `SELECT rl.user_id, m.id, m.display_name FROM eureka.reporting_line rl
         JOIN eureka.app_user m ON m.id = rl.manager_id
         WHERE rl.user_id = ANY($1::uuid[]) AND rl.valid @> now()`, [ids]);
      const labels = await roleLabels(c);
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
            // When the worker deletes this inactive user unless reactivated (USER_PURGE_DAYS after deactivation).
            ...(r.status === "inactive" && r.deactivated_at
              ? { deletesAt: new Date(r.deactivated_at.getTime() + USER_PURGE_DAYS * 86_400_000).toISOString() } : {}),
            primaryLocation: r.location_id ? { id: r.location_id, name: r.location_name } : null,
            department: departmentOf(r),
            manager: m ? { id: m.id, displayName: m.display_name } : null,
            roles: roles.rows.filter((x) => x.user_id === r.id).map((x) => ({
              key: x.role_key, label: labels.get(x.role_key) ?? x.role_key, locationId: x.location_id, locationName: x.location_name,
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
    return this.tx.run(user, async (c) => {
      const { rows } = await c.query<{ role_key: string; n: number }>(
        `SELECT ur.role_key, count(DISTINCT ur.user_id)::int AS n
         FROM eureka.user_role ur JOIN eureka.app_user u ON u.id = ur.user_id
         WHERE ur.valid @> now() AND u.status = 'active'
         GROUP BY ur.role_key HAVING count(*) > 0`);
      const counts = new Map(rows.map((r) => [r.role_key, r.n]));
      const roles = await roleRows(c);
      const totals = (await c.query<{ active: number; inactive: number }>(
        `SELECT count(*) FILTER (WHERE status = 'active')::int AS active, count(*) FILTER (WHERE status = 'inactive')::int AS inactive
         FROM eureka.app_user WHERE deleted_at IS NULL`)).rows[0]!;
      return {
        active: totals.active,
        inactive: totals.inactive,
        roles: roles.filter((r) => counts.has(r.key)).map((r) => ({ key: r.key, label: r.label, count: counts.get(r.key)! })),
      };
    });
  }

  /** An org admin sets a temporary password for a user (staging/local); the user must change it at first sign-in. */
  async setPassword(user: AuthedUser, id: string, password: string): Promise<void> {
    if (this.config.PASSWORD_LOGIN !== "on") throw new NotFoundException();
    await this.tx.run(user, async (c) => { await c.query(`SELECT authz.admin_set_password($1, $2)`, [id, password]); });
  }

  /**
   * An org admin emails a user a one-time set-password link (staging/local,
   * migration 0270). Only the token's SHA-256 is stored; the token travels in
   * the link's fragment so it never reaches server or proxy logs. A newer link
   * replaces any open one. 502 when the mail could not be sent (the link stays
   * valid; sending again replaces it).
   */
  async sendPasswordInvite(user: AuthedUser, id: string): Promise<void> {
    if (this.config.PASSWORD_LOGIN !== "on") throw new NotFoundException();
    const token = randomBytes(32).toString("base64url");
    const email = await this.tx.run(user, async (c) => (await c.query<{ email: string }>(
      `SELECT authz.admin_issue_password_setup($1, $2, $3) AS email`,
      [id, createHash("sha256").update(token).digest(), PASSWORD_INVITE_TTL_HOURS])).rows[0]!.email);
    const link = `${this.config.PUBLIC_BASE_URL.replace(/\/+$/, "")}/set-password#token=${token}`;
    try {
      await this.mail.send({
        to: email,
        subject: "Set your Eureka password",
        text: [
          "An administrator added you to Eureka.",
          "",
          "Choose your password and sign in here:",
          link,
          "",
          `The link works once and expires in ${PASSWORD_INVITE_TTL_HOURS} hours. If you did not expect this email, you can ignore it.`,
        ].join("\n"),
      });
    } catch (err) {
      this.log.warn(`password invite mail failed (${(err as { name?: string })?.name ?? "error"})`);
      throw new BadGatewayException("mail_failed");
    }
  }

  async createUser(user: AuthedUser, body: CreateUser) {
    if (!emailAllowed(this.config, body.email)) throw new UnprocessableEntityException("email_domain");
    if ((body.temporaryPassword !== undefined || body.sendPasswordInvite) && this.config.PASSWORD_LOGIN !== "on") {
      throw new UnprocessableEntityException("password_login_disabled");
    }
    if (body.temporaryPassword !== undefined && body.sendPasswordInvite) throw new UnprocessableEntityException("password_or_invite");
    const created = await this.tx.run(user, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `SELECT authz.admin_create_user($1, $2, $3, $4) AS id`,
        [body.email, body.displayName, body.designation ?? null, body.primaryLocationId ?? null]);
      const id = rows[0]!.id;
      if (body.temporaryPassword !== undefined) await c.query(`SELECT authz.admin_set_password($1, $2)`, [id, body.temporaryPassword]);
      // Names and designations are free text: the audit row keeps ids and the fields set (rule 5, as renames do).
      await this.tx.audit.record(c, {
        actorId: user.id, action: "admin.user.created", entityType: "app_user", entityId: id,
        changes: { fields: Object.keys(body), primaryLocationId: body.primaryLocationId ?? null },
      });
      return { id };
    });
    if (!body.sendPasswordInvite) return created;
    // The user exists either way; the admin can resend from the Users tab.
    try {
      await this.sendPasswordInvite(user, created.id);
      return { ...created, invite: "sent" as const };
    } catch {
      return { ...created, invite: "failed" as const };
    }
  }

  async setStatus(user: AuthedUser, id: string, active: boolean) {
    notSelf(user, id);
    await this.tx.run(user, async (c) => {
      await c.query(`SELECT authz.admin_set_user_status($1, $2)`, [id, active]);
      await this.tx.audit.record(c, {
        actorId: user.id, action: active ? "admin.user.reactivated" : "admin.user.deactivated",
        entityType: "app_user", entityId: id,
      });
    });
  }

  /** Deletes (anonymizes) a deactivated user now, without waiting for the purge (docs/admin-api.md, "Deleting users"). */
  async deleteUser(user: AuthedUser, id: string) {
    notSelf(user, id);
    await this.tx.run(user, async (c) => {
      await c.query(`SELECT authz.admin_delete_user($1)`, [id]);
      await this.tx.audit.record(c, { actorId: user.id, action: "admin.user.deleted", entityType: "app_user", entityId: id });
    });
  }

  async setManager(user: AuthedUser, id: string, managerId: string | null) {
    notSelf(user, id);
    notSelf(user, managerId);
    await this.tx.run(user, async (c) => {
      await c.query(`SELECT authz.admin_set_manager($1, $2)`, [id, managerId]);
      await this.tx.audit.record(c, {
        actorId: user.id, action: "admin.user.manager", entityType: "app_user", entityId: id, changes: { managerId },
      });
    });
  }

  async setDepartment(user: AuthedUser, userId: string, departmentId: string | null) {
    await this.tx.run(user, async (c) => {
      const { rows } = await c.query<{ previous: string | null }>(
        `SELECT authz.admin_set_user_department($1, $2) AS previous`, [userId, departmentId]);
      await this.tx.audit.record(c, {
        actorId: user.id, action: "admin.user.department", entityType: "app_user", entityId: userId,
        changes: { departmentId, previous: rows[0]!.previous },
      });
    });
  }

  /**
   * Designation (display label) of another user (migration 0111). `via`
   * "admin": access:manage (Users & Access, any user); "hierarchy":
   * designation:change over the users the grant covers. Read before write:
   * 404 for an unknown user, 403 outside the caller's scope or for themself;
   * authz.set_designation re-checks all of it in the database.
   */
  async setDesignation(user: AuthedUser, targetId: string, designation: string | null, via: "admin" | "hierarchy") {
    return this.tx.run(user, async (c) => {
      const before = (await c.query<{ designation: string | null }>(
        `SELECT designation FROM eureka.app_user WHERE id = $1`, [targetId])).rows[0];
      if (!before) throw new NotFoundException();
      notSelf(user, targetId);
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
      await this.tx.audit.record(c, {
        actorId: user.id, action: "user.designation_changed", entityType: "app_user", entityId: targetId,
        changes: { designation, previous: before.designation, via },
      });
      return { id: targetId, designation };
    });
  }
}
