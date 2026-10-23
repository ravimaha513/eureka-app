import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INTERVIEW_REPORT_EXCLUDED_STATUSES, durationBucket } from "@eureka/shared";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { U, seedFixtures } from "./fixtures.js";
import { seedPipeline, type PipelineSeed } from "./pipeline-seed.js";

/**
 * Interview reports (gap L4, migration 0130, docs/interviews-settings-api.md
 * "Interview reports"): grouped report by coach / technology / candidate /
 * duration bucket, daily report with candidate feedback, CSV exports, the
 * board's candidate feedback column and the database coach check.
 */
let db: TestDb;
let app: NestFastifyApplication;
let seed: PipelineSeed;
const SECRET = "test-secret-test-secret-test-secret-123";
const PYTHON = "00000000-0000-0000-0000-000000000502";
const NOTES = "Asked about Kafka partitions";

const FROM = "2030-01-01T00:00:00Z";
const TO = "2030-03-01T00:00:00Z";
const DAY_FROM = "2030-01-07T00:00:00Z";
const DAY_TO = "2030-01-08T00:00:00Z";

beforeAll(async () => {
  db = await createTestDb();
  const candidates = await seedFixtures(db.admin);
  seed = await seedPipeline(db, candidates);
  const iv = seed.interviews;
  // Shape the data directly (triggers off): coaches, clearance, statuses, durations, a second technology.
  const c = await db.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query(`INSERT INTO eureka.technology (id, name) VALUES ($1, 'Python')`, [PYTHON]);
    for (const [n, i] of iv.entries()) {
      if (n % 3 === 0) await c.query(`UPDATE eureka.interview SET coach_id = $2 WHERE id = $1`, [i.id, U.coach]);
      if (n % 4 === 0) await c.query(`UPDATE eureka.interview SET cleared = true, cleared_at = now() WHERE id = $1`, [i.id]);
      if (n % 2 === 1) await c.query(`UPDATE eureka.candidate SET technology_id = $2 WHERE id = $1`, [i.candidate.id, PYTHON]);
    }
    await c.query(`UPDATE eureka.interview SET call_status = 'cancelled' WHERE id = $1`, [iv[5]!.id]);
    await c.query(`UPDATE eureka.interview SET call_status = 'completed' WHERE id = ANY($1)`, [[iv[0]!.id, iv[1]!.id]]);
    await c.query(`UPDATE eureka.interview SET ends_at = starts_at + interval '25 minutes' WHERE id = $1`, [iv[1]!.id]);
    await c.query(`UPDATE eureka.interview SET ends_at = starts_at + interval '95 minutes' WHERE id = $1`, [iv[2]!.id]);
    // 130 minutes: pick an interview whose candidate has no interview in the next slot (per-candidate overlap rule).
    const long = iv.findIndex((i, n) => n > 5 && iv[n + 1] !== undefined && iv[n + 1]!.candidate.id !== i.candidate.id
      && !iv.some((o) => o !== i && o.candidate.id === i.candidate.id));
    await c.query(`UPDATE eureka.interview SET ends_at = starts_at + interval '130 minutes' WHERE id = $1`, [iv[long]!.id]);
    // Candidate feedback (feedback email, kind 'candidate'): two answers, the later one counts.
    await c.query(`INSERT INTO eureka.interview_feedback (interview_id, kind, rating, notes, next_step, created_at)
                   VALUES ($1, 'candidate', 2, 'first answer', NULL, now() - interval '1 hour'),
                          ($1, 'candidate', 4, $2, 'Second round', now())`, [iv[0]!.id, NOTES]);
    await c.query("COMMIT");
  } finally {
    c.release();
  }
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: SECRET, GOOGLE_HOSTED_DOMAIN: "eureka.example",
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

type Key = keyof typeof U;
interface Session { cookie: string; csrf: string }
const sessions = new Map<string, Session>();
async function login(key: Key): Promise<Session> {
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
async function call(key: Key, method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) {
  const s = await login(key);
  return app.inject({ method, url, payload: payload as never,
    headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}) } });
}
const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();

interface BoardItem {
  id: string; cleared: boolean; callStatus: string; durationMin: number; coach: { id: string } | null;
  candidate: { id: string; name: string | null };
  candidateFeedback: { rating: number | null; notes: string | null; submittedAt: string } | null;
}
async function board(key: Key, from = FROM, to = TO): Promise<BoardItem[]> {
  const out: BoardItem[] = [];
  let cursor = "";
  for (;;) {
    const res = await call(key, "GET", `/api/v1/interviews?${qs({ from, to, limit: "200", ...(cursor ? { cursor } : {}) })}`);
    expect(res.statusCode, res.body).toBe(200);
    out.push(...res.json().items);
    cursor = res.json().nextCursor;
    if (!cursor) return out;
  }
}
const counted = (items: BoardItem[]) => items.filter((i) => !(INTERVIEW_REPORT_EXCLUDED_STATUSES as readonly string[]).includes(i.callStatus));

interface Group { key: string | null; label: string; interviews: number; cleared: number; completed: number; totalDurationMin: number; avgDurationMin: number | null }
const byKey = (groups: Group[]) => new Map(groups.map((g) => [g.key, g]));

function expectGroups(groups: Group[], items: BoardItem[], keyOf: (i: BoardItem) => string | null) {
  const exp = new Map<string | null, { n: number; cleared: number; total: number }>();
  for (const i of counted(items)) {
    const k = keyOf(i);
    const e = exp.get(k) ?? { n: 0, cleared: 0, total: 0 };
    e.n++; e.cleared += i.cleared ? 1 : 0; e.total += i.durationMin;
    exp.set(k, e);
  }
  const got = byKey(groups);
  expect([...got.keys()].sort()).toEqual([...exp.keys()].sort());
  for (const [k, e] of exp) {
    expect(got.get(k), String(k)).toMatchObject({ interviews: e.n, cleared: e.cleared, totalDurationMin: e.total });
    expect(got.get(k)!.avgDurationMin).toBeCloseTo(e.total / e.n, 1);
  }
}

const auditRows = async () => (await db.admin.query<{ actor_id: string; changes: Record<string, unknown> }>(
  `SELECT actor_id, changes FROM eureka.audit_event WHERE action = 'report.export' AND entity_type = 'interview' ORDER BY seq`)).rows;

// ---------------------------------------------------------------------------------------------

describe("interview report (grouped)", () => {
  it.each(["r1a", "l1", "m1", "ad", "ceo", "locD", "locA"] as const)("by coach matches %s's interview board", async (key) => {
    const items = await board(key);
    const res = await call(key, "GET", `/api/v1/reports/interviews?${qs({ from: FROM, to: TO, groupBy: "coach" })}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expectGroups(body.groups, items, (i) => i.coach?.id ?? null);
    const c = counted(items);
    expect(body.totals).toMatchObject({ interviews: c.length, cleared: c.filter((i) => i.cleared).length,
      totalDurationMin: c.reduce((n, i) => n + i.durationMin, 0) });
    if (c.some((i) => !i.coach)) expect(byKey(body.groups).get(null)!.label).toBe("Unassigned");
    if (c.some((i) => i.coach)) expect(byKey(body.groups).get(U.coach)!.label).toBe("coach");
  });

  it("the CEO sees every interview except the cancelled one; the cancelled one is not counted", async () => {
    const body = (await call("ceo", "GET", `/api/v1/reports/interviews?${qs({ from: FROM, to: TO })}`)).json();
    expect(body.groupBy).toBe("coach");
    expect(body.totals.interviews).toBe(seed.interviews.length - 1);
    expect(body.totals.completed).toBe(2);
  });

  it("groups by duration bucket in bucket order", async () => {
    const items = await board("ceo");
    const body = (await call("ceo", "GET", `/api/v1/reports/interviews?${qs({ from: FROM, to: TO, groupBy: "duration" })}`)).json();
    expectGroups(body.groups, items, (i) => durationBucket(i.durationMin));
    expect(body.groups.map((g: Group) => g.key)).toEqual(["lt30", "60-89", "90-119", "120plus"]);
    expect(body.groups.map((g: Group) => g.label)).toEqual(["Under 30 min", "60-89 min", "90-119 min", "120 min or more"]);
  });

  it("groups by technology and by candidate", async () => {
    const items = await board("ceo");
    const tech = (await call("ceo", "GET", `/api/v1/reports/interviews?${qs({ from: FROM, to: TO, groupBy: "technology" })}`)).json();
    expect(tech.groups.map((g: Group) => g.label).sort()).toEqual(["Java", "Python"]);
    expect(tech.groups.reduce((n: number, g: Group) => n + g.interviews, 0)).toBe(counted(items).length);
    const cand = (await call("ceo", "GET", `/api/v1/reports/interviews?${qs({ from: FROM, to: TO, groupBy: "candidate" })}`)).json();
    expectGroups(cand.groups, items, (i) => i.candidate.id);
    for (const g of cand.groups as Group[]) expect(g.label).toBe(items.find((i) => i.candidate.id === g.key)!.candidate.name);
  });

  it("is date-filtered on the start time", async () => {
    const items = await board("ceo", DAY_FROM, DAY_TO);
    const body = (await call("ceo", "GET", `/api/v1/reports/interviews?${qs({ from: DAY_FROM, to: DAY_TO })}`)).json();
    expect(body.totals.interviews).toBe(counted(items).length);
    expect(body.totals.interviews).toBeLessThan(seed.interviews.length - 1);
    const none = (await call("ceo", "GET", `/api/v1/reports/interviews?${qs({ from: "2029-01-01", to: "2029-02-01" })}`)).json();
    expect(none).toMatchObject({ totals: { interviews: 0, totalDurationMin: 0, avgDurationMin: null }, groups: [] });
  });

  it("needs report:read (coach 403) and returns nothing without interview:read (HR)", async () => {
    expect((await call("coach", "GET", `/api/v1/reports/interviews?${qs({ from: FROM, to: TO })}`)).statusCode).toBe(403);
    const hr = await call("hr", "GET", `/api/v1/reports/interviews?${qs({ from: FROM, to: TO })}`);
    expect(hr.statusCode).toBe(200);
    expect(hr.json()).toMatchObject({ totals: { interviews: 0 }, groups: [] });
  });

  it.each([
    ["to before from", { from: TO, to: FROM }],
    ["an unknown grouping", { from: FROM, to: TO, groupBy: "client" }],
    ["more than two years", { from: "2026-01-01", to: "2028-06-01" }],
    ["an unknown parameter", { from: FROM, to: TO, recruiterId: U.r1a }],
    ["a missing period", { groupBy: "coach" }],
  ])("refuses %s (422)", async (_n, q) => {
    expect((await call("ceo", "GET", `/api/v1/reports/interviews?${qs(q as Record<string, string>)}`)).statusCode).toBe(422);
  });
});

describe("interview report export", () => {
  it("needs report:export (recruiter 403, location roles 403)", async () => {
    for (const key of ["r1a", "locD", "coach"] as const) {
      expect((await call(key, "POST", "/api/v1/reports/interviews/export", { from: FROM, to: TO })).statusCode, key).toBe(403);
    }
  });

  it("exports the lead's groups as CSV and audits only the facts", async () => {
    const before = (await auditRows()).length;
    const view = (await call("l1", "GET", `/api/v1/reports/interviews?${qs({ from: FROM, to: TO, groupBy: "candidate" })}`)).json();
    const res = await call("l1", "POST", "/api/v1/reports/interviews/export", { from: FROM, to: TO, groupBy: "candidate" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="interviews-by-candidate-2030-01-01.csv"`);
    const lines = res.body.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe("Candidate,Interviews,Cleared,Completed,Total duration (min),Average duration (min)");
    expect(lines.length - 1).toBe(view.groups.length);
    expect(res.headers["x-export-rows"]).toBe(String(view.groups.length));
    const audits = await auditRows();
    expect(audits.length).toBe(before + 1);
    const a = audits[audits.length - 1]!;
    expect(a.actor_id).toBe(U.l1);
    expect(a.changes).toMatchObject({ report: "interviews", groupBy: "candidate", from: FROM, to: TO, rows: view.groups.length, truncated: false });
    // Rule 5: no names in the audit row.
    for (const g of view.groups as Group[]) expect(JSON.stringify(a.changes)).not.toContain(g.label);
  });
});

describe("daily interviews report", () => {
  it("lists one row per visible interview of the day with the latest candidate feedback", async () => {
    const items = await board("ceo", DAY_FROM, DAY_TO);
    const res = await call("ceo", "GET", `/api/v1/reports/interviews/daily?${qs({ from: DAY_FROM, to: DAY_TO })}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(items.map((i) => i.id));
    const first = body.items.find((i: { id: string }) => i.id === seed.interviews[0]!.id);
    expect(first.candidateFeedback).toMatchObject({ rating: 4, notes: NOTES, nextStep: "Second round" });
    expect(first).toMatchObject({ cleared: true, callStatus: "completed", coach: { id: U.coach, name: "coach" }, technology: "Java", client: expect.any(String) });
    expect(body.totals).toMatchObject({ withCandidateFeedback: 1, interviews: counted(items).length });
    // The cancelled interview is listed (with its status) but not counted.
    if (items.some((i) => i.id === seed.interviews[5]!.id)) {
      expect(body.items.find((i: { id: string }) => i.id === seed.interviews[5]!.id).callStatus).toBe("cancelled");
    }
  });

  it("is scoped like the board: a recruiter of another team does not see the feedback row", async () => {
    const owner = seed.interviews[0]!;
    const others = (["r1a", "r2a", "r3a"] as const).filter((k) => U[k] !== owner.recruiterId && U[k] !== owner.candidate.recruiterId);
    for (const key of others) {
      const ids = (await board(key, DAY_FROM, DAY_TO)).map((i) => i.id);
      const body = (await call(key, "GET", `/api/v1/reports/interviews/daily?${qs({ from: DAY_FROM, to: DAY_TO })}`)).json();
      expect(body.items.map((i: { id: string }) => i.id)).toEqual(ids);
      expect(ids).not.toContain(owner.id);
    }
  });

  it("covers at most one day and needs report:read", async () => {
    expect((await call("ceo", "GET", `/api/v1/reports/interviews/daily?${qs({ from: DAY_FROM, to: "2030-01-09T00:00:00Z" })}`)).statusCode).toBe(422);
    expect((await call("coach", "GET", `/api/v1/reports/interviews/daily?${qs({ from: DAY_FROM, to: DAY_TO })}`)).statusCode).toBe(403);
  });

  it("exports the day as CSV with the candidate feedback; the audit row has no feedback text", async () => {
    expect((await call("r1a", "POST", "/api/v1/reports/interviews/daily/export", { from: DAY_FROM, to: DAY_TO })).statusCode).toBe(403);
    const res = await call("ceo", "POST", "/api/v1/reports/interviews/daily/export", { from: DAY_FROM, to: DAY_TO });
    expect(res.statusCode, res.body).toBe(200);
    const lines = res.body.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toMatch(/^Start,End,Duration \(min\),Candidate,.*Candidate rating,Candidate feedback,Candidate next step$/);
    expect(lines.length - 1).toBe((await board("ceo", DAY_FROM, DAY_TO)).length);
    expect(res.body).toContain(NOTES);
    const a = (await auditRows()).at(-1)!;
    expect(a.changes).toMatchObject({ report: "interviews_daily", from: DAY_FROM, to: DAY_TO, rows: lines.length - 1 });
    expect(JSON.stringify(a.changes)).not.toContain("Kafka");
  });
});

describe("interview board candidate feedback column", () => {
  it("returns the latest candidate feedback on board rows and null elsewhere", async () => {
    const items = await board("ceo", DAY_FROM, DAY_TO);
    const first = items.find((i) => i.id === seed.interviews[0]!.id)!;
    expect(first.candidateFeedback).toMatchObject({ rating: 4, notes: NOTES });
    expect(items.filter((i) => i.candidateFeedback !== null)).toHaveLength(1);
    const one = (await call("ceo", "GET", `/api/v1/interviews/${seed.interviews[0]!.id}`)).json();
    expect(one.candidateFeedback).toMatchObject({ rating: 4 });
  });
});

describe("interview coach check (migration 0130)", () => {
  const sql = (userId: string, text: string, params: unknown[]) =>
    asUser(db.app, userId, (c) => c.query(text, params)).then(() => "ok", (e: Error) => e.message);
  const r1aInterview = () => seed.interviews.find((i) => i.recruiterId === U.r1a)!;

  it("the database accepts an interview coach and refuses anyone else", async () => {
    const id = r1aInterview().id;
    expect(await sql(U.r1a, `UPDATE eureka.interview SET coach_id = $2 WHERE id = $1`, [id, U.coach])).toBe("ok");
    expect(await sql(U.r1a, `UPDATE eureka.interview SET coach_id = $2 WHERE id = $1`, [id, U.l1])).toBe("invalid_coach");
    expect(await sql(U.r1a, `UPDATE eureka.interview SET coach_id = NULL WHERE id = $1`, [id])).toBe("ok");
    expect(await sql(U.r1a,
      `INSERT INTO eureka.interview (submission_id, round, starts_at, ends_at, coach_id) VALUES ($1, 'L2', '2031-05-05T10:00:00Z', '2031-05-05T11:00:00Z', $2)`,
      [r1aInterview().submissionId, U.r1b])).toBe("invalid_coach");
  });

  it("the API answers 422 invalid_coach and keeps a coach who later lost the role", async () => {
    const id = r1aInterview().id;
    const bad = await call("r1a", "PATCH", `/api/v1/interviews/${id}`, { coachId: U.l1 });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().detail).toBe("invalid_coach");
    expect((await call("r1a", "PATCH", `/api/v1/interviews/${id}`, { coachId: U.coach })).statusCode).toBe(200);
    // The coach loses the role: the interview keeps them and other fields still change.
    await db.admin.query(`UPDATE eureka.user_role SET valid = tstzrange(lower(valid), now()) WHERE user_id = $1 AND role_key = 'interview_coach'`, [U.coach]);
    try {
      expect(await sql(U.r1a, `UPDATE eureka.interview SET round = 'L1b' WHERE id = $1`, [id])).toBe("ok");
      expect(await sql(U.r1a, `UPDATE eureka.interview SET coach_id = NULL WHERE id = $1`, [id])).toBe("ok");
      // Re-setting the same coach is no change; setting them again after removal is refused.
      expect(await sql(U.r1a, `UPDATE eureka.interview SET coach_id = $2 WHERE id = $1`, [id, U.coach])).toBe("ok");
      expect(await asUser(db.app, U.r1a, async (c) => {
        await c.query(`UPDATE eureka.interview SET coach_id = NULL WHERE id = $1`, [id]);
        await c.query(`UPDATE eureka.interview SET coach_id = $2 WHERE id = $1`, [id, U.coach]);
      }).then(() => "ok", (e: Error) => e.message)).toBe("invalid_coach");
    } finally {
      await db.admin.query(`INSERT INTO eureka.user_role (user_id, role_key) VALUES ($1, 'interview_coach')`, [U.coach]);
    }
  });
});
