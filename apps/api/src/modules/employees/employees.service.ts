import { ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import type pg from "pg";
import {
  canManageEmployment,
  employeeActions,
  ownsActivity,
  resolveScope,
  type UserAccess,
} from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { activityPredicate } from "../submissions/submissions.service.js";
import { mapEmploymentError } from "./employees.errors.js";
import type { EmployeeListQuery, EndAssignment, ExitEmployee, PlannedEndDate } from "./employees.schemas.js";

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
         pl.recruiter_id, pl.team_id AS pl_team_id, pl.location_id AS pl_location_id
  FROM eureka.employee e
  LEFT JOIN eureka.person p ON p.id = e.person_id
  LEFT JOIN eureka.candidate c ON c.id = e.candidate_id
  LEFT JOIN eureka.location l ON l.id = c.location_id
  LEFT JOIN eureka.team tm ON tm.id = c.team_id
  LEFT JOIN LATERAL (
    SELECT a.id, a.assignment_no, a.start_date, a.end_date, a.end_reason, a.placement_id
    FROM eureka.assignment a WHERE a.person_id = e.person_id
    ORDER BY a.assignment_no DESC LIMIT 1) la ON true
  LEFT JOIN eureka.placement pl ON pl.id = la.placement_id
  LEFT JOIN eureka.client cl ON cl.id = pl.client_id
  LEFT JOIN eureka.assignment_plan pp ON pp.assignment_id = la.id`;

const ref = (id: string | null, name: string | null) => (id ? { id, name } : null);

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
      /** Latest assignment the caller can read; null when none is readable. */
      assignment: r.assignment_id ? {
        id: r.assignment_id, assignmentNo: r.assignment_no, placementId: r.placement_id,
        startDate: r.start_date, endDate: r.end_date, endReason: r.end_reason, plannedEndDate: r.planned_end_date,
        client: ref(r.client_id, r.client_name),
      } : null,
      /** Hints for the UI; the server and the database check every write again. */
      actions: employeeActions(access, latestActor(r), {
        status: r.status, hasOpenAssignment: open, lastEndReason: r.end_reason, candidateStatus: r.marketing_status,
      }),
    };
  }

  async list(user: AuthedUser, q: EmployeeListQuery) {
    this.requireEmployeeRead(user.access);
    const params: unknown[] = [];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const where: string[] = ["true"];
    if (q.status) where.push(`e.status = ${p(q.status)}`);
    if (q.locationId) where.push(`c.location_id = ${p(q.locationId)}::uuid`);
    if (q.clientId) where.push(`la.end_date IS NULL AND pl.client_id = ${p(q.clientId)}::uuid`);
    if (q.endingWithinDays) {
      where.push(`la.end_date IS NULL AND pp.planned_end_date <= CURRENT_DATE + ${p(q.endingWithinDays)}::int`);
    }
    if (q.search) {
      where.push(`(p.first_name || ' ' || p.last_name) ILIKE ${p(`%${q.search.replace(/[%_\\]/g, "\\$&")}%`)} ESCAPE '\\'`);
    }
    if (q.cursor) {
      const i = q.cursor.indexOf(".");
      where.push(`(e.status_since, e.person_id) < (${p(q.cursor.slice(0, i))}::date, ${p(q.cursor.slice(i + 1))}::uuid)`);
    }
    const sql = `${SELECT} WHERE ${where.join(" AND ")} ORDER BY e.status_since DESC, e.person_id DESC LIMIT ${p(q.limit + 1)}`;
    const rows = await this.db.withUser(user.id, async (c) => (await c.query<EmployeeRow>(sql, params)).rows);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => this.present(user.access, r)),
      nextCursor: rows.length > q.limit && last ? `${last.status_since}.${last.person_id}` : null,
    };
  }

  async get(user: AuthedUser, id: string) {
    this.requireEmployeeRead(user.access);
    return this.db.withUser(user.id, async (c) => {
      const row = (await c.query<EmployeeRow>(`${SELECT} WHERE e.person_id = $1`, [id])).rows[0];
      if (!row) throw new NotFoundException();
      const assignments = await c.query<{
        id: string; assignment_no: number; start_date: string; end_date: string | null; end_reason: string | null;
        planned_end_date: string | null; placement_id: string; client_id: string; client_name: string; is_first_placement: boolean;
      }>(
        `SELECT a.id, a.assignment_no, a.start_date::text, a.end_date::text, a.end_reason, pp.planned_end_date::text,
                pl.id AS placement_id, pl.client_id, cl.name AS client_name, pl.is_first_placement
         FROM eureka.assignment a
         JOIN eureka.placement pl ON pl.id = a.placement_id
         JOIN eureka.client cl ON cl.id = pl.client_id
         LEFT JOIN eureka.assignment_plan pp ON pp.assignment_id = a.id
         WHERE a.person_id = $1 ORDER BY a.assignment_no DESC`, [id]);
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
}
