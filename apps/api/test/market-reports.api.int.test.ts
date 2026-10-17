import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IN_MARKET_STATUSES, ownsCandidate, resolveScope, type CandidateRef } from "@eureka/shared";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, TEAMS, TECH_ID, U, seedFixtures, toUserAccess } from "./fixtures.js";
import { force, joinedEmployee } from "./employee-seed.js";
import { newCandidate } from "./placement-seed.js";

/**
 * CEO market reports (gap L3, docs/market-reports-api.md): point-in-time
 * counts per role scope (differential against the TypeScript engine over the
 * fixture candidates), groupings, "placed between" with New York day bounds,
 * the audited CSV export, and the database function's own checks.
 */
let db: TestDb;
let app: NestFastifyApplication;
const SECRET = "test-secret-test-secret-test-secret-123";
const PY_ID = "00000000-0000-0000-0000-000000000502";
let batchId: string;
const placed: Record<string, string> = {};

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  await db.admin.query(`INSERT INTO eureka.technology (id, name) VALUES ($1, 'Python')`, [PY_ID]);
  batchId = "00000000-0000-0000-0000-000000000b01";
  await force(db, `INSERT INTO eureka.batch (id, location_id, technology_id, start_month, created_by) VALUES ($1, $2, $3, '2030-01-01', $4)`,
    [batchId, LOC.dallas, PY_ID, U.locD]);
  // Two Python candidates in the Dallas batch (t2, active; t3, in training).
  for (const [teamId, recruiterId, status] of [[T.t2, U.r2a, "active"], [T.t3, U.r3a, "in_training"]] as const) {
    const c = await newCandidate(db, { teamId, recruiterId, locationId: LOC.dallas, marketingStatus: status });
    await force(db, `UPDATE eureka.candidate SET technology_id = $2, batch_id = $3 WHERE id = $1`, [c.id, PY_ID, batchId]);
  }
  // Joined placements (candidate becomes 'placed'), joined_at moved to fixed instants around New York day bounds.
  const joins: [string, string, string, string][] = [
    ["early", U.r1a, T.t1, "2030-03-01T04:59:00Z"], // Feb 28, 23:59 in New York
    ["first", U.r1a, T.t1, "2030-03-01T05:00:00Z"], // Mar 1, 00:00 in New York
    ["last", U.r2a, T.t2, "2030-04-01T03:59:00Z"], // Mar 31, 23:59 in New York
    ["late", U.r3a, T.t3, "2030-04-01T04:00:00Z"], // Apr 1, 00:00 in New York
  ];
  for (const [k, actor, teamId, at] of joins) {
    const j = await joinedEmployee(db, { actor, teamId, locationId: LOC.austin });
    await force(db, `UPDATE eureka.placement SET joined_at = $2 WHERE id = $1`, [j.placementId, at]);
    placed[k] = j.candidateId;
  }
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: SECRET,
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
}, 180_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

type Key = keyof typeof U;
const KEYS = Object.keys(U) as Key[];
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
async function call(key: Key, method: "GET" | "POST", url: string, payload?: unknown) {
  const s = await login(key);
  return app.inject({ method, url, payload: payload as never, headers: { cookie: s.cookie, ...(method === "POST" ? { "x-csrf-token": s.csrf } : {}) } });
}

interface Counts { candidates: number; inMarket: number; placed: number; placedInPeriod: number | null; byStatus: Record<string, number> }
interface Report {
  asOf: string; groupBy: string; placedBetween: { from: string | null; to: string | null; timeZone: string } | null;
  statuses: string[]; inMarketStatuses: string[]; totals: Counts; groups: (Counts & { id: string | null; name: string | null })[];
}
async function report(key: Key, query = ""): Promise<Report> {
  const res = await call(key, "GET", `/api/v1/reports/market${query ? `?${query}` : ""}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Report;
}

interface Cand extends CandidateRef { id: string; technologyId: string; batchId: string | null }
async function allCandidates(): Promise<Cand[]> {
  return (await db.admin.query<Cand>(
    `SELECT id, team_id AS "teamId", recruiter_id AS "recruiterId", location_id AS "locationId", visibility,
            marketing_status AS "marketingStatus", technology_id AS "technologyId", batch_id AS "batchId" FROM eureka.candidate`)).rows;
}

const HOLDERS: Key[] = ["ceo", "ad", "m1", "m2", "l1", "l2", "l3", "locD", "locA"];

describe("access", () => {
  it("only report.market:read holders get the report; everyone else 403", async () => {
    for (const k of KEYS) {
      const expected = resolveScope(toUserAccess(k), "report.market:read") ? 200 : 403;
      expect((await call(k, "GET", "/api/v1/reports/market")).statusCode, k).toBe(expected);
    }
    expect(KEYS.filter((k) => resolveScope(toUserAccess(k), "report.market:read")).sort()).toEqual([...HOLDERS].sort());
  });

  it("validates the query", async () => {
    for (const q of ["groupBy=client", "placedFrom=2030-04-01&placedTo=2030-03-01", "placedFrom=yesterday",
      "placedFrom=2020-01-01&placedTo=2030-01-01", `teamId=${T.t1}`]) {
      expect((await call("ceo", "GET", `/api/v1/reports/market?${q}`)).statusCode, q).toBe(422);
    }
  });
});

describe("differential: counts equal the engine's report.market:read scope over every candidate", () => {
  it.each(HOLDERS)("%s", async (k) => {
    const scope = resolveScope(toUserAccess(k), "report.market:read")!;
    const mine = (await allCandidates()).filter((c) => ownsCandidate(scope, c));
    const d = await report(k, "groupBy=team");
    expect(d.totals.candidates).toBe(mine.length);
    expect(d.totals.inMarket).toBe(mine.filter((c) => (IN_MARKET_STATUSES as readonly string[]).includes(c.marketingStatus)).length);
    expect(d.totals.placed).toBe(mine.filter((c) => c.marketingStatus === "placed").length);
    for (const s of d.statuses) expect(d.totals.byStatus[s], s).toBe(mine.filter((c) => c.marketingStatus === s).length);
    const byTeam = new Map<string, number>();
    for (const c of mine) byTeam.set(c.teamId, (byTeam.get(c.teamId) ?? 0) + 1);
    expect(new Map(d.groups.map((g) => [g.id!, g.candidates]))).toEqual(byTeam);
    // Groups add up to the totals, status by status.
    for (const s of d.statuses) expect(d.groups.reduce((n, g) => n + g.byStatus[s]!, 0), s).toBe(d.totals.byStatus[s]);
    expect(d.totals.placedInPeriod).toBeNull();
    expect(d.placedBetween).toBeNull();
  });

  it("a lead never counts other teams' Open-to-all-teams candidates", async () => {
    const d = await report("l1", "groupBy=team");
    expect(d.groups.map((g) => g.id)).toEqual([T.t1]);
  });

  it("location roles count only their location", async () => {
    const d = await report("locD", "groupBy=location");
    expect(d.groups.map((g) => [g.id, g.name])).toEqual([[LOC.dallas, "Dallas"]]);
    const a = await report("locA", "groupBy=location");
    expect(a.groups.map((g) => [g.id, g.name])).toEqual([[LOC.austin, "Austin"]]);
  });
});

describe("groupings", () => {
  it("technology and batch, with candidates outside any batch last", async () => {
    const tech = await report("ceo", "groupBy=technology");
    expect(tech.groupBy).toBe("technology");
    expect(tech.groups.map((g) => g.name)).toEqual(["Java", "Python"]);
    const py = tech.groups.find((g) => g.id === PY_ID)!;
    expect(py).toMatchObject({ candidates: 2, inMarket: 1, placed: 0 });
    expect(py.byStatus).toMatchObject({ active: 1, in_training: 1 });
    expect(tech.groups.find((g) => g.id === TECH_ID)!.candidates).toBe(tech.totals.candidates - 2);

    const batch = await report("ceo", "groupBy=batch");
    expect(batch.groups.map((g) => [g.id, g.name, g.candidates])).toEqual([
      [batchId, "Python · Dallas · Jan 2030", 2],
      [null, null, batch.totals.candidates - 2],
    ]);
  });

  it("lead and recruiter (allocation counts)", async () => {
    const all = await allCandidates();
    const lead = await report("m1", "groupBy=lead");
    const m1Teams = TEAMS.filter((t) => t.id === T.t1 || t.id === T.t2);
    expect(lead.groups.map((g) => [g.id, g.name, g.candidates]).sort()).toEqual(
      m1Teams.map((t) => [t.lead, t.lead === U.l1 ? "l1" : "l2", all.filter((c) => c.teamId === t.id).length]).sort());

    const rec = await report("l1", "groupBy=recruiter");
    const t1 = all.filter((c) => c.teamId === T.t1);
    expect(new Map(rec.groups.map((g) => [g.id, g.candidates]))).toEqual(new Map([
      [U.r1a, t1.filter((c) => c.recruiterId === U.r1a).length],
      [U.r1b, t1.filter((c) => c.recruiterId === U.r1b).length],
      [null, t1.filter((c) => c.recruiterId === null).length],
    ]));
    expect(rec.groups.at(-1)!.id).toBeNull(); // unassigned last
    expect(rec.groups.find((g) => g.id === U.r1a)!.name).toBe("r1a");
  });
});

describe("placed between (New York calendar days)", () => {
  it("counts candidates whose placement joined in the window, by the candidate's group", async () => {
    const d = await report("ceo", "groupBy=team&placedFrom=2030-03-01&placedTo=2030-03-31");
    expect(d.placedBetween).toEqual({ from: "2030-03-01", to: "2030-03-31", timeZone: "America/New_York" });
    expect(d.totals.placedInPeriod).toBe(2); // "first" and "last"; not "early" or "late"
    expect(new Map(d.groups.map((g) => [g.id, g.placedInPeriod]))).toEqual(new Map([[T.t1, 1], [T.t2, 1], [T.t3, 0]]));
    // Point-in-time counts do not depend on the window.
    expect(d.totals.placed).toBe((await report("ceo", "groupBy=team")).totals.placed);
  });

  it("open-ended windows", async () => {
    expect((await report("ceo", "placedFrom=2030-03-01")).totals.placedInPeriod).toBe(3);
    expect((await report("ceo", "placedTo=2030-03-31")).totals.placedInPeriod).toBe(3);
    expect((await report("ceo", "placedFrom=2030-04-02")).totals.placedInPeriod).toBe(0);
  });

  it("stays inside the caller's scope", async () => {
    const d = await report("l1", "placedFrom=2030-02-01&placedTo=2030-04-30");
    expect(d.totals.placedInPeriod).toBe(2); // early and first: team t1 only
  });
});

describe("export", () => {
  const audits = async () => (await db.admin.query(
    `SELECT actor_id, entity_type, entity_id, changes FROM eureka.audit_event WHERE action = 'report.export' ORDER BY seq`)).rows;

  it("CSV of the groups plus a total, audited with the grouping, period and counts only", async () => {
    const res = await call("ceo", "POST", "/api/v1/reports/market/export", { groupBy: "technology", placedFrom: "2030-03-01", placedTo: "2030-03-31" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/market-by-technology-\d{4}-\d{2}-\d{2}\.csv/);
    expect(res.headers["x-export-rows"]).toBe("2");
    const lines = res.body.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe("Technology,Candidates,In market,Placed,Placed 2030-03-01 to 2030-03-31,"
      + "In training,Active,On hold,Stopped,Full of interviews,Confirmation,Placed,Bench,Terminated");
    expect(lines.map((l) => l.split(",")[0])).toEqual(["Technology", "Java", "Python", "Total"]);
    const view = await report("ceo", "groupBy=technology&placedFrom=2030-03-01&placedTo=2030-03-31");
    expect(lines[3]!.split(",").slice(1, 5).map(Number)).toEqual(
      [view.totals.candidates, view.totals.inMarket, view.totals.placed, view.totals.placedInPeriod]);
    expect(res.body).not.toMatch(/Cand\d|PlCand|\+1469|@/);
    const a = (await audits()).at(-1)!;
    expect(a).toMatchObject({ actor_id: U.ceo, entity_type: "candidate", entity_id: null });
    expect(a.changes).toEqual({
      report: "market", groupBy: "technology", placedFrom: "2030-03-01", placedTo: "2030-03-31",
      rows: 2, candidates: view.totals.candidates, truncated: false,
    });
  });

  it("a lead's export matches their view; location roles and non-holders cannot export", async () => {
    const res = await call("l1", "POST", "/api/v1/reports/market/export", { groupBy: "recruiter" });
    expect(res.statusCode, res.body).toBe(200);
    const lines = res.body.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines.at(-1)!.split(",").slice(0, 2)).toEqual(["Total", String((await report("l1")).totals.candidates)]);
    expect(lines.at(-2)!.split(",")[0]).toBe("Unassigned");
    for (const k of ["locD", "locA", "hr", "r1a", "admin"] as const) {
      expect((await call(k, "POST", "/api/v1/reports/market/export", {})).statusCode, k).toBe(403);
    }
    expect((await call("ceo", "POST", "/api/v1/reports/market/export", { groupBy: "client" })).statusCode).toBe(422);
  });

  it("rate-limits exports per user", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await call("ad", "POST", "/api/v1/reports/market/export", {})).statusCode);
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes[5]).toBe(429);
  });
});

describe("authz.market_report (database)", () => {
  const run = (user: string, group: string | null, exp = false, from: string | null = null, to: string | null = null) =>
    asUser(db.app, user, async (c) => (await c.query<{ candidates: number }>(
      `SELECT * FROM authz.market_report($1, $2, $3, $4)`, [group, from, to, exp])).rows);

  it("returns nothing for callers without report.market:read, and the export branch needs report:export", async () => {
    expect(await run(U.r1a, "team")).toEqual([]);
    expect(await run(U.hr, "team")).toEqual([]);
    expect((await run(U.locD, "team")).length).toBeGreaterThan(0);
    expect(await run(U.locD, "team", true)).toEqual([]); // location roles hold no report:export
    const sum = (rows: { candidates: number }[]) => rows.reduce((n, r) => n + r.candidates, 0);
    expect(sum(await run(U.l1, "team", true))).toBe(sum(await run(U.l1, "team")));
  });

  it("rejects unknown groupings and inverted periods (NULL-safe)", async () => {
    await expect(run(U.ceo, "client")).rejects.toThrow(/invalid_group/);
    await expect(run(U.ceo, null)).rejects.toThrow(/invalid_group/);
    await expect(run(U.ceo, "team", false, "2030-04-01", "2030-03-01")).rejects.toThrow(/invalid_period/);
  });

  it("is invoker-rights, pinned search_path, not executable by PUBLIC or the worker", async () => {
    const r = (await db.admin.query<{ secdef: boolean; cfg: string[]; acl: string }>(
      `SELECT p.prosecdef AS secdef, p.proconfig AS cfg, coalesce(p.proacl::text, '') AS acl FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'authz' AND p.proname = 'market_report'`)).rows;
    expect(r).toHaveLength(1);
    expect(r[0]!.secdef).toBe(false);
    expect(r[0]!.cfg).toContain("search_path=pg_catalog, pg_temp");
    expect(r[0]!.acl).not.toMatch(/(^|[{,])=X/);
    await expect(db.worker.query(`SELECT * FROM authz.market_report('team', NULL, NULL, false)`)).rejects.toThrow(/permission denied/);
  });

  it("computes scope arrays once per call, not per candidate (rule 3), including the placed-between probe", async () => {
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL track_functions = 'all'");
      await c.query("SELECT set_config('eureka.user_id', $1, true)", [U.m1]);
      const count = async () => Number((await c.query<{ n: string | null }>(
        `SELECT pg_stat_get_xact_function_calls('authz.team_ids(text)'::regprocedure) AS n`)).rows[0]!.n ?? 0);
      const before = await count();
      await c.query("SET LOCAL ROLE eureka_app");
      const rows = (await c.query<{ candidates: number }>(
        `SELECT * FROM authz.market_report('recruiter', '2030-01-01', '2030-12-31', true)`)).rows;
      await c.query("RESET ROLE");
      expect(rows.reduce((n, r) => n + r.candidates, 0)).toBeGreaterThan(50);
      expect((await count()) - before).toBeLessThanOrEqual(8);
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  });

  it("runs under the caller's RLS: a scope the policies do not cover adds no rows", async () => {
    // Even with a forged org-wide report.market:read grant, the candidate policies still limit the rows
    // to what the coach can read (their coached team).
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query(`INSERT INTO eureka.role_permission (role_key, permission, scope) VALUES ('interview_coach', 'report.market:read', 'org')`);
      await c.query("COMMIT");
    } finally { c.release(); }
    try {
      const rows = await run(U.coach, "team");
      const readable = await asUser(db.app, U.coach, async (x) => (await x.query<{ n: number }>(`SELECT count(*)::int AS n FROM eureka.candidate`)).rows[0]!.n);
      expect(rows.reduce((n, r) => n + r.candidates, 0)).toBe(readable);
      expect(readable).toBeGreaterThan(0);
      expect(readable).toBeLessThan((await allCandidates()).length);
    } finally {
      await db.admin.query(`DELETE FROM eureka.role_permission WHERE role_key = 'interview_coach' AND permission = 'report.market:read'`);
    }
  });
});
