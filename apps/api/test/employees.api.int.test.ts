import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { can, resolveScope, type Permission, type UserAccess } from "@eureka/shared";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, U, seedFixtures, toUserAccess } from "./fixtures.js";
import { extraUser, newCandidate } from "./placement-seed.js";
import { backdate, force, joinedEmployee, type Joined } from "./employee-seed.js";

/** API checks for docs/employees-api.md (employees, assignment lifecycle, joinings/exits report). */
let db: TestDb;
let app: NestFastifyApplication;
let today: string;
const extras: Record<string, { id: string; access: UserAccess }> = {};
const SECRET = "test-secret-test-secret-test-secret-123";

const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  extras.ahr = await extraUser(db, "ahr", "associate_hr");
  extras.bu = await extraUser(db, "bu", "bu_head");
  extras.docs = await extraUser(db, "docs", "documents_team");
  today = (await db.admin.query<{ d: string }>(`SELECT CURRENT_DATE::text AS d`)).rows[0]!.d;
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: SECRET,
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

type Key = keyof typeof U | "ahr" | "bu" | "docs";
const ALL_KEYS: Key[] = [...(Object.keys(U) as (keyof typeof U)[]), "ahr", "bu", "docs"];
const idOf = (k: Key) => (k in U ? U[k as keyof typeof U] : extras[k]!.id);
const accessOf = (k: Key): UserAccess => (k in U ? toUserAccess(k as keyof typeof U) : extras[k]!.access);
const sessions = new Map<string, { cookie: string; csrf: string }>();

async function login(key: Key) {
  const cached = sessions.get(key);
  if (cached) return cached;
  const res = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: `${key}@eureka.example` } });
  expect(res.statusCode).toBe(204);
  const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
  const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
  const s = { cookie, csrf: me.json().csrfToken as string };
  sessions.set(key, s);
  return s;
}
async function call(key: Key, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) {
  const s = await login(key);
  return app.inject({ method, url, payload: payload as never, headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}) } });
}
const audits = async (action: string, entityId?: string) => (await db.admin.query(
  `SELECT actor_id, entity_type, entity_id, changes FROM eureka.audit_event WHERE action = $1 AND ($2::uuid IS NULL OR entity_id = $2) ORDER BY seq`,
  [action, entityId ?? null])).rows;

async function onAssignment(o: Parameters<typeof joinedEmployee>[1] = {}): Promise<Joined> {
  const j = await joinedEmployee(db, o);
  await backdate(db, j, addDays(today, -60));
  return j;
}

describe("permission matrix", () => {
  let j: Joined;
  beforeAll(async () => { j = await onAssignment(); });

  it.each(ALL_KEYS)("%s", async (k) => {
    const access = accessOf(k);
    const empAll = resolveScope(access, "employee:read")?.all === true;
    expect((await call(k, "GET", "/api/v1/employees")).statusCode, "list").toBe(empAll ? 200 : 403);
    expect((await call(k, "GET", `/api/v1/employees/${j.personId}`)).statusCode, "detail").toBe(empAll ? 200 : 403);
    expect((await call(k, "GET", `/api/v1/reports/joinings-exits?from=2025-01-01&to=2025-01-31`)).statusCode, "report")
      .toBe(can(access, "report:read") ? 200 : 403);
    // Writes: refused by the guard without assignment:update; with it, a bad body is a 422 (the guard passed).
    const writes: [string, "POST" | "PUT", string][] = [
      ["end", "POST", `/api/v1/assignments/${j.assignmentId}/end`],
      ["planned", "PUT", `/api/v1/assignments/${j.assignmentId}/planned-end-date`],
      ["exit", "POST", `/api/v1/employees/${j.personId}/exit`],
    ];
    for (const [name, m, url] of writes) {
      expect((await call(k, m, url, { bogus: true })).statusCode, name).toBe(can(access, "assignment:update") ? 422 : 403);
    }
    const exportCode = (await call(k, "POST", "/api/v1/reports/joinings-exits/export", { from: "2025-01-01" })).statusCode;
    expect(exportCode, "export").toBe(can(access, "report:export") ? 422 : 403);
  });
});

describe("employees list and detail", () => {
  let a: Joined, b: Joined, c: Joined;
  beforeAll(async () => {
    a = await onAssignment({ actor: U.r1a });
    b = await onAssignment({ actor: U.r2a, teamId: T.t2, locationId: LOC.austin });
    c = await onAssignment({ actor: U.r3a, teamId: T.t3 });
    expect((await call("hr", "PUT", `/api/v1/assignments/${a.assignmentId}/planned-end-date`, { plannedEndDate: addDays(today, 10) })).statusCode).toBe(200);
    expect((await call("hr", "POST", `/api/v1/assignments/${c.assignmentId}/end`, { endDate: today, reason: "completed" })).statusCode).toBe(200);
  });

  const ids = (r: { json(): { items: { id: string }[] } }) => r.json().items.map((i) => i.id);

  it("lists every employee for HR with status, candidate, assignment and action hints", async () => {
    const res = await call("hr", "GET", "/api/v1/employees?limit=200");
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Record<string, any>[];
    const ia = items.find((i) => i.id === a.personId)!;
    expect(ia).toMatchObject({
      status: "on_assignment", candidate: { id: a.candidateId }, location: { id: LOC.dallas }, team: { id: T.t1 },
      assignment: { id: a.assignmentId, assignmentNo: 1, endDate: null, plannedEndDate: addDays(today, 10), placementId: a.placementId },
      actions: { endAssignment: true, setEndDate: true, exit: false, returnToMarket: false },
    });
    expect(typeof ia.candidate.name).toBe("string");
    // No contact data on the list.
    expect(JSON.stringify(items)).not.toMatch(/phone|email|rate|\+1469/i);
    const ic = items.find((i) => i.id === c.personId)!;
    expect(ic).toMatchObject({ status: "bench", actions: { endAssignment: false, setEndDate: false, exit: true, returnToMarket: true } });
  });

  it("filters by status, location, client, end date soon and name", async () => {
    expect(ids(await call("hr", "GET", "/api/v1/employees?status=bench&limit=200"))).toContain(c.personId);
    expect(ids(await call("hr", "GET", "/api/v1/employees?status=bench&limit=200"))).not.toContain(a.personId);
    const austin = ids(await call("hr", "GET", `/api/v1/employees?locationId=${LOC.austin}&limit=200`));
    expect(austin).toContain(b.personId);
    expect(austin).not.toContain(a.personId);
    const soon = ids(await call("hr", "GET", "/api/v1/employees?endingWithinDays=30&limit=200"));
    expect(soon).toEqual([a.personId]);
    const name = (await db.admin.query(`SELECT first_name || ' ' || last_name AS n FROM eureka.person WHERE id = $1`, [b.personId])).rows[0].n;
    expect(ids(await call("hr", "GET", `/api/v1/employees?search=${encodeURIComponent(name)}`))).toEqual([b.personId]);
    const client = (await db.admin.query(`SELECT client_id FROM eureka.placement WHERE id = $1`, [a.placementId])).rows[0].client_id;
    const byClient = ids(await call("hr", "GET", `/api/v1/employees?clientId=${client}&limit=200`));
    expect(byClient).toContain(a.personId);
    expect(byClient).not.toContain(c.personId); // benched: no current client
    expect((await call("hr", "GET", "/api/v1/employees?status=hired")).statusCode).toBe(422);
    expect((await call("hr", "GET", "/api/v1/employees?teamId=x")).statusCode).toBe(422);
  });

  it("pages with a cursor", async () => {
    const all = ids(await call("hr", "GET", "/api/v1/employees?limit=200"));
    const p1 = await call("hr", "GET", "/api/v1/employees?limit=2");
    const p2 = await call("hr", "GET", `/api/v1/employees?limit=2&cursor=${encodeURIComponent(p1.json().nextCursor)}`);
    expect([...ids(p1), ...ids(p2)]).toEqual(all.slice(0, 4));
  });

  it("read-only roles see no actions; Immigration sees employees but no assignment (placement not visible)", async () => {
    const ceo = (await call("ceo", "GET", "/api/v1/employees?limit=200")).json().items.find((i: { id: string }) => i.id === c.personId);
    expect(ceo.actions).toEqual({ endAssignment: false, setEndDate: false, exit: false, returnToMarket: false });
    const imm = (await call("imm", "GET", "/api/v1/employees?limit=200")).json().items.find((i: { id: string }) => i.id === a.personId);
    expect(imm.assignment).toBeNull();
    expect(imm.actions.endAssignment).toBe(false);
    // BU Head: employee:read without candidate:read: the name stays hidden (no new PII exposure).
    const bu = (await call("bu", "GET", "/api/v1/employees?limit=200")).json().items.find((i: { id: string }) => i.id === a.personId);
    expect(bu.candidate.name).toBeNull();
  });

  it("detail returns the assignment history and the employment history", async () => {
    const res = await call("acct", "GET", `/api/v1/employees/${c.personId}`);
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.assignments).toEqual([expect.objectContaining({ id: c.assignmentId, assignmentNo: 1, endDate: today, endReason: "completed", isFirstPlacement: true })]);
    expect(d.history.map((h: { kind: string }) => h.kind)).toEqual(["ended", "started"]);
    expect(d.history[0]).toMatchObject({ toStatus: "bench", reason: "completed", effectiveOn: today, actor: "hr" });
    expect((await call("hr", "GET", "/api/v1/employees/00000000-0000-4000-8000-0000000000ff")).statusCode).toBe(404);
  });
});

describe("lifecycle through the API", () => {
  it("project exit: 200, employee and candidate on the bench, audited without free text", async () => {
    const j = await onAssignment();
    const end = addDays(today, -3);
    const res = await call("hr", "POST", `/api/v1/assignments/${j.assignmentId}/end`, { endDate: end, reason: "terminated" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ id: j.assignmentId, endDate: end, endReason: "terminated", employeeStatus: "bench" });
    expect(await audits("assignment.ended", j.assignmentId)).toEqual([{
      actor_id: U.hr, entity_type: "assignment", entity_id: j.assignmentId,
      changes: { endDate: end, reason: "terminated", employeeFrom: "on_assignment", employeeTo: "bench" },
    }]);
    expect((await audits("candidate.transition", j.candidateId)).at(-1)!.changes).toEqual({ from: "placed", to: "bench", via: "employment" });
    const again = await call("hr", "POST", `/api/v1/assignments/${j.assignmentId}/end`, { endDate: end, reason: "terminated" });
    expect([again.statusCode, again.json().detail]).toEqual([422, "assignment_closed"]);
  });

  it("maps database refusals: future end date, bad reason, unknown id, not permitted", async () => {
    const j = await onAssignment();
    const future = await call("hr", "POST", `/api/v1/assignments/${j.assignmentId}/end`, { endDate: addDays(today, 2), reason: "completed" });
    expect([future.statusCode, future.json().detail]).toEqual([422, "invalid_end_date"]);
    expect((await call("hr", "POST", `/api/v1/assignments/${j.assignmentId}/end`, { endDate: today, reason: "bgc_failed" })).statusCode).toBe(422);
    expect((await call("hr", "POST", `/api/v1/assignments/00000000-0000-4000-8000-0000000000ff/end`, { endDate: today, reason: "completed" })).statusCode).toBe(404);
    const past = await call("acct", "PUT", `/api/v1/assignments/${j.assignmentId}/planned-end-date`, { plannedEndDate: addDays(today, -1) });
    expect([past.statusCode, past.json().detail]).toEqual([422, "invalid_end_date"]);
    expect(await audits("assignment.ended", j.assignmentId)).toEqual([]);
  });

  it("planned end date: set then extend, audited with dates only", async () => {
    const j = await onAssignment();
    const d1 = addDays(today, 30), d2 = addDays(today, 120);
    expect((await call("ahr", "PUT", `/api/v1/assignments/${j.assignmentId}/planned-end-date`, { plannedEndDate: d1 })).json())
      .toEqual({ id: j.assignmentId, plannedEndDate: d1, previousPlannedEndDate: null });
    expect((await call("hr", "PUT", `/api/v1/assignments/${j.assignmentId}/planned-end-date`, { plannedEndDate: d2 })).json())
      .toEqual({ id: j.assignmentId, plannedEndDate: d2, previousPlannedEndDate: d1 });
    expect((await audits("assignment.planned_end", j.assignmentId)).map((x) => x.changes)).toEqual([{ from: null, to: d1 }, { from: d1, to: d2 }]);
    const same = await call("hr", "PUT", `/api/v1/assignments/${j.assignmentId}/planned-end-date`, { plannedEndDate: d2 });
    expect([same.statusCode, same.json().detail]).toEqual([422, "unchanged"]);
  });

  it("exit and return to market", async () => {
    const j = await onAssignment();
    expect((await call("hr", "POST", `/api/v1/employees/${j.personId}/exit`, { exitDate: today, reason: "resigned" })).json().detail).toBe("invalid_transition");
    await call("hr", "POST", `/api/v1/assignments/${j.assignmentId}/end`, { endDate: addDays(today, -2), reason: "completed" });
    const back = await call("acct", "POST", `/api/v1/employees/${j.personId}/return-to-market`, {});
    expect([back.statusCode, back.json()]).toEqual([200, { id: j.personId, candidateStatus: "active" }]);
    expect((await audits("candidate.transition", j.candidateId)).at(-1)!.changes).toEqual({ from: "bench", to: "active", via: "employment" });
    const twice = await call("acct", "POST", `/api/v1/employees/${j.personId}/return-to-market`, {});
    expect([twice.statusCode, twice.json().detail]).toEqual([422, "candidate_not_on_bench"]);
    const ex = await call("hr", "POST", `/api/v1/employees/${j.personId}/exit`, { exitDate: today, reason: "other" });
    expect([ex.statusCode, ex.json()]).toEqual([200, { id: j.personId, status: "exited" }]);
    expect((await audits("employee.exited", j.personId)).map((x) => x.changes)).toEqual([{ from: "bench", to: "exited", exitDate: today, reason: "other" }]);
    expect((await call("hr", "POST", `/api/v1/employees/${j.personId}/exit`, { exitDate: today, reason: "other" })).statusCode).toBe(422);
    expect((await call("hr", "POST", `/api/v1/employees/00000000-0000-4000-8000-0000000000ff/exit`, { exitDate: today, reason: "other" })).statusCode).toBe(404);
  });
});

// ---- joinings/exits report: hand-calculated per role ----
const PERIOD = { from: "2025-01-01", to: "2025-06-30" };
const Q = `from=${PERIOD.from}&to=${PERIOD.to}`;
const seeded: Record<string, Joined> = {};

/**
 * Fixed past dates (set as superuser: the app only sets today):
 *   A r1a (t1) start 2025-01-10, open          -> joining
 *   B r1b (t1) start 2024-12-01, end 2025-02-15 completed -> exit
 *   C r2a (t2) start 2025-03-01, end 2025-05-20 resigned  -> joining + exit
 *   D r3a (t3) start 2025-04-01, open          -> joining
 *   E r3a (t3) start 2025-07-15, open          -> outside the period
 *   F l1 on an unassigned t1 candidate, start 2025-02-02, end 2025-06-30 bgc_failed -> joining + exit
 */
const PLAN: [key: string, actor: string, team: string, start: string, end: string | null, reason: string | null, unassigned: boolean][] = [
  ["A", U.r1a, T.t1, "2025-01-10", null, null, false],
  ["B", U.r1b, T.t1, "2024-12-01", "2025-02-15", "completed", false],
  ["C", U.r2a, T.t2, "2025-03-01", "2025-05-20", "resigned", false],
  ["D", U.r3a, T.t3, "2025-04-01", null, null, false],
  ["E", U.r3a, T.t3, "2025-07-15", null, null, false],
  ["F", U.l1, T.t1, "2025-02-02", "2025-06-30", "bgc_failed", true],
];
/** Expected [joinings, exits] per role (assignment:read scope ∩ report:read scope). */
const EXPECTED: Partial<Record<Key, [number, number] | 403>> = {
  r1a: [1, 0], r1b: [0, 1], r2a: [1, 1], r3a: [1, 0],
  l1: [2, 2], l2: [1, 1], l3: [1, 0], m1: [3, 3], m2: [1, 0],
  ad: [4, 3], om: [4, 3], ceo: [4, 3], hr: [4, 3], acct: [4, 3], bu: [4, 3],
  locD: [0, 0], locA: [0, 0], coach: 403, admin: 403, admin2: 403, imm: 403, ahr: 403, docs: 403,
};

describe("joinings/exits report", () => {
  beforeAll(async () => {
    for (const [k, actor, team, start, end, reason, unassigned] of PLAN) {
      const candidateId = unassigned
        ? (await newCandidate(db, { teamId: team, recruiterId: null, locationId: LOC.dallas })).id
        : undefined;
      const j = await joinedEmployee(db, { actor, teamId: team, candidateId });
      await force(db, `UPDATE eureka.assignment SET start_date = $2, end_date = $3, end_reason = $4 WHERE id = $1`,
        [j.assignmentId, start, end, reason]);
      seeded[k] = j;
    }
  });

  it.each(ALL_KEYS)("%s: totals match the hand-calculated fixture", async (k) => {
    const res = await call(k, "GET", `/api/v1/reports/joinings-exits?${Q}`);
    const exp = EXPECTED[k];
    if (exp === 403) { expect(res.statusCode).toBe(403); return; }
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json();
    expect([r.totals.joinings, r.totals.exits], k).toEqual(exp);
    expect(r.totals.firstPlacements).toBe(exp![0]);
    expect(r.items).toHaveLength(exp![0] + exp![1]);
    expect(r.byTeam.reduce((n: number, g: { joinings: number; exits: number }) => n + g.joinings + g.exits, 0)).toBe(exp![0] + exp![1]);
  });

  it("org totals break exits down by reason and list items newest first", async () => {
    const r = (await call("hr", "GET", `/api/v1/reports/joinings-exits?${Q}`)).json();
    expect(r.totals.exitsByReason).toEqual({ completed: 1, terminated: 0, resigned: 1, bgc_failed: 1 });
    expect(r.items.map((i: { kind: string; date: string }) => `${i.kind}:${i.date}`)).toEqual([
      "exit:2025-06-30", "exit:2025-05-20", "joining:2025-04-01", "joining:2025-03-01", "exit:2025-02-15", "joining:2025-02-02", "joining:2025-01-10",
    ]);
    expect(r.truncated).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/phone|email|rate|\+1469/i);
  });

  it.each(ALL_KEYS)("differential, %s: report counts equal the assignments the role can read (API and RLS)", async (k) => {
    const res = await call(k, "GET", `/api/v1/reports/joinings-exits?${Q}`);
    if (res.statusCode === 403) return;
    const r = res.json();
    // What the role can list: placement detail carries `assignment` only where assignment:read covers it.
    let joinings = 0, exits = 0;
    for (const j of Object.values(seeded)) {
      const p = await call(k, "GET", `/api/v1/placements/${j.placementId}`);
      if (p.statusCode !== 200 || !p.json().assignment) continue;
      const a = p.json().assignment;
      if (a.startDate >= PERIOD.from && a.startDate <= PERIOD.to) joinings++;
      if (a.endDate && a.endDate >= PERIOD.from && a.endDate <= PERIOD.to) exits++;
    }
    expect([r.totals.joinings, r.totals.exits], "API lists").toEqual([joinings, exits]);
    const rls = await asUser(db.app, idOf(k), async (c) => (await c.query(
      `SELECT count(*) FILTER (WHERE start_date BETWEEN $1 AND $2)::int AS j, count(*) FILTER (WHERE end_date BETWEEN $1 AND $2)::int AS e
       FROM eureka.assignment`, [PERIOD.from, PERIOD.to])).rows[0]);
    expect([r.totals.joinings, r.totals.exits], "RLS").toEqual([rls.j, rls.e]);
  });

  it("validates the period", async () => {
    for (const q of ["from=2025-02-01&to=2025-01-01", "from=2025-01-01", "from=2020-01-01&to=2025-01-01", "from=x&to=y", `${Q}&teamId=${T.t1}`]) {
      expect((await call("hr", "GET", `/api/v1/reports/joinings-exits?${q}`)).statusCode, q).toBe(422);
    }
  });

  it("export: CSV limited to report:export scope, no contact data, audited with the period and count only", async () => {
    const res = await call("l1", "POST", "/api/v1/reports/joinings-exits/export", PERIOD);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["x-export-rows"]).toBe("4");
    expect(res.headers["x-export-truncated"]).toBe("false");
    const lines = res.body.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe("Event,Date,Candidate,Assignment no.,Client,Team,Recruiter,Location,First placement,End reason");
    expect(lines.slice(1).map((l) => l.split(",").slice(0, 2).join(","))).toEqual([
      "Exit,2025-06-30", "Exit,2025-02-15", "Joining,2025-02-02", "Joining,2025-01-10",
    ]);
    expect(res.body).not.toMatch(/\+1469|@|phone/i);
    const a = (await audits("report.export")).at(-1)!;
    expect(a.actor_id).toBe(U.l1);
    expect(a.changes).toEqual({ report: "joinings_exits", from: PERIOD.from, to: PERIOD.to, rows: 4, truncated: false, cap: 50000 });
    // HR reads the report but cannot export it.
    expect((await call("hr", "POST", "/api/v1/reports/joinings-exits/export", PERIOD)).statusCode).toBe(403);
  });

  it("rate-limits exports per user", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await call("om", "POST", "/api/v1/reports/joinings-exits/export", PERIOD)).statusCode);
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes[5]).toBe(429);
  });
});

/** The catalog roles that may write employment data hold employee:read at org scope (the database requires both). */
it("every assignment:update holder also holds employee:read at org scope", () => {
  for (const k of ALL_KEYS) {
    const access = accessOf(k);
    if (can(access, "assignment:update" as Permission)) expect(resolveScope(access, "employee:read")?.all, k).toBe(true);
  }
});
