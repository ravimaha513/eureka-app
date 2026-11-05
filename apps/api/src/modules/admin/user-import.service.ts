import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { CONFIG, type AppConfig } from "../../platform/config.js";
import { roleRows, type RoleRow } from "./admin-queries.js";
import { AdminTx } from "./admin-tx.js";
import type { BulkCreateUsers } from "./admin.schemas.js";
import { buildUserImportTemplate } from "./user-import-template.js";
import { emailAllowed } from "./users.service.js";

const EMAIL = z.string().email();

/** Thrown inside the transaction to roll it back while still returning the per-row report. */
class BulkOutcome extends Error {
  constructor(readonly report: unknown) { super("bulk_rollback"); }
}

/** Live roles by key and by label, case-insensitive, for the bulk import's role column. */
const roleIndex = (roles: RoleRow[]) =>
  new Map<string, RoleRow>(roles.filter((r) => !r.archived_at).flatMap((r) => [[r.key, r], [r.label.toLowerCase(), r]] as [string, RoleRow][]));

/** request_role failures that are a problem with one row, not with the import. */
const ROW_ROLE_ERRORS = new Set([
  "separation_of_duties", "role_violates_admin_separation", "location_required", "location_not_allowed", "role_already_held", "role_archived", "role_department_mismatch",
]);
/** admin_add_team_member failures that are a problem with one row (cycle: the member is above the team's lead, 0370). */
const ROW_TEAM_ERRORS = new Set(["already_member", "user_inactive", "cycle"]);

/** Bulk user import and its .xlsx template (docs/admin-api.md "Users"). */
@Injectable()
export class UserImportService {
  constructor(private readonly tx: AdminTx, @Inject(CONFIG) private readonly config: AppConfig) {}

  /**
   * Bulk create (docs/admin-api.md). All or nothing: every row is checked and
   * inserted in one transaction, and the transaction is rolled back when any
   * row fails or when `dryRun` is set, so a preview shows exactly what a real
   * run would do. Each user goes through the same definer function and audit
   * event as the single create; each role through `authz.request_role`, so
   * restricted roles still wait for a second approver (AD-3). Managers and
   * teams are set in a second pass, once every row exists, so a row's manager
   * may be another row of the same file.
   */
  async bulkCreateUsers(user: AuthedUser, body: BulkCreateUsers) {
    type RoleResult = { role: string; label: string; status: "applied" | "pending_approval" };
    type Row = {
      row: number; email: string; displayName: string; status: "ok" | "error"; error?: string; id?: string; roles: RoleResult[];
      manager?: string; team?: string;
    };
    type Link = { res: Row; managerEmail: string | null; teamId: string | null };
    try {
      return await this.tx.run(user, async (c) => {
        const locs = (await c.query<{ id: string; name: string }>(`SELECT id, name FROM eureka.location`)).rows;
        const byName = new Map(locs.map((l) => [l.name.trim().toLowerCase(), l.id]));
        const byRole = roleIndex(await roleRows(c));
        const teams = (await c.query<{ id: string; name: string }>(`SELECT id, name FROM eureka.team WHERE deleted_at IS NULL`)).rows;
        const teamsByName = new Map<string, { id: string; name: string }[]>();
        for (const t of teams) {
          const k = t.name.trim().toLowerCase();
          teamsByName.set(k, [...(teamsByName.get(k) ?? []), t]);
        }
        const fileEmails = new Set(body.rows.map((r) => r.email.trim().toLowerCase()));
        const managerEmails = [...new Set(body.rows.map((r) => r.manager?.trim().toLowerCase()).filter((x): x is string => !!x))];
        const existing = new Map((await c.query<{ email: string; id: string; display_name: string; status: string }>(
          `SELECT lower(email) AS email, id, display_name, status FROM eureka.app_user WHERE lower(email) = ANY ($1::text[])`,
          [managerEmails])).rows.map((u) => [u.email, u]));
        const seen = new Set<string>();
        const results: Row[] = [];
        const created = new Map<string, Row>();
        const links: Link[] = [];
        for (const [i, r] of body.rows.entries()) {
          const email = r.email.trim();
          const displayName = r.displayName.trim();
          const designation = r.designation?.trim() || null;
          const locName = r.location?.trim();
          const res: Row = { row: i + 1, email, displayName, status: "ok", roles: [] };
          results.push(res);
          const fail = (code: string) => { res.status = "error"; res.error = code; };
          if (!EMAIL.safeParse(email).success) { fail("invalid_email"); continue; }
          if (!emailAllowed(this.config, email)) { fail("email_domain"); continue; }
          if (!displayName) { fail("name_required"); continue; }
          if (seen.has(email.toLowerCase())) { fail("duplicate_in_file"); continue; }
          seen.add(email.toLowerCase());
          const locationId = locName ? byName.get(locName.toLowerCase()) : null;
          if (locName && !locationId) { fail("unknown_location"); continue; }
          const roles = (r.roles ?? []).map((x) => x.trim()).filter(Boolean).map((x) => byRole.get(x.toLowerCase()) ?? null);
          if (roles.includes(null)) { fail("unknown_role"); continue; }
          const wanted = roles as RoleRow[];
          if (new Set(wanted.map((x) => x.key)).size !== wanted.length) { fail("duplicate_role"); continue; }
          // Admin is only admin (0480): admin and data roles never together; admin_compatible_only goes with either.
          if (wanted.some((x) => x.classification === "admin") && wanted.some((x) => x.classification === "data")) {
            fail("separation_of_duties"); continue;
          }
          if (wanted.some((x) => x.is_location_bound) && !locationId) { fail("location_required"); continue; }
          const managerEmail = r.manager?.trim().toLowerCase() || null;
          if (managerEmail) {
            const m = existing.get(managerEmail);
            if (managerEmail === email.toLowerCase()) { fail("cycle"); continue; }
            if (!m && !fileEmails.has(managerEmail)) { fail("unknown_manager"); continue; }
            if (m && m.status !== "active") { fail("invalid_manager"); continue; }
            res.manager = m?.display_name ?? body.rows.find((x) => x.email.trim().toLowerCase() === managerEmail)!.displayName.trim();
          }
          const teamName = r.team?.trim();
          const teamMatches = teamName ? teamsByName.get(teamName.toLowerCase()) ?? [] : [];
          if (teamName && teamMatches.length === 0) { fail("unknown_team"); continue; }
          if (teamMatches.length > 1) { fail("ambiguous_team"); continue; }
          if (teamName) res.team = teamMatches[0]!.name;
          await c.query("SAVEPOINT bulk_row");
          try {
            const { rows } = await c.query<{ id: string }>(
              `SELECT authz.admin_create_user($1, $2, $3, $4) AS id`, [email, displayName, designation, locationId ?? null]);
            res.id = rows[0]!.id;
            await this.tx.audit.record(c, {
              actorId: user.id, action: "admin.user.created", entityType: "app_user", entityId: res.id,
              // Rule 5: no email or free text in audit rows; keep the fields set, ids and the bulk flag.
              changes: { fields: ["email", "displayName", ...(designation ? ["designation"] : [])], primaryLocationId: locationId ?? null, bulk: true },
            });
            for (const { key: role, label, is_location_bound } of wanted) {
              const roleLocation = is_location_bound ? locationId! : null;
              const q = (await c.query<{ request_id: string; request_status: "applied" | "pending_approval" }>(
                `SELECT * FROM authz.request_role($1, $2, $3)`, [res.id, role, roleLocation])).rows[0]!;
              await this.tx.audit.record(c, {
                actorId: user.id,
                action: q.request_status === "applied" ? "admin.role.granted" : "admin.role.requested",
                entityType: "app_user", entityId: res.id,
                changes: { requestId: q.request_id, role, locationId: roleLocation, bulk: true },
              });
              res.roles.push({ role, label, status: q.request_status });
            }
            await c.query("RELEASE SAVEPOINT bulk_row");
            created.set(email.toLowerCase(), res);
            if (managerEmail || teamName) links.push({ res, managerEmail, teamId: teamName ? teamMatches[0]!.id : null });
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
        // Second pass: reporting lines, then teams. New users have no reports yet, so a loop can only run
        // through rows of this file: it is found here and reported per row. The other lines go to
        // authz.admin_bulk_set_managers in one call. The closure rebuild is deferred over the whole pass
        // (team adds move reporting lines too, 0370) and done once, before commit (0476).
        if (links.length > 0) await c.query(`SELECT authz.reporting_closure_defer()`);
        const fail = (res: Row, code: string) => { res.status = "error"; res.error = code; delete res.id; res.roles = []; };
        const fileManager = new Map(links.filter((l) => l.managerEmail && fileEmails.has(l.managerEmail))
          .map((l) => [l.res.email.toLowerCase(), l.managerEmail!]));
        for (const { res } of links) {
          const start = res.email.toLowerCase();
          let cur = fileManager.get(start);
          for (let n = 0; cur && cur !== start && n < links.length; n++) cur = fileManager.get(cur);
          if (cur === start) fail(res, "cycle");
        }
        const lines: { res: Row; managerId: string }[] = [];
        for (const { res, managerEmail } of links) {
          if (!managerEmail || res.status === "error") continue;
          if (fileEmails.has(managerEmail)) {
            const m = created.get(managerEmail);
            if (!m || m.status === "error") fail(res, "manager_row_failed");
            else lines.push({ res, managerId: m.id! });
            continue;
          }
          const m = existing.get(managerEmail)!;
          if (m.id === user.id) fail(res, "self_change");
          else lines.push({ res, managerId: m.id });
        }
        if (lines.length > 0) {
          await c.query(`SELECT authz.admin_bulk_set_managers($1::uuid[], $2::uuid[])`,
            [lines.map((l) => l.res.id), lines.map((l) => l.managerId)]);
          for (const { res, managerId } of lines) {
            await this.tx.audit.record(c, {
              actorId: user.id, action: "admin.user.manager", entityType: "app_user", entityId: res.id!, changes: { managerId, bulk: true },
            });
          }
        }
        let teamAdds = 0;
        for (const { res, teamId } of links) {
          if (!teamId || res.status === "error") continue;
          await c.query("SAVEPOINT bulk_link");
          try {
            await c.query(`SELECT authz.admin_add_team_member($1, $2)`, [teamId, res.id]);
            await this.tx.audit.record(c, {
              actorId: user.id, action: "admin.team.member_added", entityType: "team", entityId: teamId, changes: { userId: res.id, bulk: true },
            });
            await c.query("RELEASE SAVEPOINT bulk_link");
            teamAdds++;
          } catch (err) {
            const e = err as { code?: string; message?: string };
            if (e.code === undefined || e.message === undefined || !ROW_TEAM_ERRORS.has(e.message)) throw err;
            await c.query("ROLLBACK TO SAVEPOINT bulk_link");
            fail(res, e.message);
          }
        }
        const failed = results.filter((x) => x.status === "error").length;
        const committed = !body.dryRun && failed === 0;
        const report = { dryRun: body.dryRun, committed, created: committed ? results.length : 0, failed,
          rows: committed ? results : results.map(({ id: _id, ...rest }) => rest) };
        if (!committed) throw new BulkOutcome(report);
        if (links.length > 0) await c.query(`SELECT authz.reporting_closure_flush()`);
        await this.tx.audit.record(c, {
          actorId: user.id, action: "admin.user.bulk_created", entityType: "app_user",
          changes: { count: results.length, roles: results.reduce((n, x) => n + x.roles.length, 0), managers: lines.length, teams: teamAdds },
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
    const { locations, roles, teams } = await this.tx.run(user, async (c) => ({
      locations: (await c.query<{ name: string }>(`SELECT name FROM eureka.location ORDER BY name`)).rows.map((l) => l.name),
      roles: (await roleRows(c)).filter((r) => !r.archived_at).map((r) => r.label),
      teams: (await c.query<{ name: string }>(`SELECT DISTINCT name FROM eureka.team WHERE deleted_at IS NULL ORDER BY name`)).rows.map((t) => t.name),
    }));
    return buildUserImportTemplate(roles, locations, teams);
  }
}
