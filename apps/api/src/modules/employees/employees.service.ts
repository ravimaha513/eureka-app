import { ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import type pg from "pg";
import {
  canManageEmployment,
  employeeActions,
  ownsActivity,
  ownsCandidate,
  resolveScope,
  type UserAccess,
} from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { RateLimiter } from "../../platform/rate-limit.js";
import { toCsv } from "../hotlist/csv.js";
import { EXPORTS_PER_WINDOW, EXPORT_ROW_CAP, EXPORT_WINDOW_MS } from "../hotlist/hotlist.service.js";
import { activityPredicate } from "../submissions/submissions.service.js";
import { mapEmploymentError } from "./employees.errors.js";
import type {
  AssignTeam, AssignmentEmployment, EmployeeExportQuery, EmployeeListQuery, EndAssignment, ExitEmployee, PlannedEndDate,
} from "./employees.schemas.js";
import { likeContains } from "../../platform/sql.js";

/**
 * Employees (FR-EMP-01..09, migration 0045, docs/employees-api.md). Reads run
 * under the caller's RLS: the employee record needs employee:read at org scope
 * (B4.4); assignment details appear only where the assignment and its placement
 * are readable. Writes are read-before-write (404 not visible, 403 not allowed),
 * then the definer function checks everything again.
 */

interface EmployeeRow {
  person_id: string;
  candidate_id: string;
  name: string | null;
  status: string;
  employee_since: string;
  status_since: string;
  exited_on: string | null;
  exit_reason: string | null;
  marketing_status: string | null;
  location_id: string | null;
  location_name: string | null;
  team_id: string | null;
  team_name: string | null;
  assignment_id: string | null;
  assignment_no: number | null;
  start_date: string | null;
  end_date: string | null;
  end_reason: string | null;
  planned_end_date: string | null;
  placement_id: string | null;
  client_id: string | null;
  client_name: string | null;
  recruiter_id: string | null;
  pl_team_id: string | null;
  pl_location_id: string | null;
  c_recruiter_id: string | null;
  visibility: "team" | "all_teams" | "selected_teams" | null;
  email: string | null;
  phone: string | null;
  // 0150: the candidate's recruiter and its team's lead; the latest assignment's vendor and payroll company.
  c_recruiter_name: string | null;
  lead_id: string | null;
  lead_name: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  payroll_company_id: string | null;
  payroll_company_name: string | null;
  everify_date: string | null;
  onboarded_date: string | null;
}

/** The latest assignment the caller can read (RLS), with its placement's actor snapshot and plan. */
const SELECT = `
  SELECT e.person_id, e.candidate_id, e.status, e.employee_since::text, e.status_since::text,
         e.exited_on::text, e.exit_reason,
         CASE WHEN p.id IS NOT NULL THEN p.first_name || ' ' || p.last_name END AS name,
         c.marketing_status, c.location_id, l.name AS location_name, c.team_id, tm.name AS team_name,
         la.id AS assignment_id, la.assignment_no, la.start_date::text AS start_date, la.end_date::text AS end_date,
         la.end_reason, pp.planned_end_date::text AS planned_end_date,
         pl.id AS placement_id, pl.client_id, cl.name AS client_name,
         pl.recruiter_id, pl.team_id AS pl_team_id, pl.location_id AS pl_location_id,
         c.recruiter_id AS c_recruiter_id, c.visibility, p.personal_email::text AS email, p.phone_e164 AS phone,
         cru.display_name AS c_recruiter_name, tm.lead_id, lu.display_name AS lead_name,
         pl.vendor_id, v.name AS vendor_name, ae.payroll_company_id, pc.name AS payroll_company_name,
         ae.everify_date::text AS everify_date, ae.onboarded_date::text AS onboarded_date
  FROM eureka.employee e
  LEFT JOIN eureka.person p ON p.id = e.person_id
  LEFT JOIN eureka.candidate c ON c.id = e.candidate_id
  LEFT JOIN eureka.location l ON l.id = c.location_id
  LEFT JOIN eureka.team tm ON tm.id = c.team_id
  LEFT JOIN eureka.app_user cru ON cru.id = c.recruiter_id
  LEFT JOIN eureka.app_user lu ON lu.id = tm.lead_id
  LEFT JOIN LATERAL (
    SELECT a.id, a.assignment_no, a.start_date, a.end_date, a.end_reason, a.placement_id
    FROM eureka.assignment a WHERE a.person_id = e.person_id
    ORDER BY a.assignment_no DESC LIMIT 1) la ON true
  LEFT JOIN eureka.placement pl ON pl.id = la.placement_id
  LEFT JOIN eureka.client cl ON cl.id = pl.client_id
  LEFT JOIN eureka.vendor v ON v.id = pl.vendor_id
  LEFT JOIN eureka.assignment_plan pp ON pp.assignment_id = la.id
  LEFT JOIN eureka.assignment_employment ae ON ae.assignment_id = la.id
  LEFT JOIN authz.payroll_companies() pc ON pc.id = ae.payroll_company_id`;

/**
 * 0150: a readable assignment (current or past) of the employee matches.
 * `alias` columns: placement fields; RLS keeps unreadable assignments out.
 */
const anyAssignment = (cond: string) => `EXISTS (
  SELECT 1 FROM eureka.assignment ax JOIN eureka.placement px ON px.id = ax.placement_id
  LEFT JOIN eureka.assignment_employment aex ON aex.assignment_id = ax.id
  WHERE ax.person_id = e.person_id AND ${cond})`;

const ref = (id: string | null, name: string | null) => (id ? { id, name } : null);

/** Hot List style: the last two digits only. */
export const maskPhone = (v: string | null) => (v === null ? null : `•••-•••-${v.replace(/\D/g, "").slice(-2).padStart(2, "•")}`);
/** First character of the mailbox and the domain. */
export const maskEmail = (v: string | null) => {
  if (v === null) return null;
  const at = v.lastIndexOf("@");
  return at > 0 ? `${v[0]}•••${v.slice(at)}` : "•••";
};

/**
 * EM-C1: an employee's personal email and phone follow the candidate phone
 * rule (design B4.6, like the marketing contacts on the profile):
 * candidate.phone:read over a candidate the caller owns. Otherwise masked.
 */
export function employeeContact(access: UserAccess, r: Pick<EmployeeRow, "c_recruiter_id" | "team_id" | "location_id" | "visibility" | "marketing_status" | "email" | "phone">) {
  const scope = resolveScope(access, "candidate.phone:read");
  const allowed = scope !== null && ownsCandidate(scope, {
    recruiterId: r.c_recruiter_id, teamId: r.team_id, locationId: r.location_id,
    visibility: r.visibility ?? "team", marketingStatus: r.marketing_status ?? "",
  });
  return allowed
    ? { email: r.email, phone: r.phone, masked: false }
    : { email: maskEmail(r.email), phone: maskPhone(r.phone), masked: r.email !== null || r.phone !== null };
}

const latestActor = (r: EmployeeRow) =>
  r.placement_id && r.recruiter_id ? { recruiterId: r.recruiter_id, teamId: r.pl_team_id, locationId: r.pl_location_id } : null;

interface AssignmentRow {
  id: string;
  person_id: string;
  end_date: string | null;
  recruiter_id: string;
  team_id: string | null;
  location_id: string | null;
  candidate_id: string;
}

@Injectable()
export class EmployeesService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  /** B4.4: employee:read at org scope only; any other grant sees nothing (and gets 403 here). */
  private requireEmployeeRead(access: UserAccess) {
    if (!resolveScope(access, "employee:read")?.all) throw new ForbiddenException();
  }

  present(access: UserAccess, r: EmployeeRow) {
    const open = r.assignment_id !== null && r.end_date === null;
    return {
      id: r.person_id,
      candidate: { id: r.candidate_id, name: r.name },
      status: r.status,
      employeeSince: r.employee_since,
      statusSince: r.status_since,
      exitedOn: r.exited_on,
      exitReason: r.exit_reason,
      location: ref(r.location_id, r.location_name),
      team: ref(r.team_id, r.team_name),
      /** 0150: the team's lead and the candidate's recruiter (Sales owners of the person). */
      lead: ref(r.lead_id, r.lead_name),
      recruiter: ref(r.c_recruiter_id, r.c_recruiter_name),
      contact: employeeContact(access, r),
      /** Latest assignment the caller can read; null when none is readable. */
      assignment: r.assignment_id ? {
        id: r.assignment_id, assignmentNo: r.assignment_no, placementId: r.placement_id,
        startDate: r.start_date, endDate: r.end_date, endReason: r.end_reason, plannedEndDate: r.planned_end_date,
        client: ref(r.client_id, r.client_name),
        vendor: ref(r.vendor_id, r.vendor_name),
        payrollCompany: ref(r.payroll_company_id, r.payroll_company_name),
        everifyDate: r.everify_date, onboardedDate: r.onboarded_date,
      } : null,
      /** Hints for the UI; the server and the database check every write again. */
      actions: employeeActions(access, latestActor(r), {
        status: r.status, hasOpenAssignment: open, lastEndReason: r.end_reason, candidateStatus: r.marketing_status,
      }),
    };
  }

  async list(user: AuthedUser, q: EmployeeListQuery) {
    this.requireEmployeeRead(user.access);
    const { sql, params } = this.listSql(q, q.limit + 1);
    const rows = await this.db.withUser(user.id, async (c) => (await c.query<EmployeeRow>(sql, params)).rows);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => this.present(user.access, r)),
      nextCursor: rows.length > q.limit && last ? `${last.status_since}.${last.person_id}` : null,
    };
  }

  private readonly exportLimiter = new RateLimiter(EXPORTS_PER_WINDOW, EXPORT_WINDOW_MS);

  /**
   * EM-X1: CSV of the employee list with the same filters, for report:export
   * holders who also read employees (employee:read at org scope). Contacts are
   * masked exactly as in the list; cells are formula-injection safe; capped at
   * EXPORT_ROW_CAP, rate-limited and audited (filter names and counts only).
   */
  async exportCsv(user: AuthedUser, q: EmployeeExportQuery): Promise<{ csv: string; rows: number; truncated: boolean }> {
    this.requireEmployeeRead(user.access);
    if (!resolveScope(user.access, "report:export")) throw new ForbiddenException();
    if (!this.exportLimiter.take(user.id)) {
      throw new HttpException("Too many exports; try again in a few minutes", HttpStatus.TOO_MANY_REQUESTS);
    }
    const { sql, params } = this.listSql(q, EXPORT_ROW_CAP + 1);
    const rows = await this.db.withUser(user.id, async (c) => {
      const out = (await c.query<EmployeeRow>(sql, params)).rows;
      await this.audit.record(c, {
        actorId: user.id, action: "employee.export", entityType: "employee",
        changes: { rows: Math.min(out.length, EXPORT_ROW_CAP), truncated: out.length > EXPORT_ROW_CAP, cap: EXPORT_ROW_CAP,
          filters: Object.keys(q).filter((k) => q[k as keyof EmployeeExportQuery] !== undefined).sort() },
      });
      return out;
    });
    const page = rows.slice(0, EXPORT_ROW_CAP);
    const csv = toCsv(
      ["Name", "Email", "Phone", "Status", "Employee since", "Status since", "Location", "Team", "Client", "Assignment no.", "Start date", "Planned end date",
        "Lead", "Recruiter", "Vendor", "Payroll company", "E-Verify date", "Onboarded date"],
      page.map((r) => {
        const contact = employeeContact(user.access, r);
        return [r.name ?? "(not visible)", contact.email, contact.phone, r.status, r.employee_since, r.status_since,
          r.location_name, r.team_name, r.client_name, r.assignment_no, r.start_date, r.planned_end_date,
          r.lead_name, r.c_recruiter_name, r.vendor_name, r.payroll_company_name, r.everify_date, r.onboarded_date];
      }),
    );
    return { csv, rows: page.length, truncated: rows.length > EXPORT_ROW_CAP };
  }

  private listSql(q: EmployeeExportQuery & { cursor?: string }, limit: number) {
    const params: unknown[] = [];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const where: string[] = ["true"];
    if (q.status) where.push(`e.status = ${p(q.status)}`);
    if (q.locationId) where.push(`c.location_id = ${p(q.locationId)}::uuid`);
    if (q.clientId) {
      where.push(q.clientMatch === "current"
        ? `la.end_date IS NULL AND pl.client_id = ${p(q.clientId)}::uuid`
        : anyAssignment(`px.client_id = ${p(q.clientId)}::uuid`));
    }
    if (q.vendorId) where.push(anyAssignment(`px.vendor_id = ${p(q.vendorId)}::uuid`));
    if (q.payrollCompanyId) where.push(anyAssignment(`aex.payroll_company_id = ${p(q.payrollCompanyId)}::uuid`));
    if (q.endingWithinDays) {
      where.push(`la.end_date IS NULL AND pp.planned_end_date <= CURRENT_DATE + ${p(q.endingWithinDays)}::int`);
    }
    if (q.search) {
      where.push(`(p.first_name || ' ' || p.last_name) ILIKE ${p(likeContains(q.search))} ESCAPE '\\'`);
    }
    if (q.cursor) {
      const i = q.cursor.indexOf(".");
      where.push(`(e.status_since, e.person_id) < (${p(q.cursor.slice(0, i))}::date, ${p(q.cursor.slice(i + 1))}::uuid)`);
    }
    const sql = `${SELECT} WHERE ${where.join(" AND ")} ORDER BY e.status_since DESC, e.person_id DESC LIMIT ${p(limit)}`;
    return { sql, params };
  }

  async get(user: AuthedUser, id: string) {
    this.requireEmployeeRead(user.access);
    return this.db.withUser(user.id, async (c) => {
      const row = (await c.query<EmployeeRow>(`${SELECT} WHERE e.person_id = $1`, [id])).rows[0];
      if (!row) throw new NotFoundException();
      const assignments = await c.query<{
        id: string; assignment_no: number; start_date: string; end_date: string | null; end_reason: string | null;
        planned_end_date: string | null; placement_id: string; client_id: string; client_name: string; is_first_placement: boolean;
        vendor_id: string | null; vendor_name: string | null; payroll_company_id: string | null; payroll_company_name: string | null;
        everify_date: string | null; onboarded_date: string | null;
        recruiter_id: string; team_id: string | null; location_id: string | null;
      }>(
        `SELECT a.id, a.assignment_no, a.start_date::text, a.end_date::text, a.end_reason, pp.planned_end_date::text,
                pl.id AS placement_id, pl.client_id, cl.name AS client_name, pl.is_first_placement,
                pl.vendor_id, v.name AS vendor_name, ae.payroll_company_id, pc.name AS payroll_company_name,
                ae.everify_date::text AS everify_date, ae.onboarded_date::text AS onboarded_date,
                pl.recruiter_id, pl.team_id, pl.location_id
         FROM eureka.assignment a
         JOIN eureka.placement pl ON pl.id = a.placement_id
         JOIN eureka.client cl ON cl.id = pl.client_id
         LEFT JOIN eureka.vendor v ON v.id = pl.vendor_id
         LEFT JOIN eureka.assignment_plan pp ON pp.assignment_id = a.id
         LEFT JOIN eureka.assignment_employment ae ON ae.assignment_id = a.id
         LEFT JOIN authz.payroll_companies() pc ON pc.id = ae.payroll_company_id
         WHERE a.person_id = $1 ORDER BY a.assignment_no DESC`, [id]);
      // Pay rates only where rate:read covers the placement's actor snapshot (PL-6); the definer re-checks.
      const rateScope = resolveScope(user.access, "rate:read");
      const rates = new Map((await c.query<{ assignment_id: string; pay_rate: string }>(
        `SELECT assignment_id, pay_rate::text FROM authz.assignment_pay_rates($1)`, [id])).rows.map((r) => [r.assignment_id, Number(r.pay_rate)]));
      const history = await c.query<{
        id: string; kind: string; at: Date; actor_name: string | null; assignment_id: string | null;
        from_status: string | null; to_status: string | null; effective_on: string | null; previous_on: string | null; reason: string | null;
      }>(
        `SELECT ev.id::text, ev.kind, ev.at, u.display_name AS actor_name, ev.assignment_id, ev.from_status, ev.to_status,
                ev.effective_on::text, ev.previous_on::text, ev.reason
         FROM eureka.employment_event ev LEFT JOIN eureka.app_user u ON u.id = ev.actor_id
         WHERE ev.person_id = $1 ORDER BY ev.at DESC, ev.effective_on DESC NULLS LAST, ev.id DESC LIMIT 200`, [id]);
      return {
        ...this.present(user.access, row),
        assignments: assignments.rows.map((a) => ({
          id: a.id, assignmentNo: a.assignment_no, placementId: a.placement_id, startDate: a.start_date, endDate: a.end_date,
          endReason: a.end_reason, plannedEndDate: a.planned_end_date, client: { id: a.client_id, name: a.client_name },
          isFirstPlacement: a.is_first_placement,
          vendor: ref(a.vendor_id, a.vendor_name),
          payrollCompany: ref(a.payroll_company_id, a.payroll_company_name),
          everifyDate: a.everify_date, onboardedDate: a.onboarded_date,
          // The key is present (value or null) only for callers who may see and set the pay rate.
          ...(ownsActivity(rateScope, { recruiterId: a.recruiter_id, teamId: a.team_id, locationId: a.location_id })
            ? { payRate: rates.get(a.id) ?? null } : {}),
        })),
        history: history.rows.map((h) => ({
          id: h.id, kind: h.kind, at: h.at, actor: h.actor_name, assignmentId: h.assignment_id, fromStatus: h.from_status,
          toStatus: h.to_status, effectiveOn: h.effective_on, previousOn: h.previous_on, reason: h.reason,
        })),
      };
    });
  }

  /**
   * Read-before-write for the assignment routes: the assignment must be
   * readable (assignment:read and the placement visible, as the RLS policies),
   * else 404; assignment:update on the placement's actor snapshot and
   * employee:read at org scope, else 403.
   */
  private async loadAssignment(c: pg.PoolClient, user: AuthedUser, id: string): Promise<AssignmentRow> {
    const readScope = resolveScope(user.access, "assignment:read");
    if (!readScope) throw new NotFoundException();
    const params: unknown[] = [id];
    const row = (await c.query<AssignmentRow>(
      `SELECT a.id, a.person_id, a.end_date::text, pl.recruiter_id, pl.team_id, pl.location_id, pl.candidate_id
       FROM eureka.assignment a
       JOIN eureka.placement pl ON pl.id = a.placement_id
       LEFT JOIN eureka.candidate c ON c.id = pl.candidate_id
       WHERE a.id = $1 AND ${activityPredicate(readScope, params, "pl", "c")}`, params)).rows[0];
    if (!row) throw new NotFoundException();
    const actor = { recruiterId: row.recruiter_id, teamId: row.team_id, locationId: row.location_id };
    if (!ownsActivity(resolveScope(user.access, "assignment:update"), actor) || !canManageEmployment(user.access, actor)) {
      throw new ForbiddenException("Not permitted");
    }
    return row;
  }

  /** Read-before-write for the employee routes: employee readable (404), latest assignment manageable (403). */
  private async loadEmployee(c: pg.PoolClient, user: AuthedUser, id: string): Promise<EmployeeRow> {
    this.requireEmployeeRead(user.access);
    const row = (await c.query<EmployeeRow>(`${SELECT} WHERE e.person_id = $1`, [id])).rows[0];
    if (!row) throw new NotFoundException();
    if (!canManageEmployment(user.access, latestActor(row))) throw new ForbiddenException("Not permitted");
    return row;
  }

  private async auditCandidate(c: pg.PoolClient, user: AuthedUser, candidateId: string, from: string | null, to: string | null) {
    if (to === null) return;
    await this.audit.record(c, {
      actorId: user.id, action: "candidate.transition", entityType: "candidate", entityId: candidateId,
      changes: { from, to, via: "employment" },
    });
  }

  /** Project exit (FR-EMP-03/04): end date + reason category; the employee goes to the bench. */
  async endAssignment(user: AuthedUser, id: string, body: EndAssignment) {
    return this.db.withUser(user.id, async (c) => {
      const a = await this.loadAssignment(c, user, id);
      if (a.end_date !== null) throw new UnprocessableEntityException("assignment_closed");
      let r: { person_id: string; employee_from: string | null; employee_to: string | null; candidate_from: string | null; candidate_to: string | null };
      try {
        r = (await c.query<typeof r>(`SELECT * FROM authz.end_assignment($1, $2::date, $3)`, [id, body.endDate, body.reason])).rows[0]!;
      } catch (err) {
        mapEmploymentError(err);
      }
      await this.audit.record(c, {
        actorId: user.id, action: "assignment.ended", entityType: "assignment", entityId: id,
        changes: { endDate: body.endDate, reason: body.reason, employeeFrom: r.employee_from, employeeTo: r.employee_to },
      });
      await this.auditCandidate(c, user, a.candidate_id, r.candidate_from, r.candidate_to);
      return { id, endDate: body.endDate, endReason: body.reason, employeeStatus: r.employee_to };
    });
  }

  /** Planned end date: set, extend or bring forward (today or later). */
  async setPlannedEndDate(user: AuthedUser, id: string, body: PlannedEndDate) {
    return this.db.withUser(user.id, async (c) => {
      const a = await this.loadAssignment(c, user, id);
      if (a.end_date !== null) throw new UnprocessableEntityException("assignment_closed");
      let r: { previous_date: string | null; planned_date: string };
      try {
        r = (await c.query<typeof r>(
          `SELECT previous_date::text, planned_date::text FROM authz.set_assignment_end_date($1, $2::date)`, [id, body.plannedEndDate])).rows[0]!;
      } catch (err) {
        mapEmploymentError(err);
      }
      await this.audit.record(c, {
        actorId: user.id, action: "assignment.planned_end", entityType: "assignment", entityId: id,
        changes: { from: r.previous_date, to: r.planned_date },
      });
      return { id, plannedEndDate: r.planned_date, previousPlannedEndDate: r.previous_date };
    });
  }

  /** Bench -> exited (the employee leaves the company). */
  async exit(user: AuthedUser, id: string, body: ExitEmployee) {
    return this.db.withUser(user.id, async (c) => {
      const e = await this.loadEmployee(c, user, id);
      if (e.status !== "bench") throw new UnprocessableEntityException("invalid_transition");
      try {
        await c.query(`SELECT * FROM authz.exit_employee($1, $2::date, $3)`, [id, body.exitDate, body.reason]);
      } catch (err) {
        mapEmploymentError(err);
      }
      await this.audit.record(c, {
        actorId: user.id, action: "employee.exited", entityType: "employee", entityId: id,
        changes: { from: "bench", to: "exited", exitDate: body.exitDate, reason: body.reason },
      });
      return { id, status: "exited" };
    });
  }

  /** Reassignment, first step: a benched employee back to marketing (candidate bench -> active). */
  async returnToMarket(user: AuthedUser, id: string) {
    return this.db.withUser(user.id, async (c) => {
      const e = await this.loadEmployee(c, user, id);
      if (e.status !== "bench") throw new UnprocessableEntityException("invalid_transition");
      let r: { candidate_id: string; candidate_from: string; candidate_to: string };
      try {
        r = (await c.query<typeof r>(`SELECT * FROM authz.return_employee_to_market($1)`, [id])).rows[0]!;
      } catch (err) {
        mapEmploymentError(err);
      }
      await this.audit.record(c, {
        actorId: user.id, action: "employee.returned_to_market", entityType: "employee", entityId: id,
        changes: { candidateId: r.candidate_id },
      });
      await this.auditCandidate(c, user, r.candidate_id, r.candidate_from, r.candidate_to);
      return { id, candidateStatus: r.candidate_to };
    });
  }

  /** 0150: the group's companies for the payroll company picker and filter (id, name, status only). */
  async payrollCompanies(user: AuthedUser) {
    this.requireEmployeeRead(user.access);
    const rows = await this.db.withUser(user.id, async (c) => (await c.query<{ id: string; name: string; status: string }>(
      `SELECT id, name, status FROM authz.payroll_companies() ORDER BY lower(name), id`)).rows);
    return { items: rows };
  }

  /** 0150: teams with their lead, for the "assign a team" dialog (employment writers: employee:read at org scope). */
  async teams(user: AuthedUser) {
    this.requireEmployeeRead(user.access);
    const rows = await this.db.withUser(user.id, async (c) => (await c.query<{ id: string; name: string; lead_id: string; lead_name: string | null; location_name: string | null }>(
      `SELECT t.id, t.name, t.lead_id, u.display_name AS lead_name, l.name AS location_name
       FROM eureka.team t LEFT JOIN eureka.app_user u ON u.id = t.lead_id LEFT JOIN eureka.location l ON l.id = t.location_id
       ORDER BY lower(t.name), t.id`)).rows);
    return { items: rows.map((r) => ({ id: r.id, name: r.name, lead: { id: r.lead_id, name: r.lead_name }, location: r.location_name })) };
  }

  /**
   * 0150: payroll company, E-Verify date, onboarded date and pay rate of an
   * assignment (open or ended). Same rights as every employment write; the pay
   * rate also needs rate:read over the placement's actor snapshot. Audited with
   * the changed field names (and the company id) only, never the rate (rule 5).
   */
  async setEmployment(user: AuthedUser, id: string, body: AssignmentEmployment) {
    return this.db.withUser(user.id, async (c) => {
      const a = await this.loadAssignment(c, user, id);
      const actor = { recruiterId: a.recruiter_id, teamId: a.team_id, locationId: a.location_id };
      const rateVisible = ownsActivity(resolveScope(user.access, "rate:read"), actor);
      if (body.payRate !== undefined && !rateVisible) throw new ForbiddenException("Not permitted");
      let changed: string[];
      try {
        changed = (await c.query<{ f: string[] }>(`SELECT authz.set_assignment_employment($1, $2::jsonb) AS f`,
          [id, JSON.stringify(body)])).rows[0]!.f;
      } catch (err) {
        mapEmploymentError(err);
      }
      await this.audit.record(c, {
        actorId: user.id, action: "assignment.employment_updated", entityType: "assignment", entityId: id,
        changes: { fields: changed, ...(changed.includes("payrollCompanyId") ? { payrollCompanyId: body.payrollCompanyId ?? null } : {}) },
      });
      const r = (await c.query<{ payroll_company_id: string | null; payroll_company_name: string | null; everify_date: string | null; onboarded_date: string | null }>(
        `SELECT ae.payroll_company_id, pc.name AS payroll_company_name, ae.everify_date::text AS everify_date, ae.onboarded_date::text AS onboarded_date
         FROM eureka.assignment_employment ae LEFT JOIN authz.payroll_companies() pc ON pc.id = ae.payroll_company_id
         WHERE ae.assignment_id = $1`, [id])).rows[0];
      const rate = rateVisible
        ? (await c.query<{ pay_rate: string }>(`SELECT pay_rate::text FROM authz.assignment_pay_rates($1) WHERE assignment_id = $2`, [a.person_id, id])).rows[0]
        : undefined;
      return {
        id, changed,
        payrollCompany: ref(r?.payroll_company_id ?? null, r?.payroll_company_name ?? null),
        everifyDate: r?.everify_date ?? null, onboardedDate: r?.onboarded_date ?? null,
        ...(rateVisible ? { payRate: rate ? Number(rate.pay_rate) : null } : {}),
      };
    });
  }

  /**
   * 0150, leaving a project: HR/Accounts/Associate HR put a benched employee's
   * candidate in a Sales team (no candidate:assign needed); the recruiter is
   * cleared for the new lead to assign, and the lead and manager are notified
   * (candidate.assigned). Audited with ids only.
   */
  async assignTeam(user: AuthedUser, id: string, body: AssignTeam) {
    return this.db.withUser(user.id, async (c) => {
      const e = await this.loadEmployee(c, user, id);
      if (e.status !== "bench") throw new UnprocessableEntityException("invalid_transition");
      let r: { cand_id: string; from_team_id: string | null; to_team_id: string };
      try {
        r = (await c.query<typeof r>(`SELECT * FROM authz.assign_employee_team($1, $2)`, [id, body.teamId])).rows[0]!;
      } catch (err) {
        mapEmploymentError(err);
      }
      await this.audit.record(c, {
        actorId: user.id, action: "employee.team_assigned", entityType: "employee", entityId: id,
        changes: { candidateId: r.cand_id, fromTeamId: r.from_team_id, toTeamId: r.to_team_id },
      });
      const team = (await c.query<{ name: string }>(`SELECT name FROM eureka.team WHERE id = $1`, [r.to_team_id])).rows[0];
      return { id, candidateId: r.cand_id, team: { id: r.to_team_id, name: team?.name ?? null }, recruiter: null };
    });
  }
}
