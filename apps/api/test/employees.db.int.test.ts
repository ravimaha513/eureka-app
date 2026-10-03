import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveScope, type UserAccess } from "@eureka/shared";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, U, seedFixtures, toUserAccess } from "./fixtures.js";
import { createPlacement, extraUser, selectedSubmission, transitionPlacement } from "./placement-seed.js";
import { asActor, backdate, joinPlacement, joinedEmployee, type Joined } from "./employee-seed.js";

/**
 * Database-only checks for migration 0045 (employees, assignment lifecycle,
 * outbox rows): every rule holds with the API removed (design B8).
 */
let db: TestDb;
let today: string;
const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
let ahr: { id: string; access: UserAccess };
let bu: { id: string; access: UserAccess };

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  ahr = await extraUser(db, "ahr", "associate_hr");
  bu = await extraUser(db, "bu", "bu_head");
  today = (await db.admin.query<{ d: string }>(`SELECT CURRENT_DATE::text AS d`)).rows[0]!.d;
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

const q = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.admin.query(sql, params)).rows as R[];
const employee = async (person: string) => (await q<Record<string, any>>(`SELECT * FROM eureka.employee WHERE person_id = $1`, [person]))[0]!;
const candStatus = async (id: string) => (await q<{ marketing_status: string }>(`SELECT marketing_status FROM eureka.candidate WHERE id = $1`, [id]))[0]!.marketing_status;
const events = async (person: string) => q<{ kind: string; from_status: string | null; to_status: string | null; effective_on: string | null; previous_on: string | null; reason: string | null; actor_id: string | null }>(
  `SELECT kind, from_status, to_status, effective_on::text, previous_on::text, reason, actor_id FROM eureka.employment_event WHERE person_id = $1 ORDER BY id`, [person]);
const outbox = async (type: string, aggregate: string) =>
  q<{ type: string; aggregate_type: string; payload: Record<string, unknown> }>(
    `SELECT type, aggregate_type, payload FROM eureka.outbox_event WHERE type = $1 AND aggregate_id = $2 ORDER BY created_at`, [type, aggregate]);

const endAssignment = (actor: string, a: string | null, end: string | null, reason: string | null) =>
  asActor(db, actor, `SELECT * FROM authz.end_assignment($1, $2::date, $3)`, [a, end, reason]);
const setEnd = (actor: string, a: string | null, d: string | null) =>
  asActor(db, actor, `SELECT previous_date::text, planned_date::text FROM authz.set_assignment_end_date($1, $2::date)`, [a, d]);
const exitEmployee = (actor: string, p: string | null, d: string | null, reason: string | null) =>
  asActor(db, actor, `SELECT * FROM authz.exit_employee($1, $2::date, $3)`, [p, d, reason]);
const toMarket = (actor: string, p: string | null) =>
  asActor(db, actor, `SELECT * FROM authz.return_employee_to_market($1)`, [p]);

/** A joined employee whose assignment started 60 days ago (so past end dates are valid). */
async function onAssignment(o: Parameters<typeof joinedEmployee>[1] = {}): Promise<Joined> {
  const j = await joinedEmployee(db, o);
  await backdate(db, j, addDays(today, -60));
  return j;
}

describe("employee record follows the placement flow", () => {
  it("joining opens the assignment and creates the employee (on assignment), with history", async () => {
    const j = await joinedEmployee(db);
    const e = await employee(j.personId);
    expect([e.status, e.candidate_id, e.exited_on, e.exit_reason]).toEqual(["on_assignment", j.candidateId, null, null]);
    expect(await events(j.personId)).toEqual([
      { kind: "started", from_status: null, to_status: "on_assignment", effective_on: today, previous_on: null, reason: null, actor_id: U.r1a },
    ]);
  });

  it("bgc_failed after joining ends the assignment and benches the employee with an outbox row (ids, dates, categories)", async () => {
    const j = await joinedEmployee(db);
    await transitionPlacement(db, U.m1, j.placementId, "bgc_failed", "Record mismatch with Jane Doe, call +14695550100");
    expect((await employee(j.personId)).status).toBe("bench");
    expect(await candStatus(j.candidateId)).toBe("bench");
    const ev = await outbox("employee.benched", j.personId);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.aggregate_type).toBe("employee");
    expect(ev[0]!.payload).toEqual({
      personId: j.personId, candidateId: j.candidateId, assignmentId: j.assignmentId, placementId: j.placementId,
      endDate: today, endReason: "bgc_failed", notify: ["hr", "accounts", "immigration", "bu_head", "ceo"],
    });
    expect(JSON.stringify(ev[0]!.payload)).not.toMatch(/Jane|\+1469|mismatch/);
    expect((await events(j.personId)).map((e) => [e.kind, e.to_status, e.reason])).toEqual([
      ["started", "on_assignment", null], ["ended", "bench", "bgc_failed"],
    ]);
  });
});

describe("authz.end_assignment (project exit)", () => {
  it("HR ends the assignment: end date and reason, candidate placed -> bench, employee -> bench, outbox, history", async () => {
    const j = await onAssignment();
    const end = addDays(today, -1);
    const r = await endAssignment(U.hr, j.assignmentId, end, "completed");
    expect(r).toEqual([{ person_id: j.personId, employee_from: "on_assignment", employee_to: "bench", candidate_from: "placed", candidate_to: "bench" }]);
    expect(await q(`SELECT end_date::text, end_reason FROM eureka.assignment WHERE id = $1`, [j.assignmentId]))
      .toEqual([{ end_date: end, end_reason: "completed" }]);
    expect(await candStatus(j.candidateId)).toBe("bench");
    const e = await employee(j.personId);
    expect(e.status).toBe("bench");
    const ev = await outbox("employee.benched", j.personId);
    expect(ev.map((x) => [x.payload.endDate, x.payload.endReason])).toEqual([[end, "completed"]]);
    expect((await events(j.personId)).at(-1)!).toMatchObject({ kind: "ended", from_status: "on_assignment", to_status: "bench", effective_on: end, reason: "completed", actor_id: U.hr });
  });

  it.each([
    ["accounts", () => U.acct],
    ["associate HR", () => ahr.id],
  ])("%s may end an assignment", async (_n, who) => {
    const j = await onAssignment();
    await endAssignment(who(), j.assignmentId, today, "resigned");
    expect((await employee(j.personId)).status).toBe("bench");
  });

  it("a candidate no longer `placed` stays where it is; the employee still goes to the bench", async () => {
    const j = await onAssignment();
    const c = await db.admin.connect();
    try {
      await c.query("SET session_replication_role = replica");
      await c.query(`UPDATE eureka.candidate SET marketing_status = 'terminated' WHERE id = $1`, [j.candidateId]);
    } finally { await c.query("RESET session_replication_role"); c.release(); }
    const r = await endAssignment(U.hr, j.assignmentId, today, "terminated");
    expect(r[0]).toMatchObject({ candidate_from: null, candidate_to: null, employee_to: "bench" });
    expect(await candStatus(j.candidateId)).toBe("terminated");
  });

  it.each([
    ["no user context", null, "assignment_not_found"],
    ["Location Ops Admin (no assignment:read)", "locD", "assignment_not_found"],
    ["Immigration (assignment:read, no placement:read)", "imm", "assignment_not_found"],
    ["another team's recruiter", "r3a", "assignment_not_found"],
    ["the placing recruiter (read only)", "r1a", "not_permitted"],
    ["the lead (read only)", "l1", "not_permitted"],
    ["the CEO (read only)", "ceo", "not_permitted"],
    ["the BU Head (read only)", "bu", "not_permitted"],
  ])("refused for %s", async (_n, who, code) => {
    const j = await onAssignment();
    const run = who === null
      ? db.app.query(`SELECT * FROM authz.end_assignment($1, $2::date, 'completed')`, [j.assignmentId, today])
      : endAssignment(who === "bu" ? bu.id : U[who as keyof typeof U], j.assignmentId, today, "completed");
    await expect(run).rejects.toThrow(code);
    expect((await employee(j.personId)).status).toBe("on_assignment");
    expect(await outbox("employee.benched", j.personId)).toEqual([]);
  });

  it.each([
    ["a NULL id", "id", null],
    ["a NULL end date", "end", null],
    ["a future end date", "end", "future"],
    ["an end date before the start", "end", "before"],
    ["a NULL reason", "reason", null],
    ["bgc_failed (placements only)", "reason", "bgc_failed"],
    ["an unknown reason", "reason", "fired"],
  ])("refuses %s", async (_n, field, value) => {
    const j = await onAssignment();
    const end = value === "future" ? addDays(today, 1) : value === "before" ? addDays(today, -61) : today;
    const args = {
      id: field === "id" ? value : j.assignmentId,
      end: field === "end" && value === null ? null : end,
      reason: field === "reason" ? value : "completed",
    };
    await expect(endAssignment(U.hr, args.id, args.end, args.reason))
      .rejects.toThrow(field === "id" ? "assignment_not_found" : field === "reason" ? "invalid_reason" : "invalid_end_date");
    expect((await employee(j.personId)).status).toBe("on_assignment");
  });

  it("an ended assignment cannot be ended again", async () => {
    const j = await onAssignment();
    await endAssignment(U.hr, j.assignmentId, today, "completed");
    await expect(endAssignment(U.hr, j.assignmentId, today, "completed")).rejects.toThrow("assignment_closed");
  });
});

describe("authz.set_assignment_end_date (planned end, extension)", () => {
  it("sets, extends and brings forward; history keeps the previous date; the ending-soon notice re-arms", async () => {
    const j = await onAssignment();
    const d1 = addDays(today, 20), d2 = addDays(today, 90), d3 = addDays(today, 10);
    expect(await setEnd(U.hr, j.assignmentId, d1)).toEqual([{ previous_date: null, planned_date: d1 }]);
    expect(await db.worker.query(`SELECT authz.assignment_ending_soon_scan(30) AS n`).then((r) => r.rows[0].n)).toBeGreaterThanOrEqual(1);
    expect(await setEnd(U.acct, j.assignmentId, d2)).toEqual([{ previous_date: d1, planned_date: d2 }]);
    expect(await q(`SELECT planned_end_date::text AS d, ending_notice_for FROM eureka.assignment_plan WHERE assignment_id = $1`, [j.assignmentId]))
      .toEqual([{ d: d2, ending_notice_for: null }]);
    await setEnd(U.hr, j.assignmentId, d3);
    expect((await events(j.personId)).filter((e) => e.kind === "end_date_set").map((e) => [e.effective_on, e.previous_on]))
      .toEqual([[d1, null], [d2, d1], [d3, d2]]);
    expect((await employee(j.personId)).status).toBe("on_assignment");
  });

  it.each([
    ["a past date", -1, "invalid_end_date"],
    ["a NULL date", null, "invalid_end_date"],
  ])("refuses %s", async (_n, offset, code) => {
    const j = await onAssignment();
    await expect(setEnd(U.hr, j.assignmentId, offset === null ? null : addDays(today, offset))).rejects.toThrow(code);
  });

  it("refuses the same date again, a closed assignment and callers without assignment:update", async () => {
    const j = await onAssignment();
    const d = addDays(today, 30);
    await setEnd(U.hr, j.assignmentId, d);
    await expect(setEnd(U.hr, j.assignmentId, d)).rejects.toThrow("unchanged");
    await expect(setEnd(U.r1a, j.assignmentId, addDays(today, 40))).rejects.toThrow("not_permitted");
    await expect(setEnd(U.locD, j.assignmentId, addDays(today, 40))).rejects.toThrow("assignment_not_found");
    await endAssignment(U.hr, j.assignmentId, today, "completed");
    await expect(setEnd(U.hr, j.assignmentId, addDays(today, 40))).rejects.toThrow("assignment_closed");
  });
});

describe("authz.exit_employee and authz.return_employee_to_market", () => {
  async function benched(reason = "completed") {
    const j = await onAssignment();
    await endAssignment(U.hr, j.assignmentId, addDays(today, -5), reason);
    return j;
  }

  it("bench -> exited with an outbox row; exit is final until a new placement joins", async () => {
    const j = await benched();
    expect(await exitEmployee(U.hr, j.personId, addDays(today, -2), "resigned")).toEqual([{ employee_from: "bench", employee_to: "exited" }]);
    const e = await employee(j.personId);
    expect([e.status, e.exit_reason]).toEqual(["exited", "resigned"]);
    const ev = await outbox("employee.exited", j.personId);
    expect(ev.map((x) => x.payload)).toEqual([{
      personId: j.personId, candidateId: j.candidateId, lastAssignmentId: j.assignmentId, exitDate: addDays(today, -2),
      exitReason: "resigned", notify: ["hr", "accounts", "immigration", "bu_head", "ceo"],
    }]);
    // The candidate's marketing status is left as it is (open question).
    expect(await candStatus(j.candidateId)).toBe("bench");
    await expect(exitEmployee(U.hr, j.personId, today, "resigned")).rejects.toThrow("invalid_transition");
    await expect(toMarket(U.hr, j.personId)).rejects.toThrow("invalid_transition");
  });

  it("refuses an exit while on assignment, before the last end date, in the future or with an unknown reason", async () => {
    const j = await onAssignment();
    await expect(exitEmployee(U.hr, j.personId, today, "resigned")).rejects.toThrow("invalid_transition");
    await endAssignment(U.hr, j.assignmentId, addDays(today, -5), "completed");
    await expect(exitEmployee(U.hr, j.personId, addDays(today, -6), "resigned")).rejects.toThrow("invalid_end_date");
    await expect(exitEmployee(U.hr, j.personId, addDays(today, 1), "resigned")).rejects.toThrow("invalid_end_date");
    await expect(exitEmployee(U.hr, j.personId, today, "absconded")).rejects.toThrow("invalid_reason");
    await expect(exitEmployee(U.hr, j.personId, null, "resigned")).rejects.toThrow("invalid_end_date");
    expect((await employee(j.personId)).status).toBe("bench");
  });

  it.each([
    ["the placing recruiter (no employee:read)", "r1a", "employee_not_found"],
    ["Immigration (employee:read, the placement is not visible)", "imm", "assignment_not_found"],
    ["the CEO (read only)", "ceo", "not_permitted"],
    ["the BU Head (read only)", "bu", "not_permitted"],
  ])("refuses %s", async (_n, who, code) => {
    const j = await benched();
    const id = who === "bu" ? bu.id : U[who as keyof typeof U];
    await expect(exitEmployee(id, j.personId, today, "other")).rejects.toThrow(code);
    await expect(toMarket(id, j.personId)).rejects.toThrow(code);
    expect((await employee(j.personId)).status).toBe("bench");
    expect(await candStatus(j.candidateId)).toBe("bench");
  });

  it("an unknown person or no user context is not found", async () => {
    await expect(exitEmployee(U.hr, "00000000-0000-4000-8000-0000000000ff", today, "other")).rejects.toThrow("employee_not_found");
    await expect(toMarket(U.hr, null)).rejects.toThrow("employee_not_found");
    const j = await benched();
    await expect(db.app.query(`SELECT * FROM authz.exit_employee($1, CURRENT_DATE, 'other')`, [j.personId])).rejects.toThrow("employee_not_found");
  });

  it("return to market: candidate bench -> active (once), then a new placement joins as assignment 2 (not a first placement)", async () => {
    const j = await benched();
    expect(await toMarket(U.acct, j.personId)).toEqual([{ candidate_id: j.candidateId, candidate_from: "bench", candidate_to: "active" }]);
    expect(await candStatus(j.candidateId)).toBe("active");
    await expect(toMarket(U.hr, j.personId)).rejects.toThrow("candidate_not_on_bench");
    expect((await employee(j.personId)).status).toBe("bench");

    const sub = await selectedSubmission(db, U.r1a, j.candidateId);
    const p = await createPlacement(db, U.r1a, sub);
    expect(p.isFirst).toBe(false); // existing first-placement detection, unchanged
    await joinPlacement(db, U.r1a, p.id);
    const e = await employee(j.personId);
    expect(e.status).toBe("on_assignment");
    expect(await q(`SELECT assignment_no FROM eureka.assignment WHERE person_id = $1 ORDER BY assignment_no`, [j.personId]))
      .toEqual([{ assignment_no: 1 }, { assignment_no: 2 }]);
    expect((await events(j.personId)).map((x) => x.kind)).toEqual(["started", "ended", "returned_to_market", "started"]);
  });

  it("after a failed background check the employee is not returned to market here (open question)", async () => {
    const j = await joinedEmployee(db);
    await transitionPlacement(db, U.m1, j.placementId, "bgc_failed", "Check failed");
    await expect(toMarket(U.hr, j.personId)).rejects.toThrow("bgc_failed_last");
    expect(await candStatus(j.candidateId)).toBe("bench");
  });

  it("an exited employee re-placed by Sales is on assignment again; the exit is cleared", async () => {
    const j = await benched();
    await exitEmployee(U.hr, j.personId, today, "other");
    await asUser(db.app, U.r1a, (c) => c.query(`SELECT authz.transition_candidate($1, 'active')`, [j.candidateId]), true);
    const sub = await selectedSubmission(db, U.r1a, j.candidateId);
    const p = await createPlacement(db, U.r1a, sub);
    await joinPlacement(db, U.r1a, p.id);
    const e = await employee(j.personId);
    expect([e.status, e.exited_on, e.exit_reason]).toEqual(["on_assignment", null, null]);
    expect((await events(j.personId)).at(-1)!).toMatchObject({ kind: "started", from_status: "exited", to_status: "on_assignment" });
  });
});

describe("RLS (differential against the engine)", () => {
  const people: Joined[] = [];
  beforeAll(async () => {
    // Employees placed by three teams in two locations; one on the bench with a planned end on another.
    people.push(await joinedEmployee(db, { actor: U.r1a }));
    people.push(await joinedEmployee(db, { actor: U.r2a, teamId: T.t2, locationId: LOC.austin }));
    people.push(await joinedEmployee(db, { actor: U.r3a, teamId: T.t3 }));
    await setEnd(U.hr, people[1]!.assignmentId, addDays(today, 30));
  });

  const keys = [...Object.keys(U), "ahr", "bu"] as const;
  const accessOf = (k: string) => (k === "ahr" ? ahr : k === "bu" ? bu : { id: U[k as keyof typeof U], access: toUserAccess(k as keyof typeof U) });

  it.each(keys)("%s sees employees and history only with employee:read at org scope; plans only where the assignment is visible", async (k) => {
    const { id, access } = accessOf(k);
    const total = Number((await q<{ n: string }>(`SELECT count(*) AS n FROM eureka.employee`))[0]!.n);
    const totalEv = Number((await q<{ n: string }>(`SELECT count(*) AS n FROM eureka.employment_event`))[0]!.n);
    const seen = await asUser(db.app, id, async (c) => ({
      employees: Number((await c.query(`SELECT count(*) AS n FROM eureka.employee`)).rows[0].n),
      events: Number((await c.query(`SELECT count(*) AS n FROM eureka.employment_event`)).rows[0].n),
      plans: (await c.query(`SELECT assignment_id FROM eureka.assignment_plan ORDER BY 1`)).rows.map((r) => r.assignment_id),
      assignments: new Set((await c.query(`SELECT id FROM eureka.assignment`)).rows.map((r) => r.id as string)),
    }));
    const org = resolveScope(access, "employee:read")?.all === true;
    expect(seen.employees).toBe(org ? total : 0);
    expect(seen.events).toBe(org ? totalEv : 0);
    const allPlans = (await q<{ assignment_id: string }>(`SELECT assignment_id FROM eureka.assignment_plan ORDER BY 1`)).map((r) => r.assignment_id);
    expect(seen.plans).toEqual(allPlans.filter((a) => seen.assignments.has(a)));
  });
});

describe("guards and grants", () => {
  it("the app cannot write employment tables directly", async () => {
    const j = await joinedEmployee(db);
    for (const sql of [
      `UPDATE eureka.employee SET status = 'exited' WHERE person_id = '${j.personId}'`,
      `INSERT INTO eureka.employment_event (person_id, kind) VALUES ('${j.personId}', 'exited')`,
      `INSERT INTO eureka.assignment_plan (assignment_id, planned_end_date) VALUES ('${j.assignmentId}', '2099-01-01')`,
      `DELETE FROM eureka.employee`,
    ]) {
      await expect(asUser(db.app, U.hr, (c) => c.query(sql))).rejects.toThrow(/permission denied/);
    }
  });

  it("the guards refuse the owner and superuser too (no direct write, delete or truncate)", async () => {
    const j = await joinedEmployee(db);
    await expect(db.admin.query(`UPDATE eureka.employee SET status = 'bench' WHERE person_id = $1`, [j.personId])).rejects.toThrow(/employment functions/);
    await expect(db.admin.query(`DELETE FROM eureka.employment_event WHERE person_id = $1`, [j.personId])).rejects.toThrow(/employment functions/);
    await expect(db.admin.query(`TRUNCATE eureka.employee CASCADE`)).rejects.toThrow(/never truncated/);
    await expect(db.admin.query(`TRUNCATE eureka.employment_event`)).rejects.toThrow(/never truncated/);
  });

  it("internal functions are not executable by the app or the worker; the scan only by the worker", async () => {
    for (const fn of [
      `authz.candidate_status_by_employment('${U.r1a}', 'bench')`, `authz.assignment_for_update('${U.r1a}')`,
      `authz.employee_for_update('${U.r1a}')`, `authz.assignment_ending_soon_scan(30)`,
    ]) {
      await expect(asUser(db.app, U.hr, (c) => c.query(`SELECT * FROM ${fn}`))).rejects.toThrow(/permission denied/);
    }
    for (const fn of [`authz.end_assignment('${U.r1a}', CURRENT_DATE, 'completed')`, `authz.exit_employee('${U.r1a}', CURRENT_DATE, 'other')`]) {
      await expect(db.worker.query(`SELECT * FROM ${fn}`)).rejects.toThrow(/permission denied/);
    }
    const acl = await q<{ proname: string; acl: string }>(
      `SELECT p.proname, coalesce(p.proacl::text, '') AS acl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'authz' AND p.proname IN ('end_assignment','set_assignment_end_date','exit_employee','return_employee_to_market',
          'assignment_ending_soon_scan','candidate_status_by_employment','employee_on_assignment_start','employee_on_assignment_end',
          'assignment_for_update','employee_for_update') ORDER BY 1`);
    for (const r of acl) expect(r.acl, r.proname).not.toMatch(/(^|[{,])=X/); // never PUBLIC
    const conf = await q<{ proname: string; cfg: string[] | null; secdef: boolean }>(
      `SELECT p.proname, p.proconfig AS cfg, p.prosecdef AS secdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE (n.nspname = 'authz' AND p.proname LIKE ANY (ARRAY['%employ%','%assignment%'])) OR p.proname LIKE 'employment_%'`);
    expect(conf.length).toBeGreaterThanOrEqual(12);
    for (const r of conf) expect(r.cfg, r.proname).toContain("search_path=pg_catalog, pg_temp");
  });
});

describe("assignment.ending_soon (worker scan)", () => {
  it("emits once per planned end date within the window, ids and dates only; not for closed assignments", async () => {
    const a = await onAssignment(), b = await onAssignment(), c = await onAssignment();
    await setEnd(U.hr, a.assignmentId, addDays(today, 5));
    await setEnd(U.hr, b.assignmentId, addDays(today, 45)); // outside a 30-day window
    await setEnd(U.hr, c.assignmentId, addDays(today, 3));
    await endAssignment(U.hr, c.assignmentId, today, "completed");
    await db.worker.query(`SELECT authz.assignment_ending_soon_scan(30)`);
    const ev = await outbox("assignment.ending_soon", a.assignmentId);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.aggregate_type).toBe("assignment");
    expect(ev[0]!.payload).toEqual({
      assignmentId: a.assignmentId, placementId: a.placementId, personId: a.personId, candidateId: a.candidateId,
      plannedEndDate: addDays(today, 5), daysLeft: 5, notify: ["hr", "accounts"],
    });
    expect(await outbox("assignment.ending_soon", b.assignmentId)).toEqual([]);
    expect(await outbox("assignment.ending_soon", c.assignmentId)).toEqual([]);
    // Idempotent: a second run emits nothing new; a changed date re-arms.
    expect((await db.worker.query(`SELECT authz.assignment_ending_soon_scan(30) AS n`)).rows[0].n).toBe(0);
    await setEnd(U.hr, a.assignmentId, addDays(today, 6));
    expect((await db.worker.query(`SELECT authz.assignment_ending_soon_scan(30) AS n`)).rows[0].n).toBe(1);
    expect(await outbox("assignment.ending_soon", a.assignmentId)).toHaveLength(2);
  });

  it.each([0, 91, null])("refuses a window of %s days", async (d) => {
    await expect(db.worker.query(`SELECT authz.assignment_ending_soon_scan($1)`, [d])).rejects.toThrow(/between 1 and 90/);
  });
});
